import { describe, test, expect } from '@a0n/gnosis/test';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { analyzeFileContent } from '@a0n/polyglot-scanner-core/analyzer';
import { planModuleSplit } from '@a0n/polyglot-scanner-core/structural-refactor';
import {
  applyStructuralCandidate,
  previewStructuralCandidate,
  rejectStructuralCandidate,
  structuralDaydreamForFile,
  structuralMetricsSummary,
  undoStructuralApply,
  witnessStructuralCandidate,
} from '../structural-daydream';

const shortFixture = [
  'fn alpha_one() -> u8 { 1 }',
  'fn alpha_two() -> u8 { alpha_one() }',
  '',
  'fn beta_one() -> u8 { 2 }',
  'fn beta_two() -> u8 { beta_one() }',
  '',
].join('\n');

function longFixture(): string {
  const rows = ['fn long_one() -> u64 {'];
  for (let i = 0; i < 60; i++) rows.push('    let _ = ' + i + 'u64;');
  rows.push('    0', '}');
  return rows.join('\n');
}

function constFixture(): string {
  const rows = ['fn table() -> u64 {'];
  rows.push('    const TABLE: &[&str] = &[');
  for (let i = 0; i < 10; i++) rows.push('        "row' + i + '",');
  rows.push('    ];');
  for (let i = 0; i < 47; i++) rows.push('    let _ = ' + i + 'u64;');
  rows.push('    0', '}');
  return rows.join('\n');
}

function extractionCandidate(file: string, source: string) {
  const finding = analyzeFileContent(source, file).find(
    (candidate) => candidate.rule === 'FUNCTION_TOO_LONG'
  );
  const daydream = structuralDaydreamForFile(file, {
    targetFinding: {
      file,
      line: finding?.line ?? 0,
      rule: finding?.rule ?? 'FUNCTION_TOO_LONG',
      ...(finding?.patternHash === undefined
        ? {}
        : { patternHash: finding.patternHash }),
    },
    minFunctionLines: 50,
    maxCandidates: 6,
  });
  return daydream.candidates.find(
    (candidate) => candidate.preview?.kind === 'function-extraction'
  );
}

