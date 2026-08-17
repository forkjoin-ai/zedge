/**
 * Routing for the exact-Skymesh (SSM) lane.
 *
 * `rwkv7-mini` lives at `apps/skymesh`, which fronts sovereign-infer. The only
 * tier that could previously serve it was Moonshine, whose base URL is
 * loopback — so a request for the SSM daily driver dialled 127.0.0.1, died in
 * about two milliseconds, and read as "the SSM lane does not yield tokens"
 * when in fact nothing had ever been asked of the lane.
 *
 * Asserted at the source level (the same shape `moonshine-demand.test.ts`
 * uses): driving `infer()` for real would need a live mesh, and the property
 * worth pinning is the ROUTE, not one round trip.
 */

import { describe, expect, test } from '@a0n/gnosis/test';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { isExactSkymeshModel } from '../model-catalog.ts';
import {
  MOONSHINE_BASE_URL,
  SKYMESH_RELAY_BASE_URL,
  resetSkymeshRelayBreakerForTests,
  skymeshRelayCooldownRemainingMs,
} from '../inference-bridge.ts';

const here = dirname(fileURLToPath(import.meta.url));
const bridgeSource = readFileSync(join(here, '..', 'inference-bridge.ts'), 'utf8');

/** The body of `infer()`'s tier ladder, where routing is decided. */
function tierLadder(): string {
  const start = bridgeSource.indexOf('// Tier 0c: the SSM relay');
  const end = bridgeSource.indexOf('// Tier 2: Echo fallback');
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return bridgeSource.slice(start, end);
}

describe('SSM lane routing', () => {
  test('the relay points at the mesh, and Moonshine stays loopback', () => {
    expect(SKYMESH_RELAY_BASE_URL.startsWith('https://')).toBe(true);
    expect(SKYMESH_RELAY_BASE_URL).toBe('https://skymesh.forkjoin.ai');
    // The bug in one line: these must not be the same host.
    expect(MOONSHINE_BASE_URL.includes('127.0.0.1')).toBe(true);
    expect(SKYMESH_RELAY_BASE_URL === MOONSHINE_BASE_URL).toBe(false);
  });

  test('an exact-Skymesh model takes the relay instead of the local container', () => {
    const ladder = tierLadder();
    expect(ladder).toContain('isExactSkymeshModel(request.model)');
    expect(ladder).toContain('trySkymeshRelayInference(request)');
    // Moonshine is entered only for models the local container can serve.
    expect(ladder).toContain('if (!isExactSkymeshModel(request.model))');
  });

  test('a skipped Moonshine attempt says why, instead of blaming loopback', () => {
    expect(tierLadder()).toContain(
      'exact-skymesh model is not served by the local container'
    );
  });

  test('the relay forwards streaming rather than forcing a buffered answer', () => {
    const start = bridgeSource.indexOf('async function trySkymeshRelayInference');
    const end = bridgeSource.indexOf('async function tryMoonshineInference');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const relay = bridgeSource.slice(start, end);

    expect(relay).toContain('const stream = request.stream ?? false;');
    expect(relay).toContain('stream,');
    // Never hardcoded off: that would be the streaming bug this lane was
    // wrongly suspected of having.
    expect(relay.includes('stream: false')).toBe(false);
    // Prefill headers ride along exactly as they do for Moonshine.
    expect(relay).toContain('moonshinePrefillHeaders(request.prefillWindowId)');
  });

  test('an upstream failure is logged with its reason, not swallowed', () => {
    const start = bridgeSource.indexOf('async function trySkymeshRelayInference');
    const end = bridgeSource.indexOf('async function tryMoonshineInference');
    const relay = bridgeSource.slice(start, end);
    expect(relay).toContain('[skymesh-relay] upstream error');
    // Returning null keeps the ladder going; `infer()` still refuses echo for
    // these models, so a failure surfaces instead of being answered by a stub.
    expect(relay).toContain('return null;');
  });

  test('only the models the mesh actually owns are routed there', () => {
    expect(isExactSkymeshModel('rwkv7-mini')).toBe(true);
    expect(isExactSkymeshModel('muse-glimmer-30b-3')).toBe(true);
    expect(isExactSkymeshModel('mistral-7b')).toBe(false);
    expect(isExactSkymeshModel('gnosis-local')).toBe(false);
    expect(isExactSkymeshModel('codestral-22b')).toBe(false);
  });

  test('a known-down lane is skipped immediately, not rediscovered', () => {
    const ladder = tierLadder();
    // The cooldown check comes BEFORE the network call, or it buys nothing.
    const guard = ladder.indexOf('skymeshRelayCooldownRemainingMs()');
    const call = ladder.indexOf('trySkymeshRelayInference(request)');
    expect(guard).toBeGreaterThanOrEqual(0);
    expect(call).toBeGreaterThan(guard);
    // The skip has to say why and for how long; a silent skip is the thing
    // that made this lane look like it "just doesn't yield".
    expect(ladder).toContain('lane down for');
    expect(ladder).toContain('skymeshRelayCooldownReason()');
  });

  test('the breaker starts clear and stays clear until something fails', () => {
    resetSkymeshRelayBreakerForTests();
    expect(skymeshRelayCooldownRemainingMs()).toBe(0);
    // An expired cooldown reads as clear rather than as a stuck-open lane.
    expect(skymeshRelayCooldownRemainingMs(Date.now() + 10 * 60_000)).toBe(0);
  });

  test('headers and generation get separate deadlines', () => {
    const start = bridgeSource.indexOf('async function trySkymeshRelayInference');
    const end = bridgeSource.indexOf('async function tryMoonshineInference');
    const relay = bridgeSource.slice(start, end);
    // Split at the fetch: whatever is armed BEFORE it decides how long a dead
    // lane can stall, and whatever is armed AFTER it decides how long a live
    // one may take to generate. (The function also mentions the long constant
    // up top for its busy window, so ordering by first occurrence would test
    // nothing.)
    const fetchAt = relay.indexOf('await fetch(url');
    expect(fetchAt).toBeGreaterThan(0);
    const beforeFetch = relay.slice(0, fetchAt);
    const afterFetch = relay.slice(fetchAt);

    expect(beforeFetch).toContain('SKYMESH_RELAY_HEADERS_TIMEOUT_MS');
    expect(beforeFetch.includes('controller.abort(), SKYMESH_RELAY_TIMEOUT_MS')).toBe(
      false
    );
    expect(afterFetch).toContain('clearTimeout(timer);');
    expect(afterFetch).toContain('SKYMESH_RELAY_TIMEOUT_MS');
    // A failure records the outage so the NEXT request does not pay for it.
    expect(relay).toContain('tripSkymeshRelayBreaker');
    expect(relay).toContain('clearSkymeshRelayBreaker();');
  });
});
