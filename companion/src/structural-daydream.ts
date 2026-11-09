/**
 * Deterministic structural daydream for the zedge companion.
 *
 * I5: apply is token-bound. A preview mints a single-use token that binds the
 * candidate, the source hash, the witness hash and the exact prepared bytes.
 * Apply consumes the token once; undo restores the prepared before-bytes and
 * deletes a file the split created. A witness that fails is retracted, not
 * silently offered.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { broadcastRetracted } from './daydream-annotations.ts';
import {
  buildZedgeStructuralDaydream,
  type ZedgeStructuralDaydream,
} from '@a0n/polyglot-scanner-core/zedge-daydream';
import {
  planConstHoist,
  planFunctionExtraction,
  planModuleSplit,
  planStructuralRefactor,
  scanRustItems,
  type FindingRef,
  type RelocationScope,
} from '@a0n/polyglot-scanner-core/structural-refactor';
import {
  buildModuleSplitWitness,
  buildStructuralWitness,
  type StructuralWitness,
} from '@a0n/polyglot-scanner-core/structural-witness';
import {
  StructuralMetricsStore,
  StructuralPolicy,
} from '@a0n/polyglot-scanner-core/structural-metrics';

export interface StructuralDaydreamOptions {
  readonly targetModuleLines?: number;
  readonly maxCandidates?: number;
  readonly targetFinding?: FindingRef;
  readonly minFunctionLines?: number;
}

interface StructuralRecord {
  readonly id: string;
  readonly filePath: string;
  readonly kind: 'module-split' | 'function-extraction' | 'const-hoist';
  readonly moduleIndex?: number;
  readonly targetModuleLines?: number;
  readonly functionName?: string;
  readonly target: FindingRef | null;
}

interface Rewrite {
  readonly after: ReadonlyArray<{
    readonly path: string;
    readonly content: string;
    readonly created: boolean;
  }>;
  readonly relocation?: RelocationScope;
}

interface PreparedFile {
  readonly path: string;
  readonly beforeContent: string;
  readonly afterContent: string;
  readonly beforeSha256: string;
  readonly afterSha256: string;
  readonly created: boolean;
}

interface ApplyToken {
  readonly id: string;
  readonly candidateId: string;
  readonly sourceSha256: string;
  readonly witnessSha256: string;
  readonly files: readonly PreparedFile[];
  readonly createdAt: number;
  readonly expiresAt: number;
  used: boolean;
}

interface UndoToken {
  readonly id: string;
  readonly files: readonly PreparedFile[];
  used: boolean;
}

const TOKEN_TTL_MS = 5 * 60_000;
const records = new Map<string, StructuralRecord>();
const witnesses = new Map<string, StructuralWitness>();
const applyTokens = new Map<string, ApplyToken>();
const undoTokens = new Map<string, UndoToken>();
const retracted = new Map<string, string>();
const metricsPath = process.env.ZEDGE_STRUCTURAL_METRICS;
const metrics = new StructuralMetricsStore(
  metricsPath === undefined ? {} : { path: metricsPath }
);
const policy = new StructuralPolicy(metrics);

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function witnessDigest(witness: StructuralWitness): string {
  return sha256(JSON.stringify(witness));
}

export interface StructuralPreview {
  readonly token: string;
  readonly candidateId: string;
  readonly witness: StructuralWitness;
  readonly sourceSha256: string;
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly beforeSha256: string;
    readonly afterSha256: string;
    readonly created: boolean;
  }>;
  readonly expiresAt: number;
}

export interface StructuralApplyResult {
  readonly applied: boolean;
  readonly kind: StructuralRecord['kind'];
  readonly files: readonly string[];
  readonly token?: string;
  readonly undoToken?: string;
  readonly reason?: string;
}

export interface StructuralUndoResult {
  readonly undone: boolean;
  readonly files: readonly string[];
  readonly reason?: string;
}

export function setStructuralWitness(
  id: string,
  witness: StructuralWitness
): boolean {
  if (!records.has(id)) return false;
  witnesses.set(id, witness);
  return true;
}

export function retractStructuralCandidate(id: string, reason: string): boolean {
  if (!records.has(id) && !witnesses.has(id)) return false;
  retracted.set(id, reason);
  broadcastRetracted(id, reason);
  applyTokens.forEach((token, tokenId) => {
    if (token.candidateId === id) applyTokens.delete(tokenId);
  });
  return true;
}

function computeRewrite(record: StructuralRecord): Rewrite | null {
  const source = readFileSync(record.filePath, 'utf8');
  if (record.kind === 'module-split') {
    if (record.moduleIndex === undefined) return null;
    const plan = planModuleSplit(source, record.filePath, record.moduleIndex, {
      targetModuleLines: record.targetModuleLines ?? 8000,
    });
    if (plan === null) return null;
    const childPath = join(dirname(record.filePath), plan.newFilePath);
    const relocation =
      record.target === null
        ? undefined
        : {
            rule: record.target.rule,
            path: childPath,
            startLine: 1,
            endLine: Number.MAX_SAFE_INTEGER,
          };
    return {
      after: [
        { path: record.filePath, content: plan.parentSource, created: false },
        { path: childPath, content: plan.newSource, created: true },
      ],
      ...(relocation === undefined ? {} : { relocation }),
    };
  }
  if (record.kind === 'const-hoist') {
    if (record.functionName === undefined) return null;
    const plan = planConstHoist(source, record.filePath, record.functionName);
    if (plan === null) return null;
    return {
      after: [{ path: record.filePath, content: plan.transformed, created: false }],
    };
  }
  if (record.functionName === undefined) return null;
  const plan = planFunctionExtraction(source, record.filePath, record.functionName);
  if (plan === null) return null;
  const helper = scanRustItems(plan.transformed).find(
    (item) => item.kind === 'fn' && item.name === plan.helperName
  );
  const relocation =
    record.target !== null && helper !== undefined
      ? {
          rule: record.target.rule,
          path: record.filePath,
          startLine: helper.startLine,
          endLine: helper.endLine,
        }
      : undefined;
  return {
    after: [{ path: record.filePath, content: plan.transformed, created: false }],
    ...(relocation === undefined ? {} : { relocation }),
  };
}

/** Build the witness receipt for a cached candidate. */
function moduleAttestation(
  after: readonly { readonly path: string; readonly content: string }[]
): {
  compile?: { verified: boolean; command?: string };
  tests?: { verified: boolean; command?: string };
} {
  const path = process.env.ZEDGE_STRUCTURAL_ATTESTATION;
  if (path === undefined) return {};
  try {
    const data = JSON.parse(readFileSync(path, 'utf8')) as {
      files?: Array<{ path?: string; sha256?: string }>;
      compile?: boolean;
      tests?: boolean;
      command?: string;
    };
    const files = data.files ?? [];
    const matches = after.every((file) =>
      files.some((entry) => entry.sha256 === sha256(file.content))
    );
    if (!matches) return {};
    const command = data.command === undefined ? {} : { command: data.command };
    return {
      compile: { verified: data.compile === true, ...command },
      tests: { verified: data.tests === true, ...command },
    };
  } catch {
    return {};
  }
}

