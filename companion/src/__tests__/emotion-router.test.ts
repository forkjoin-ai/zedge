import { describe, test, expect } from 'bun:test';
import { analyzeCodeEmotion, routeByEmotion } from '../emotion-router';

describe('Emotion Router', () => {
  test('analyzeCodeEmotion detects frustration from TODOs/FIXMEs', () => {
    const code = `
function processData(input) {
  // TODO: this is a temporary hack
  // FIXME: handle edge cases
  // HACK: workaround for upstream bug
  return input;
}`;

    const profile = analyzeCodeEmotion(code);
    expect(profile.dominantEmotion).toBe('frustration');
    expect(profile.avgValence).toBeLessThan(0);
    expect(profile.emotionCounts.frustration).toBeGreaterThanOrEqual(3);
  });

  test('analyzeCodeEmotion detects anxiety from BUGs and error handling', () => {
    const code = `
function riskyOperation() {
  // BUG: this fails under load
  // DANGER: may corrupt data
  try {
    throw new Error('something broke');
  } catch (err) {
    // UNSAFE: swallowing error
  }
}`;

    const profile = analyzeCodeEmotion(code);
    expect(profile.emotionCounts.anxiety).toBeGreaterThanOrEqual(2);
    expect(profile.avgArousal).toBeGreaterThan(0);
  });

  test('analyzeCodeEmotion detects confidence from tests', () => {
    const code = `
describe('MyModule', () => {
  test('handles valid input', () => {
    expect(process(1)).toBe(2);
  });
  test('handles edge case', () => {
    expect(process(0)).toBe(0);
  });
  test('throws on invalid', () => {
    expect(() => process(-1)).toThrow();
  });
});`;

    const profile = analyzeCodeEmotion(code);
    expect(profile.dominantEmotion).toBe('confidence');
    expect(profile.avgValence).toBeGreaterThan(0);
  });

  test('analyzeCodeEmotion returns neutral for clean code', () => {
    const code = `
export function add(a: number, b: number): number {
  return a + b;
}

export function multiply(a: number, b: number): number {
  return a * b;
}`;

    const profile = analyzeCodeEmotion(code);
    expect(profile.dominantEmotion).toBe('neutral');
    expect(profile.avgValence).toBe(0);
    expect(profile.avgArousal).toBe(0);
  });

  test('routeByEmotion selects consensus for anxious code', () => {
    const profile = analyzeCodeEmotion(`
// BUG: critical failure path
// DANGER: race condition
try { riskyOp(); } catch(e) { throw new Error('failed'); }
`);

    const decision = routeByEmotion(profile);
    expect(decision.strategy).toBe('consensus');
    expect(decision.modelCount).toBeGreaterThanOrEqual(2);
    expect(decision.confidenceThreshold).toBeGreaterThan(0.6);
    expect(decision.daydreamCategory).toBe('bug-fix');
  });

  test('routeByEmotion prioritizes refactoring for frustrated code', () => {
    const profile = analyzeCodeEmotion(`
// TODO: extract this
// FIXME: cleanup
// HACK: temporary
// TODO: refactor
// FIXME: this is awful
`);

    const decision = routeByEmotion(profile);
    expect(decision.daydreamPriority).toBeGreaterThan(1.0);
    expect(decision.daydreamCategory).toBe('refactor');
  });

  test('routeByEmotion uses fastest for confident code', () => {
    const profile = analyzeCodeEmotion(`
describe('module', () => {
  test('a', () => { expect(1).toBe(1); });
  test('b', () => { expect(2).toBe(2); });
  test('c', () => { expect(3).toBe(3); });
  test('d', () => { expect(4).toBe(4); });
});`);

    const decision = routeByEmotion(profile);
    expect(decision.strategy).toBe('fastest');
    expect(decision.daydreamPriority).toBeLessThan(1.0);
  });

  test('routeByEmotion returns defaults for neutral code', () => {
    const profile = analyzeCodeEmotion('const x = 1;\nconst y = 2;\n');
    const decision = routeByEmotion(profile);
    expect(decision.strategy).toBe('fastest');
    expect(decision.daydreamPriority).toBe(1.0);
    expect(decision.reasoning).toContain('Neutral');
  });
});
