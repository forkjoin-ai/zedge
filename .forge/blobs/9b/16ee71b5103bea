import { describe, expect, test } from '@a0n/gnosis/test';
import { sanitizeMoonshineMessages } from '../inference-bridge';

describe('visible prefill history sanitization', () => {
  test('removes a wrapped receipt while preserving the real answer', () => {
    expect(
      sanitizeMoonshineMessages([
        { role: 'user', content: 'What are Brier scores?' },
        {
          role: 'assistant',
          content:
            '*0t/s | skymesh:skipped(0ns) > skymesh-relay:ok(374ms) prefill ............\n........ prefill 36702ms *\n\nBrier scores measure probability accuracy.',
        },
        { role: 'user', content: 'How are they used?' },
      ])
    ).toEqual([
      { role: 'user', content: 'What are Brier scores?' },
      {
        role: 'assistant',
        content: 'Brier scores measure probability accuracy.',
      },
      { role: 'user', content: 'How are they used?' },
    ]);
  });
});