export function witnessStructuralCandidate(id: string): StructuralWitness | null {
  const record = records.get(id);
  if (!record) return null;
  const rewrite = computeRewrite(record);
  if (rewrite === null) return null;
  const source = readFileSync(record.filePath, 'utf8');
  const startedAt = Date.now();
  let witness: StructuralWitness | null;
  if (record.kind === 'module-split') {
    const structural = planStructuralRefactor(source, record.filePath, {
      targetModuleLines: record.targetModuleLines ?? 8000,
    });
    const module = structural.modules[record.moduleIndex ?? 0];
    witness =
      module === undefined
        ? null
        : buildModuleSplitWitness({
            before: { path: record.filePath, source },
            after: rewrite.after.map((file) => ({
              path: file.path,
              source: file.content,
            })),
            module: {
              name: module.id,
              itemCount: module.items.length,
              cohesion: module.cohesion,
              externalEdges: module.externalEdges,
            },
            ...moduleAttestation(rewrite.after),
          });
  } else {
    witness = buildStructuralWitness({
      before: { path: record.filePath, source },
      after: rewrite.after.map((file) => ({ path: file.path, source: file.content })),
      ...(record.target === null ? {} : { target: record.target }),
      ...(rewrite.relocation === undefined ? {} : { relocation: rewrite.relocation }),
    });
  }
  if (witness === null) return null;
  setStructuralWitness(id, witness);
  metrics.recordWitness(id, witness, Date.now() - startedAt);
  if (!witness.admissible) {
    retracted.set(id, witness.reason);
    broadcastRetracted(id, witness.reason);
  }
  return witness;
}

