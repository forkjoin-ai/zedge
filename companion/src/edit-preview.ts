import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

export interface EditPosition {
  line: number;
  character: number;
}

export interface EditRange {
  start: EditPosition;
  end: EditPosition;
}

export interface EditPreview {
  previewId: string;
  filePath: string;
  absolutePath: string;
  range: EditRange;
  oldHash: string;
  newHash: string;
  diff: string;
  replacementText: string;
  createdAt: number;
  expiresAt: number;
  applied: boolean;
}

const DEFAULT_PREVIEW_TTL_MS = 10 * 60_000;
const previews = new Map<string, EditPreview>();

function workspaceRoot(): string {
  return process.env.AEON_ROOT || process.cwd();
}

function previewTtlMs(): number {
  const parsed = Number.parseInt(process.env.ZEDGE_EDIT_PREVIEW_TTL_MS ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_PREVIEW_TTL_MS;
}

function cleanupExpiredPreviews(now: number): void {
  for (const [previewId, preview] of previews) {
    if (now > preview.expiresAt) {
      previews.delete(previewId);
    }
  }
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function resolveWorkspacePath(filePath: string): string {
  const root = resolve(workspaceRoot());
  const absolutePath = resolve(root, filePath);
  const relativePath = relative(root, absolutePath);
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
    throw new Error(`Path escapes workspace root: ${filePath}`);
  }
  return absolutePath;
}

function offsetAt(content: string, position: EditPosition): number {
  if (
    !Number.isInteger(position.line) ||
    !Number.isInteger(position.character) ||
    position.line < 0 ||
    position.character < 0
  ) {
    throw new Error('range positions must be non-negative integers');
  }

  const lines = content.split('\n');
  if (position.line >= lines.length) {
    throw new Error(`line ${position.line} is outside the file`);
  }

  let offset = 0;
  for (let line = 0; line < position.line; line++) {
    offset += lines[line]!.length + 1;
  }

  const lineText = lines[position.line]!;
  if (position.character > lineText.length) {
    throw new Error(
      `character ${position.character} is outside line ${position.line}`,
    );
  }
  return offset + position.character;
}

function replaceRange(content: string, range: EditRange, replacementText: string): string {
  const start = offsetAt(content, range.start);
  const end = offsetAt(content, range.end);
  if (end < start) {
    throw new Error('range end must be after range start');
  }
  return `${content.slice(0, start)}${replacementText}${content.slice(end)}`;
}

function findSearchRange(content: string, search: string): EditRange {
  const index = content.indexOf(search);
  if (index < 0) {
    throw new Error('search string not found');
  }
  const prefix = content.slice(0, index);
  const selected = content.slice(index, index + search.length);
  const startLines = prefix.split('\n');
  const selectedLines = selected.split('\n');
  const startLine = startLines.length - 1;
  const startCharacter = startLines[startLines.length - 1]!.length;
  const endLine = startLine + selectedLines.length - 1;
  const endCharacter =
    selectedLines.length === 1
      ? startCharacter + selected.length
      : selectedLines[selectedLines.length - 1]!.length;
  return {
    start: { line: startLine, character: startCharacter },
    end: { line: endLine, character: endCharacter },
  };
}

function simpleDiff(filePath: string, before: string, after: string): string {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  const max = Math.max(beforeLines.length, afterLines.length);
  const lines = [`--- a/${filePath}`, `+++ b/${filePath}`];
  for (let i = 0; i < max; i++) {
    const oldLine = beforeLines[i];
    const newLine = afterLines[i];
    if (oldLine === newLine) continue;
    if (oldLine !== undefined) lines.push(`-${oldLine}`);
    if (newLine !== undefined) lines.push(`+${newLine}`);
  }
  return lines.join('\n');
}

function storePreview(preview: EditPreview): EditPreview {
  cleanupExpiredPreviews(Date.now());
  previews.set(preview.previewId, preview);
  return preview;
}

export function createRangeEditPreview(input: {
  filePath: string;
  range: EditRange;
  replacementText: string;
}): EditPreview {
  const absolutePath = resolveWorkspacePath(input.filePath);
  if (!existsSync(absolutePath)) {
    throw new Error(`file not found: ${input.filePath}`);
  }
  const before = readFileSync(absolutePath, 'utf-8');
  const after = replaceRange(before, input.range, input.replacementText);
  const now = Date.now();
  const ttlMs = previewTtlMs();
  return storePreview({
    previewId: `edit-${now}-${Math.random().toString(36).slice(2, 10)}`,
    filePath: input.filePath,
    absolutePath,
    range: input.range,
    oldHash: sha256(before),
    newHash: sha256(after),
    diff: simpleDiff(input.filePath, before, after),
    replacementText: input.replacementText,
    createdAt: now,
    expiresAt: now + ttlMs,
    applied: false,
  });
}

export function createSearchReplacePreview(input: {
  filePath: string;
  search: string;
  replacementText: string;
}): EditPreview {
  const absolutePath = resolveWorkspacePath(input.filePath);
  if (!existsSync(absolutePath)) {
    throw new Error(`file not found: ${input.filePath}`);
  }
  const before = readFileSync(absolutePath, 'utf-8');
  const range = findSearchRange(before, input.search);
  return createRangeEditPreview({
    filePath: input.filePath,
    range,
    replacementText: input.replacementText,
  });
}

export function applyEditPreview(previewId: string): EditPreview {
  const preview = previews.get(previewId);
  if (!preview) {
    throw new Error(`Unknown previewId: ${previewId}`);
  }
  if (preview.applied) {
    throw new Error(`Preview already applied: ${previewId}`);
  }
  if (Date.now() > preview.expiresAt) {
    previews.delete(previewId);
    throw new Error(`Preview expired: ${previewId}`);
  }

  const before = readFileSync(preview.absolutePath, 'utf-8');
  if (sha256(before) !== preview.oldHash) {
    throw new Error(`File changed since preview was created: ${preview.filePath}`);
  }
  const after = replaceRange(before, preview.range, preview.replacementText);
  writeFileSync(preview.absolutePath, after, 'utf-8');
  preview.applied = true;
  return preview;
}