describe('structural daydream', () => {
  test('emits gutter diagnostics with the argument and gate attached', () => {
    const directory = mkdtempSync(join(tmpdir(), 'zedge-structural-'));
    const file = join(directory, 'fixture.rs');
    writeFileSync(file, shortFixture, 'utf8');
    try {
      const daydream = structuralDaydreamForFile(file, {
        targetModuleLines: 1,
        maxCandidates: 4,
      });
      expect(daydream.candidates.length).toBeGreaterThan(0);
      expect(daydream.diagnostics.length).toBe(daydream.candidates.length);
      const first = daydream.candidates[0];
      expect(first?.category).toBe('refactor');
      expect(first?.gate.kind).toBe('finding-resolution');
      expect(first?.argument.obligations.length).toBeGreaterThan(0);
      const diagnostic = daydream.diagnostics[0];
      expect(diagnostic?.severity).toBe(4);
      expect(diagnostic?.source).toBe('structural-daydream');
      expect(diagnostic?.data.argument.claim.length).toBeGreaterThan(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('preview is single-use, hash-bound, and undo restores the source', () => {
    const directory = mkdtempSync(join(tmpdir(), 'zedge-structural-token-'));
    const file = join(directory, 'long.rs');
    const source = longFixture();
    writeFileSync(file, source, 'utf8');
    try {
      const candidate = extractionCandidate(file, source);
      expect(candidate).toBeDefined();
      const id = candidate?.id ?? '';
      const witness = witnessStructuralCandidate(id);
      expect(witness?.admissible).toBe(true);
      const preview = previewStructuralCandidate(id);
      expect(preview).not.toBeNull();
      expect(preview?.token.length).toBeGreaterThan(0);
      const applied = applyStructuralCandidate(id, preview?.token);
      expect(applied?.applied).toBe(true);
      expect(applied?.undoToken).toBeDefined();
      const replay = applyStructuralCandidate(id, preview?.token);
      expect(replay?.applied).toBe(false);
      expect(replay?.reason).toContain('already used');
      const undone = undoStructuralApply(applied?.undoToken ?? '');
      expect(undone.undone).toBe(true);
      expect(readFileSync(file, 'utf8')).toBe(source);
      const summary = structuralMetricsSummary();
      expect(summary.candidates).toBeGreaterThan(0);
      expect(summary.witnessed).toBeGreaterThan(0);
      expect(summary.accepted).toBeGreaterThan(0);
      expect(summary.medianTimeToWitnessMs).not.toBeNull();
      expect(rejectStructuralCandidate(id)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('a const hoist candidate is admitted and applied through the same token path', () => {
    const directory = mkdtempSync(join(tmpdir(), 'zedge-structural-const-'));
    const file = join(directory, 'const.rs');
    const source = constFixture();
    writeFileSync(file, source, 'utf8');
    try {
      const finding = analyzeFileContent(source, file).find(
        (candidate) => candidate.rule === 'FUNCTION_TOO_LONG'
      );
      expect(finding).toBeDefined();
      const daydream = structuralDaydreamForFile(file, {
        targetFinding: {
          file,
          line: finding?.line ?? 0,
          rule: finding?.rule ?? 'FUNCTION_TOO_LONG',
          ...(finding?.patternHash === undefined
            ? {}
            : { patternHash: finding.patternHash }),
        },
        maxCandidates: 8,
      });
      const candidate = daydream.candidates.find(
        (entry) => entry.preview?.kind === 'const-hoist'
      );
      expect(candidate).toBeDefined();
      const id = candidate?.id ?? '';
      const witness = witnessStructuralCandidate(id);
      expect(witness?.admissible).toBe(true);
      expect(witness?.verdict).toBe('resolved');
      const preview = previewStructuralCandidate(id);
      expect(preview).not.toBeNull();
      const applied = applyStructuralCandidate(id, preview?.token);
      expect(applied?.applied).toBe(true);
      const undone = undoStructuralApply(applied?.undoToken ?? '');
      expect(undone.undone).toBe(true);
      expect(readFileSync(file, 'utf8')).toBe(source);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('a module split is admitted by the structural witness and undone', () => {
    const directory = mkdtempSync(join(tmpdir(), 'zedge-structural-module-'));
    const file = join(directory, 'mod.rs');
    const source = [
      'fn alpha() -> u8 { 1 }',
      'fn beta() -> u8 { alpha() }',
      'fn gamma() -> u8 { 2 }',
      '',
    ].join('\n');
    writeFileSync(file, source, 'utf8');
    const attestation = join(directory, 'attestation.json');
    const previousAttestation = process.env.ZEDGE_STRUCTURAL_ATTESTATION;
    try {
      const daydream = structuralDaydreamForFile(file, {
        targetModuleLines: 1,
        maxCandidates: 12,
      });
      const hash = (value: string): string =>
        createHash('sha256').update(value).digest('hex');
      const files: Array<{ path: string; sha256: string }> = [];
      for (const candidate of daydream.candidates) {
        if (
          candidate.preview?.kind !== 'module-split' ||
          candidate.preview.moduleIndex === undefined
        ) {
          continue;
        }
        const plan = planModuleSplit(source, file, candidate.preview.moduleIndex, {
          targetModuleLines: 1,
        });
        if (plan === null) continue;
        files.push({ path: file, sha256: hash(plan.parentSource) });
        files.push({
          path: join(directory, plan.newFilePath),
          sha256: hash(plan.newSource),
        });
      }
      writeFileSync(
        attestation,
        JSON.stringify({
          schema: 'a0n.structural-attestation.v1',
          files,
          compile: true,
          tests: true,
          command: 'test fixture',
        }),
        'utf8'
      );
      process.env.ZEDGE_STRUCTURAL_ATTESTATION = attestation;
      let applied = false;
      for (const candidate of daydream.candidates) {
        if (candidate.preview?.kind !== 'module-split') continue;
        const witness = witnessStructuralCandidate(candidate.id);
        if (!witness?.admissible) continue;
        const preview = previewStructuralCandidate(candidate.id);
        const result = applyStructuralCandidate(candidate.id, preview?.token);
        if (!result?.applied) continue;
        applied = true;
        const undone = undoStructuralApply(result.undoToken ?? '');
        expect(undone.undone).toBe(true);
        expect(readFileSync(file, 'utf8')).toBe(source);
        break;
      }
      expect(applied).toBe(true);
    } finally {
      if (previousAttestation === undefined) {
        delete process.env.ZEDGE_STRUCTURAL_ATTESTATION;
      } else {
        process.env.ZEDGE_STRUCTURAL_ATTESTATION = previousAttestation;
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('a preview is refused after the source changes', () => {
    const directory = mkdtempSync(join(tmpdir(), 'zedge-structural-stale-'));
    const file = join(directory, 'long.rs');
    const source = longFixture();
    writeFileSync(file, source, 'utf8');
    try {
      const candidate = extractionCandidate(file, source);
      const id = candidate?.id ?? '';
      const preview = previewStructuralCandidate(id);
      expect(preview).not.toBeNull();
      writeFileSync(file, source + '\n', 'utf8');
      const applied = applyStructuralCandidate(id, preview?.token);
      expect(applied?.applied).toBe(false);
      expect(applied?.reason).toContain('stale preview');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('a candidate without a target is retracted and cannot preview', () => {
    const directory = mkdtempSync(join(tmpdir(), 'zedge-structural-notarget-'));
    const file = join(directory, 'fixture.rs');
    writeFileSync(file, longFixture(), 'utf8');
    try {
      const daydream = structuralDaydreamForFile(file, { maxCandidates: 8 });
      const candidate = daydream.candidates.find(
        (entry) => entry.preview !== null && entry.preview.kind !== 'module-split'
      );
      expect(candidate).toBeDefined();
      const witness = witnessStructuralCandidate(candidate?.id ?? '');
      expect(witness?.admissible).toBe(false);
      expect(witness?.verdict).toBe('no-target');
      expect(previewStructuralCandidate(candidate?.id ?? '')).toBeNull();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
