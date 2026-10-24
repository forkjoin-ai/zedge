/**
 * The companion must present the Edgework capability that `a0 edgework login`
 * saved, and must do it per request.
 *
 * The failure this pins: the companion read the key for `whoami()` (so it said
 * "Authenticated via api-key") and then sent NOTHING to the relay, so skymesh's
 * admit guard served the request in the anonymous tier and answered
 * "Free-tier request cap reached" - read by the user as "the model is
 * unavailable" right after a successful login.
 */

import { describe, expect, test } from '@a0n/gnosis/test';

import {
  SKYMESH_AUTHORIZATION_ENV,
  hasSkymeshCredential,
  resolveSkymeshAuthorization,
  skymeshAuthorizationValue,
  skymeshCredentialSource,
  skymeshRelayAuthHeaders,
} from '../skymesh-auth.ts';

function withOverride<T>(value: string | undefined, fn: () => T): T {
  const previous = process.env[SKYMESH_AUTHORIZATION_ENV];
  if (value === undefined) delete process.env[SKYMESH_AUTHORIZATION_ENV];
  else process.env[SKYMESH_AUTHORIZATION_ENV] = value;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env[SKYMESH_AUTHORIZATION_ENV];
    else process.env[SKYMESH_AUTHORIZATION_ENV] = previous;
  }
}

describe('relay capability', () => {
  test('a bare key becomes a Bearer header, a prefixed one is left alone', () => {
    expect(skymeshAuthorizationValue('ew_abc')).toBe('Bearer ew_abc');
    expect(skymeshAuthorizationValue('  ew_abc  ')).toBe('Bearer ew_abc');
    expect(skymeshAuthorizationValue('Bearer ew_abc')).toBe('Bearer ew_abc');
    expect(skymeshAuthorizationValue('bearer ew_abc')).toBe('bearer ew_abc');
    expect(skymeshAuthorizationValue('')).toBe(null);
    expect(skymeshAuthorizationValue(undefined)).toBe(null);
    expect(skymeshAuthorizationValue(null)).toBe(null);
  });

  test("the companion's placeholder key is never presented as a capability", () => {
    expect(skymeshAuthorizationValue('zedge-local')).toBe(null);
  });

  test('an explicit override is used verbatim and wins', () => {
    withOverride('ew_from_env', () => {
      expect(resolveSkymeshAuthorization()).toBe('Bearer ew_from_env');
      expect(skymeshRelayAuthHeaders()).toEqual({
        Authorization: 'Bearer ew_from_env',
      });
      expect(hasSkymeshCredential()).toBe(true);
      expect(skymeshCredentialSource()).toBe('override');
    });
  });

  test('a placeholder override does not masquerade as a capability', () => {
    withOverride('zedge-local', () => {
      expect(skymeshCredentialSource()).not.toBe('override');
    });
  });

  test('headers carry no identity when nothing resolves, and only a bearer when it does', () => {
    withOverride(undefined, () => {
      const headers = skymeshRelayAuthHeaders();
      const keys = Object.keys(headers);
      expect(keys.length === 0 || keys[0] === 'Authorization').toBe(true);
      if (headers.Authorization) {
        // Bearer + a token, never the local placeholder.
        expect(/^Bearer \S+$/.test(headers.Authorization)).toBe(true);
        expect(headers.Authorization.includes('zedge-local')).toBe(false);
        expect(hasSkymeshCredential()).toBe(true);
      } else {
        expect(hasSkymeshCredential()).toBe(false);
      }
    });
  });
});
