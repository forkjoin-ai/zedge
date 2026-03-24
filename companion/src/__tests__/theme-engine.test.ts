import { describe, test, expect } from 'bun:test';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { getThemePalette, getBasePalette } from '../theme-engine';

describe('Theme Engine', () => {
  const testDir = join(tmpdir(), `zedge-theme-test-${Date.now()}`);

  test('getBasePalette returns Zedge Dark with AeonOS tokens', () => {
    const palette = getBasePalette();
    expect(palette.name).toBe('Zedge Dark');
    expect(palette.mood).toBe('neutral');
    expect(palette.bg.root).toBe('#09090b');
    expect(palette.accent.primary).toBe('#3b82f6');
    expect(palette.gnosis.fork).toBe('#10b981');
    expect(palette.gnosis.race).toBe('#f59e0b');
    expect(palette.gnosis.fold).toBe('#06b6d4');
    expect(palette.gnosis.vent).toBe('#ef4444');
  });

  test('getThemePalette returns base palette without file', () => {
    const palette = getThemePalette();
    expect(palette.mood).toBe('neutral');
    expect(palette.accent.primary).toBe('#3b82f6');
  });

  test('getThemePalette shifts warm for confident code', () => {
    mkdirSync(testDir, { recursive: true });
    const filePath = join(testDir, 'confident.ts');
    writeFileSync(filePath, `
describe('test', () => {
  test('a', () => { expect(1).toBe(1); });
  test('b', () => { expect(2).toBe(2); });
  test('c', () => { expect(3).toBe(3); });
  test('d', () => { expect(4).toBe(4); });
  test('e', () => { expect(5).toBe(5); });
});
`);

    const palette = getThemePalette(filePath);
    expect(palette.mood).toBe('confident');
    // Accent should have shifted (not the base blue)
    expect(palette.accent.primary).not.toBe('#3b82f6');
    expect(palette.emotionalProfile?.dominantEmotion).toBe('confidence');
  });

  test('getThemePalette shifts cool for anxious code', () => {
    const filePath = join(testDir, 'anxious.ts');
    writeFileSync(filePath, `
// BUG: critical race condition
// DANGER: data corruption possible
try {
  throw new Error('something broke');
} catch (err) {
  // UNSAFE: swallowing error
  throw new Error('retry failed');
}
`);

    const palette = getThemePalette(filePath);
    expect(['anxious', 'frustrated']).toContain(palette.mood);
    expect(palette.accent.primary).not.toBe('#3b82f6');
  });

  test('getThemePalette shifts muted for frustrated code', () => {
    const filePath = join(testDir, 'frustrated.ts');
    writeFileSync(filePath, `
// TODO: refactor this mess
// FIXME: handle edge cases
// HACK: workaround for upstream bug
// TODO: clean up
// FIXME: temporary
`);

    const palette = getThemePalette(filePath);
    expect(palette.mood).toBe('frustrated');
    expect(palette.accent.primary).not.toBe('#3b82f6');
    expect(palette.routeDecision?.daydreamPriority).toBeGreaterThan(1);
  });

  test('getThemePalette returns neutral for clean code', () => {
    const filePath = join(testDir, 'clean.ts');
    writeFileSync(filePath, `
export function add(a: number, b: number): number {
  return a + b;
}
`);

    const palette = getThemePalette(filePath);
    expect(palette.mood).toBe('neutral');
  });

  test('getThemePalette handles nonexistent file gracefully', () => {
    const palette = getThemePalette('/nonexistent/file.ts');
    expect(palette.mood).toBe('neutral');
    expect(palette.accent.primary).toBe('#3b82f6');
  });

  test('cleanup', () => {
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });
});