function prepare(id: string): {
  record: StructuralRecord;
  witness: StructuralWitness;
  sourceSha256: string;
  files: readonly PreparedFile[];
} | null {
  const record = records.get(id);
  if (!record) return null;
  const witness = witnesses.get(id) ?? witnessStructuralCandidate(id);
  if (witness === null || !witness.admissible) return null;
  const rewrite = computeRewrite(record);
  if (rewrite === null) return null;
  const source = readFileSync(record.filePath, 'utf8');
  const sourceSha256 = sha256(source);
  if (witness.before.sha256 !== sourceSha256) return null;
  const files: PreparedFile[] = rewrite.after.map((file) => ({
    path: file.path,
    beforeContent: file.created ? '' : source,
    afterContent: file.content,
    beforeSha256: file.created ? sha256('') : sourceSha256,
    afterSha256: sha256(file.content),
    created: file.created,
  }));
  return { record, witness, sourceSha256, files };
}

/** Mint a single-use, hash-bound preview token. */
export function previewStructuralCandidate(id: string): StructuralPreview | null {
  const prepared = prepare(id);
  if (prepared === null) return null;
  const now = Date.now();
  const token: ApplyToken = {
    id: randomUUID(),
    candidateId: id,
    sourceSha256: prepared.sourceSha256,
    witnessSha256: witnessDigest(prepared.witness),
    files: prepared.files,
    createdAt: now,
    expiresAt: now + TOKEN_TTL_MS,
    used: false,
  };
  applyTokens.set(token.id, token);
  return {
    token: token.id,
    candidateId: id,
    witness: prepared.witness,
    sourceSha256: token.sourceSha256,
    files: token.files.map((file) => ({
      path: file.path,
      beforeSha256: file.beforeSha256,
      afterSha256: file.afterSha256,
      created: file.created,
    })),
    expiresAt: token.expiresAt,
  };
}

/** Apply a prepared token exactly once. */
export function applyStructuralCandidate(
  id: string,
  tokenId?: string
): StructuralApplyResult | null {
  const record = records.get(id);
  if (!record) return null;
  const refusal = retracted.get(id);
  if (refusal !== undefined) {
    return {
      applied: false,
      kind: record.kind,
      files: [],
      reason: 'candidate retracted: ' + refusal,
    };
  }
  if (tokenId === undefined) {
    return {
      applied: false,
      kind: record.kind,
      files: [],
      reason: 'apply requires a preview token; mint one before writing',
    };
  }
  const token = applyTokens.get(tokenId);
  if (!token || token.candidateId !== id) {
    return { applied: false, kind: record.kind, files: [], reason: 'unknown preview token' };
  }
  if (token.used) {
    return { applied: false, kind: record.kind, files: [], reason: 'preview token already used' };
  }
  if (Date.now() > token.expiresAt) {
    applyTokens.delete(tokenId);
    return { applied: false, kind: record.kind, files: [], reason: 'preview token expired' };
  }
  const source = readFileSync(record.filePath, 'utf8');
  if (sha256(source) !== token.sourceSha256) {
    return {
      applied: false,
      kind: record.kind,
      files: [],
      reason: 'stale preview: source sha256 changed since the token was minted',
    };
  }
  const witness = witnesses.get(id);
  if (!witness || witnessDigest(witness) !== token.witnessSha256) {
    return {
      applied: false,
      kind: record.kind,
      files: [],
      reason: 'stale preview: witness changed since the token was minted',
    };
  }
  for (const file of token.files) {
    if (file.created) {
      if (existsSync(file.path)) {
        return {
          applied: false,
          kind: record.kind,
          files: [],
          reason: 'target already exists: ' + file.path,
        };
      }
      continue;
    }
    if (!existsSync(file.path)) {
      return {
        applied: false,
        kind: record.kind,
        files: [],
        reason: 'source disappeared: ' + file.path,
      };
    }
    if (sha256(readFileSync(file.path, 'utf8')) !== file.beforeSha256) {
      return {
        applied: false,
        kind: record.kind,
        files: [],
        reason: 'stale preview: ' + file.path + ' changed since the token was minted',
      };
    }
  }
  token.used = true;
  const undo: UndoToken = {
    id: randomUUID(),
    files: token.files,
    used: false,
  };
  for (const file of token.files) {
    mkdirSync(dirname(file.path), { recursive: true });
    writeFileSync(file.path, file.afterContent);
  }
  undoTokens.set(undo.id, undo);
  metrics.recordAccept(id);
  return {
    applied: true,
    kind: record.kind,
    files: token.files.map((file) => file.path),
    token: token.id,
    undoToken: undo.id,
  };
}

