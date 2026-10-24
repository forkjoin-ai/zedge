/**
 * Skymesh relay caller capability.
 *
 * `apps/skymesh` bills every chat completion through edgework-app's
 * `/api/internal/admit` guard, and the guard has exactly two tiers:
 *
 *   Authorization: Bearer ew_... / UCAN  -> VERIFIED, burns EDGEWORK, no rate cap
 *   (no Authorization header)            -> anonymous, request-capped, 429
 *
 * The exact-Skymesh lane (rwkv7-mini and friends) is the ONLY tier that serves
 * those models, and it used to send no credential at all — so a user who had
 * just run `a0 edgework login` (writing `~/.edgework/api-key`) still landed in
 * the anonymous tier and read "Free-tier request cap reached" as the model being
 * unavailable. The login was recognised by `whoami()` and ignored by inference.
 *
 * Resolution is deliberately UNCACHED. The companion outlives a launch-agent
 * login (the key file is written after the process started), so a credential
 * cached at boot is exactly the stale answer that made a fresh login look
 * unrecognised.
 */

import { getApiKey } from './config.ts';

/** Explicit override: a full `Bearer …` value or a bare token. */
export const SKYMESH_AUTHORIZATION_ENV = 'ZEDGE_SKYMESH_AUTHORIZATION';

/** The local companion's placeholder key is not a capability — never send it. */
const PLACEHOLDER_API_KEY = 'zedge-local';

/**
 * Normalise a raw credential into an Authorization header value.
 * Accepts an already-prefixed `Bearer …` or a bare `ew_…` / UCAN token.
 */
export function skymeshAuthorizationValue(
  raw?: string | null
): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  if (trimmed === PLACEHOLDER_API_KEY) return null;
  return /^bearer\s+/i.test(trimmed) ? trimmed : `Bearer ${trimmed}`;
}

/**
 * Resolve the capability this companion presents to the relay.
 *
 * Order: `ZEDGE_SKYMESH_AUTHORIZATION`, then the Edgework API key
 * (`EDGEWORK_API_TOKEN` / `EDGEWORK_API_KEY` / `EW_API_KEY` / `ZEDGE_API_KEY`,
 * else `~/.edgework/api-key`). Returns null when no capability is available,
 * which is the honest anonymous case — the relay then answers 429 rather than
 * silently attributing the request to someone else.
 */
export function resolveSkymeshAuthorization(): string | null {
  const override = skymeshAuthorizationValue(
    process.env[SKYMESH_AUTHORIZATION_ENV]
  );
  if (override) return override;

  return skymeshAuthorizationValue(getApiKey());
}

/**
 * Headers for `POST /v1/chat/completions` on the relay. Empty object when no
 * credential is available, so a missing login is visible as the relay's own
 * free-tier 429 instead of a fabricated identity.
 */
export function skymeshRelayAuthHeaders(): Record<string, string> {
  const authorization = resolveSkymeshAuthorization();
  return authorization ? { Authorization: authorization } : {};
}

/** Whether the companion can currently present a relay capability. */
export function hasSkymeshCredential(): boolean {
  return resolveSkymeshAuthorization() !== null;
}

/**
 * Non-secret source label for diagnostics ("is the login seen?" is the question
 * this answers; the token itself is never logged or returned).
 */
export function skymeshCredentialSource(): 'override' | 'edgework-key' | null {
  if (skymeshAuthorizationValue(process.env[SKYMESH_AUTHORIZATION_ENV])) {
    return 'override';
  }
  return skymeshAuthorizationValue(getApiKey()) ? 'edgework-key' : null;
}
