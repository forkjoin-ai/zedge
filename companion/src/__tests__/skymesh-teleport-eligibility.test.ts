/**
 * Tests for skymeshTeleportEligibility — the Tier -1 cross-prompt isolation gate.
 *
 * Regression for cross-prompt contamination in mistral-7b (and any model routed
 * through the zedge companion): the Skymesh teleport keys the model-agnostic
 * global cache on the LAST USER MESSAGE TEXT ALONE. It must therefore fire ONLY
 * for a single, context-free user turn — never for a system-prompted (persona /
 * Halogram / judge CHARTER) or multi-turn request, where a last-user-text hit
 * would serve a foreign completion. Mirrors gnosis openai-server commit 71b7203f.
 */

import { describe, test, expect } from '@a0n/gnosis/test';
import { skymeshTeleportEligibility } from '../inference-bridge.ts';

describe('skymeshTeleportEligibility', () => {
  test('eligible: a single context-free user turn', () => {
    const r = skymeshTeleportEligibility([
      { role: 'user', content: 'What is the capital of France?' },
    ]);
    expect(r.eligible).toBe(true);
    expect(r.hasSystemPrompt).toBe(false);
    expect(r.hasPriorContext).toBe(false);
  });

  test('NOT eligible: a non-empty system prompt is present (soul-doc isolation)', () => {
    const r = skymeshTeleportEligibility([
      { role: 'system', content: 'You are Cyrano, a flirtatious poet.' },
      { role: 'user', content: 'yes' },
    ]);
    expect(r.eligible).toBe(false);
    expect(r.hasSystemPrompt).toBe(true);
  });

  test('eligible: an empty/whitespace system prompt does not block', () => {
    const r = skymeshTeleportEligibility([
      { role: 'system', content: '   ' },
      { role: 'user', content: 'What is 2 + 2?' },
    ]);
    expect(r.eligible).toBe(true);
    expect(r.hasSystemPrompt).toBe(false);
  });

  test('NOT eligible: a prior assistant turn makes the answer context-conditioned', () => {
    const r = skymeshTeleportEligibility([
      { role: 'user', content: 'Tell me about Rome.' },
      { role: 'assistant', content: 'Rome is the capital of Italy...' },
      { role: 'user', content: 'continue' },
    ]);
    expect(r.eligible).toBe(false);
    expect(r.hasPriorContext).toBe(true);
  });

  test('NOT eligible: more than one user turn (the "yes"/"continue" collision)', () => {
    const r = skymeshTeleportEligibility([
      { role: 'user', content: 'A long earlier question that set up context.' },
      { role: 'user', content: 'yes' },
    ]);
    expect(r.eligible).toBe(false);
    expect(r.hasPriorContext).toBe(true);
  });

  test('NOT eligible: empty / no user content', () => {
    expect(skymeshTeleportEligibility([]).eligible).toBe(false);
    expect(
      skymeshTeleportEligibility([{ role: 'user', content: '   ' }]).eligible,
    ).toBe(false);
  });

  test('two unrelated multi-turn chats whose newest turn is "yes" both skip teleport', () => {
    const chatA = skymeshTeleportEligibility([
      { role: 'user', content: 'Is Paris in France?' },
      { role: 'assistant', content: 'Yes.' },
      { role: 'user', content: 'yes' },
    ]);
    const chatB = skymeshTeleportEligibility([
      { role: 'user', content: 'Should I deploy on Friday?' },
      { role: 'assistant', content: 'Risky, but possible.' },
      { role: 'user', content: 'yes' },
    ]);
    // Neither may teleport — so chat B can never be served chat A's cached answer.
    expect(chatA.eligible).toBe(false);
    expect(chatB.eligible).toBe(false);
  });
});
