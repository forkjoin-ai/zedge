import { describe, expect, test } from '@a0n/gnosis/test';

import { formatLocalChatPrompt } from '../aether-local-runtime.ts';

describe('Aether local runtime prompt formatting', () => {
  test('formats TinyLlama local prompts as instruction blocks', () => {
    const prompt = formatLocalChatPrompt(
      [
        { role: 'system', content: 'Be terse.' },
        {
          role: 'user',
          content: 'Write one plain English sentence about the sky.',
        },
      ],
      'tinyllama-1.1b'
    );

    expect(prompt).toBe(
      '[INST] Be terse.\n\nWrite one plain English sentence about the sky. [/INST]'
    );
  });

  test('keeps prior assistant turns inside the TinyLlama instruction transcript', () => {
    const prompt = formatLocalChatPrompt(
      [
        { role: 'system', content: 'Be terse.' },
        { role: 'user', content: 'Say hello.' },
        { role: 'assistant', content: 'Hello.' },
        { role: 'user', content: 'Say goodbye.' },
      ],
      'tinyllama-1.1b'
    );

    expect(prompt).toBe(
      '[INST] Be terse.\n\nSay hello. [/INST] Hello. [INST] Say goodbye. [/INST]'
    );
  });
});
