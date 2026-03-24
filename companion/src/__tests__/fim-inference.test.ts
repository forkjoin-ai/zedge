import { describe, test, expect } from 'bun:test';
import { buildFimPrompt, inferFim } from '../inference-bridge';

describe('FIM Inference', () => {
  test('buildFimPrompt constructs Qwen FIM tokens for qwen model', () => {
    const prompt = buildFimPrompt('function add(', ') {}', 'qwen-2.5-coder-7b');
    expect(prompt).toContain('<|fim_prefix|>');
    expect(prompt).toContain('<|fim_suffix|>');
    expect(prompt).toContain('<|fim_middle|>');
    expect(prompt).toBe(
      '<|fim_prefix|>function add(<|fim_suffix|>) {}<|fim_middle|>'
    );
  });

  test('buildFimPrompt uses StarCoder tokens for starcoder model', () => {
    const prompt = buildFimPrompt('def ', ':', 'starcoder-3b');
    expect(prompt).toContain('<fim_prefix>');
    expect(prompt).toContain('<fim_suffix>');
    expect(prompt).toContain('<fim_middle>');
  });

  test('buildFimPrompt uses CodeLlama tokens for codellama model', () => {
    const prompt = buildFimPrompt('int ', ';', 'codellama-7b');
    expect(prompt).toContain('<PRE>');
    expect(prompt).toContain('<SUF>');
    expect(prompt).toContain('<MID>');
  });

  test('buildFimPrompt uses DeepSeek tokens for deepseek model', () => {
    const prompt = buildFimPrompt('fn ', ' {}', 'deepseek-coder-v2');
    expect(prompt).toContain('<｜fim▁begin｜>');
    expect(prompt).toContain('<｜fim▁hole｜>');
    expect(prompt).toContain('<｜fim▁end｜>');
  });

  test('buildFimPrompt defaults to Qwen format for unknown model', () => {
    const prompt = buildFimPrompt('x = ', '', 'unknown-model');
    expect(prompt).toContain('<|fim_prefix|>');
  });

  test('inferFim returns a result with attempts array', async () => {
    const result = await inferFim('const x = ', ';', 'wasm-local-test', 32, 0.1);
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

  test('inferFim skips edge tier', async () => {
    const result = await inferFim('let y = ', '', 'tinyllama-1.1b', 16, 0.1);
    const edgeAttempt = result.attempts.find((a) => a.tier === 'edge');
    expect(edgeAttempt).toBeDefined();
    expect(edgeAttempt!.status).toBe('skipped');
    expect(edgeAttempt!.detail).toContain('FIM fast path');
  }, 30_000);
});
