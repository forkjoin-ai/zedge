import { describe, expect, test } from '@a0n/gnosis/test';

import {
  applySystemPromptBudget,
  getCompactSystemPrompt,
  shouldSkipHeavySystemContext,
} from '../prompt-budget.ts';

describe('prompt budget', () => {
  test('drops all system prompts for local wasm models', () => {
    const messages = [
      { role: 'system', content: 'Answer tersely.' },
      { role: 'user', content: 'hello' },
    ];

    expect(applySystemPromptBudget('wasm-local', messages)).toEqual([
      { role: 'user', content: 'hello' },
    ]);
  });

  test('keeps a short single system prompt for small models', () => {
    const messages = [
      { role: 'system', content: 'Answer tersely.' },
      { role: 'user', content: 'hello' },
    ];

    expect(applySystemPromptBudget('tinyllama-1.1b', messages)).toEqual(
      messages
    );
  });

  test('collapses stacked system prompts for small models', () => {
    const messages = [
      { role: 'system', content: 'A'.repeat(450) },
      { role: 'system', content: 'B'.repeat(450) },
      { role: 'user', content: 'hello' },
    ];

    expect(applySystemPromptBudget('tinyllama-1.1b', messages)).toEqual([
      { role: 'system', content: getCompactSystemPrompt() },
      { role: 'user', content: 'hello' },
    ]);
  });

  test('drops codebase context blocks for small models', () => {
    const messages = [
      {
        role: 'system',
        content:
          'You are helpful.\n\n<codebase_context>\nconst huge = true;\n</codebase_context>',
      },
      { role: 'user', content: 'hello' },
    ];

    expect(applySystemPromptBudget('tinyllama-1.1b', messages)).toEqual([
      { role: 'system', content: getCompactSystemPrompt() },
      { role: 'user', content: 'hello' },
    ]);
  });

  test('compacts oversized system prompts for larger models too', () => {
    const messages = [
      { role: 'system', content: 'A'.repeat(1200) },
      { role: 'system', content: 'B'.repeat(1200) },
      { role: 'user', content: 'hello' },
    ];

    expect(applySystemPromptBudget('qwen-2.5-coder-7b', messages)).toEqual([
      { role: 'system', content: getCompactSystemPrompt() },
      { role: 'user', content: 'hello' },
    ]);
  });

  test('marks only small-context models for heavy-context skipping', () => {
    expect(shouldSkipHeavySystemContext('tinyllama-1.1b')).toBe(true);
    expect(shouldSkipHeavySystemContext('wasm-local')).toBe(true);
    expect(shouldSkipHeavySystemContext('qwen-2.5-coder-7b')).toBe(false);
  });
});
