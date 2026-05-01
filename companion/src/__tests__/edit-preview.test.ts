import { afterEach, describe, expect, test } from '@a0n/gnosis/test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyEditPreview,
  createRangeEditPreview,
  createSearchReplacePreview,
} from '../edit-preview.ts';

describe('edit preview registry', () => {
  const originalAeonRoot = process.env.AEON_ROOT;
  const originalTtl = process.env.ZEDGE_EDIT_PREVIEW_TTL_MS;
  let tempDir: string | null = null;

  function makeWorkspace(): string {
    tempDir = mkdtempSync(join(tmpdir(), 'zedge-edit-preview-'));
    process.env.AEON_ROOT = tempDir;
    return tempDir;
  }

  afterEach(() => {
    if (originalAeonRoot === undefined) {
      delete process.env.AEON_ROOT;
    } else {
      process.env.AEON_ROOT = originalAeonRoot;
    }
    if (originalTtl === undefined) {
      delete process.env.ZEDGE_EDIT_PREVIEW_TTL_MS;
    } else {
      process.env.ZEDGE_EDIT_PREVIEW_TTL_MS = originalTtl;
    }
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  test('previews a range edit before applying it once', () => {
    const workspace = makeWorkspace();
    const filePath = 'example.ts';
    const absolutePath = join(workspace, filePath);
    writeFileSync(absolutePath, 'const oldValue = 1;\n', 'utf-8');

    const preview = createRangeEditPreview({
      filePath,
      range: {
        start: { line: 0, character: 6 },
        end: { line: 0, character: 14 },
      },
      replacementText: 'newValue',
    });

    expect(readFileSync(absolutePath, 'utf-8')).toBe('const oldValue = 1;\n');
    expect(preview.diff).toContain('-const oldValue = 1;');
    expect(preview.diff).toContain('+const newValue = 1;');

    const applied = applyEditPreview(preview.previewId);
    expect(applied.applied).toBe(true);
    expect(readFileSync(absolutePath, 'utf-8')).toBe('const newValue = 1;\n');
    expect(() => applyEditPreview(preview.previewId)).toThrow(
      /Preview already applied/
    );
  });

  test('rejects apply when the file hash changed after preview', () => {
    const workspace = makeWorkspace();
    const filePath = 'example.ts';
    const absolutePath = join(workspace, filePath);
    writeFileSync(absolutePath, 'export const value = 1;\n', 'utf-8');

    const preview = createSearchReplacePreview({
      filePath,
      search: 'value = 1',
      replacementText: 'value = 2',
    });

    writeFileSync(absolutePath, 'export const value = 3;\n', 'utf-8');
    expect(() => applyEditPreview(preview.previewId)).toThrow(
      /File changed since preview was created/
    );
  });

  test('expires previews before apply', async () => {
    const workspace = makeWorkspace();
    process.env.ZEDGE_EDIT_PREVIEW_TTL_MS = '1';
    const filePath = 'example.ts';
    const absolutePath = join(workspace, filePath);
    writeFileSync(absolutePath, 'let value = 1;\n', 'utf-8');

    const preview = createSearchReplacePreview({
      filePath,
      search: 'value = 1',
      replacementText: 'value = 2',
    });

    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(() => applyEditPreview(preview.previewId)).toThrow(/Preview expired/);
    expect(readFileSync(absolutePath, 'utf-8')).toBe('let value = 1;\n');
  });
});
