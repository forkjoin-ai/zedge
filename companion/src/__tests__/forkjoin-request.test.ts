import { describe, expect, test } from '@a0n/gnosis/test';

import { buildForkjoinRequestBody } from '../inference-bridge.ts';

describe('zedge forkjoin request body', () => {
  test('forwards qwen35 tools and think steering', () => {
    const body = buildForkjoinRequestBody(
      {
        model: 'qwen35-4b-uncensored',
        messages: [{ role: 'user', content: 'Call ping.' }],
        stream: true,
        tools: [
          {
            type: 'function',
            function: { name: 'ping', parameters: { type: 'object' } },
          },
        ],
        tool_choice: 'auto',
        disable_thinking: true,
        thinking_budget_mode: 'out-of-budget',
        think_budget: 128,
      },
      [{ role: 'user', content: 'Call ping.' }],
      512,
      true
    );
    expect(body.model).toBe('qwen35-4b-uncensored');
    expect(body.stream).toBe(true);
    expect(body.max_tokens).toBe(512);
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: { name: 'ping', parameters: { type: 'object' } },
      },
    ]);
    expect(body.tool_choice).toBe('auto');
    expect(body.disable_thinking).toBe(true);
    expect(body.thinking_budget_mode).toBe('out-of-budget');
    expect(body.think_budget).toBe(128);
  });

  test('omits absent steering fields', () => {
    const body = buildForkjoinRequestBody(
      { model: 'qwen35-4b-uncensored', messages: [] },
      [],
      64,
      false
    );
    expect('tools' in body).toBe(false);
    expect('disable_thinking' in body).toBe(false);
    expect('think_budget' in body).toBe(false);
  });
});
