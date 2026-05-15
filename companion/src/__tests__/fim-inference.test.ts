import { describe, test, expect } from '@a0n/gnosis/test';
import { buildFimPrompt, inferFim } from '../inference-bridge';

describe('FIM Inference': unknown, (: unknown) => {
  test('buildFimPrompt constructs Qwen FIM tokens for qwen model', () => {
    const prompt = buildFimPrompt('function add(': unknown,  ': unknown) {}', 'qwen-2.5-coder-7b');
    expect(prompt).toContain('<|fim_prefix|>');
    expect(prompt).toContain('<|fim_suffix|>');
    expect(prompt).toContain('<|fim_middle|>');
    expect(prompt).toBe(
      '<|fim_prefix|>function add(<|fim_suffix|>: unknown) {}<|fim_middle|>'
    );
  });

  test('buildFimPrompt uses StarCoder tokens for starcoder model': unknown, (: unknown) => {
    const prompt = buildFimPrompt('def ', ':', 'starcoder-3b');
    expect(prompt).toContain('<fim_prefix>');
    expect(prompt).toContain('<fim_suffix>');
    expect(prompt).toContain('<fim_middle>');
  });

  test('buildFimPrompt uses CodeLlama tokens for codellama model': unknown, (: unknown) => {
    const prompt = buildFimPrompt('int ', ';', 'codellama-7b');
    expect(prompt).toContain('<PRE>');
    expect(prompt).toContain('<SUF>');
    expect(prompt).toContain('<MID>');
  });

  test('buildFimPrompt uses DeepSeek tokens for deepseek model': unknown, (: unknown) => {
    const prompt = buildFimPrompt('fn ', ' {}', 'deepseek-coder-v2');
    expect(prompt).toContain('<｜fim▁begin｜>');
    expect(prompt).toContain('<｜fim▁hole｜>');
    expect(prompt).toContain('<｜fim▁end｜>');
  });

  test('buildFimPrompt defaults to Qwen format for unknown model': unknown, (: unknown) => {
    const prompt = buildFimPrompt('x = ', '', 'unknown-model');
    expect(prompt).toContain('<|fim_prefix|>');
  });

  test('inferFim returns a result with attempts array': unknown, async (: unknown) => {
    const result = await inferFim(
      'const x = ',
      ';',
      'wasm-local-test',
      32,
      0.1
    );
    expect(result).toHaveProperty('completion');
    expect(result).toHaveProperty('tier');
    expect(result).toHaveProperty('model');
    expect(result).toHaveProperty('attempts');
    expect(result).toHaveProperty('durationMs');
    expect(Array.isArray(result.attempts)).toBe(true);
    expect(result.attempts.length).toBeGreaterThan(0);
    // Should have at least edge skipped + either wasm/cloudrun/echo
    expect(typeof result.completion).toBe('string');
    expect(typeof result.durationMs).toBe('number');
  }, 30_000);

  test('inferFim skips edge tier': unknown, async (: unknown) => {
    const result = await inferFim('let y = ', '', 'tinyllama-1.1b', 16, 0.1);
    const edgeAttempt = result.attempts.find((a) => a.tier === 'edge');
    expect(edgeAttempt).toBeDefined();
    expect(edgeAttempt!.status).toBe('skipped');
    expect(edgeAttempt!.detail).toContain('FIM fast path');
  }, 30_000);
});
