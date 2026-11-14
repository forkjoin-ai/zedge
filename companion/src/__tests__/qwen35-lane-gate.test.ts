import { readFileSync } from 'node:fs';
import { describe, expect, test } from '@a0n/gnosis/test';

import { getKnownZedgeModel, isForkjoinTierModel } from '../model-catalog.ts';
import { buildForkjoinRequestBody } from '../inference-bridge.ts';

describe('qwen35 zedge lane gate', () => {
  test('catalog exposes the local lane and routes it through forkjoin', () => {
    const model = getKnownZedgeModel('qwen35-4b-uncensored');
    expect(model?.maxTokens).toBe(512);
    expect(model?.forkjoinTier).toBe(true);
    expect(isForkjoinTierModel('qwen35-4b-uncensored')).toBe(true);
  });

  test('local spec carries real artifact URLs and a dedicated tokenizer', () => {
    const source = readFileSync(new URL('../moonshine-docker.ts', import.meta.url), 'utf8');
    expect(source).toContain("'qwen35-4b-uncensored': {");
    expect(source).toContain('qwen35-4b-uncensored-q4km.knot');
    expect(source).toContain('qwen35-4b-uncensored-tokenizer.gguf');
    expect(source).toContain('edgework-web.taylorbuley.workers.dev');
    expect(source).toContain('TOKENIZER_GGUF_URL: config.tokenizerGgufUrl');
    expect(source).toContain('if (spec?.tokenizerGgufUrl)');
  });

  test('forkjoin body carries tools and think steering', () => {
    const body = buildForkjoinRequestBody(
      {
        model: 'qwen35-4b-uncensored',
        messages: [{ role: 'user', content: 'ping' }],
        tools: [{ type: 'function', function: { name: 'ping' } }],
        disable_thinking: true,
        thinking_budget_mode: 'out-of-budget',
        think_budget: 128,
      },
      [{ role: 'user', content: 'ping' }],
      512,
      true
    );
    expect(body.tools).toEqual([
      { type: 'function', function: { name: 'ping' } },
    ]);
    expect(body.disable_thinking).toBe(true);
    expect(body.thinking_budget_mode).toBe('out-of-budget');
    expect(body.think_budget).toBe(128);
  });
});