/** Restore the exact before-bytes and delete any file the rewrite created. */
export function undoStructuralApply(undoTokenId: string): StructuralUndoResult {
  const token = undoTokens.get(undoTokenId);
  if (!token) return { undone: false, files: [], reason: 'unknown undo token' };
  if (token.used) return { undone: false, files: [], reason: 'undo token already used' };
  token.used = true;
  for (const file of token.files) {
    if (file.created) {
      if (existsSync(file.path)) unlinkSync(file.path);
      continue;
    }
    writeFileSync(file.path, file.beforeContent);
  }
  return { undone: true, files: token.files.map((file) => file.path) };
}

export function structuralDaydreamForFile(
  filePath: string,
  options: StructuralDaydreamOptions = {}
): ZedgeStructuralDaydream {
  retracted.clear();
  const source = readFileSync(resolve(filePath), 'utf8');
  const daydream = buildZedgeStructuralDaydream(source, filePath, {
    ...(options.targetModuleLines === undefined
      ? {}
      : { targetModuleLines: options.targetModuleLines }),
    ...(options.maxCandidates === undefined
      ? {}
      : { maxCandidates: options.maxCandidates }),
    ...(options.targetFinding === undefined
      ? {}
      : { targetFinding: options.targetFinding }),
    ...(options.minFunctionLines === undefined
      ? {}
      : { minFunctionLines: options.minFunctionLines }),
  });
  for (const candidate of daydream.candidates) {
    const preview = candidate.preview;
    metrics.recordCandidate({
      candidateId: candidate.id,
      filePath,
      kind: preview?.kind ?? 'unknown',
    });
    if (
      preview?.kind === 'module-split' &&
      preview.moduleIndex !== undefined &&
      preview.newFilePath !== undefined
    ) {
      records.set(candidate.id, {
        id: candidate.id,
        filePath,
        kind: 'module-split',
        moduleIndex: preview.moduleIndex,
        targetModuleLines: options.targetModuleLines ?? 8000,
        target: options.targetFinding ?? null,
      });
    } else if (
      preview?.kind === 'function-extraction' &&
      preview.functionName !== undefined
    ) {
      records.set(candidate.id, {
        id: candidate.id,
        filePath,
        kind: 'function-extraction',
        functionName: preview.functionName,
        target: options.targetFinding ?? null,
      });
    } else if (
      preview?.kind === 'const-hoist' &&
      preview.functionName !== undefined
    ) {
      records.set(candidate.id, {
        id: candidate.id,
        filePath,
        kind: 'const-hoist',
        functionName: preview.functionName,
        target: options.targetFinding ?? null,
      });
    }
  }
  const ranked = policy.rank(daydream.candidates);
  const order = new Map(ranked.map((candidate, index) => [candidate.id, index]));
  const diagnostics = daydream.diagnostics
    .slice()
    .sort((left, right) => (order.get(left.code) ?? 0) - (order.get(right.code) ?? 0));
  return { ...daydream, candidates: ranked, diagnostics };
}

/** Drop a structural candidate from the accept cache. */
export function rejectStructuralCandidate(id: string): boolean {
  witnesses.delete(id);
  retracted.delete(id);
  metrics.recordReject(id);
  return records.delete(id);
}

export function structuralMetricsSummary() {
  return metrics.summary();
}

export function structuralMetricsRecords() {
  return metrics.records();
}
