import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  getCloudRunHeaders,
  resolveCloudRunServiceAccountKey,
} from '@a0n/shared-utils/edge/cloudrun-auth';

// `/health` FIRST: it is the path the monofat coordinators actually serve.
// `/api/v1/health` 404s on every one of them, so probing it first doubled every
// probe cycle's request count for zero information (measured 2026-07-29 — each
// service logged a 404 immediately followed by a 200, once per cycle). Keep the
// legacy path as a fallback for surfaces that only expose the versioned route.
export const CLOUD_RUN_HEALTH_PATHS = ['/health', '/api/v1/health'] as const;

/**
 * Builds the Cloud Run Health Urls.
 */
export function buildCloudRunHealthUrls(baseUrl: string): string[] {
  const normalizedBaseUrl = baseUrl.replace(/\/$/, '');
  return CLOUD_RUN_HEALTH_PATHS.map((path) => `${normalizedBaseUrl}${path}`);
}

// Cache the SA key after first resolution
let _resolvedSAKey: string | null | undefined;

function resolveSAKey(): string | null {
  if (_resolvedSAKey !== undefined) {
    if (!_resolvedSAKey)
      console.warn(
        '[cloudrun-auth] SA key previously resolved as null (cached)'
      );
    return _resolvedSAKey;
  }
  // console.log('[cloudrun-auth] First SA key resolution attempt...');

  // 1. Check env vars
  const envResult = resolveCloudRunServiceAccountKey(
    process.env as Record<string, string | undefined>
  );
  if (envResult.key) {
    _resolvedSAKey = envResult.key;
    return _resolvedSAKey;
  }

  // 2. Check ~/.edgework/cloudrun-sa-key.json (raw JSON → base64)
  try {
    const b64Path = join(homedir(), '.edgework', 'cloudrun-sa-key.b64');
    if (existsSync(b64Path)) {
      const cachedKey = readFileSync(b64Path, 'utf-8').trim();
      _resolvedSAKey = cachedKey;
      // console.log(`[cloudrun-auth] SA key from ${b64Path}`);
      return cachedKey;
    }

    const jsonPath = join(homedir(), '.edgework', 'cloudrun-sa-key.json');
    if (existsSync(jsonPath)) {
      const raw = readFileSync(jsonPath, 'utf-8').trim();
      const cachedKey = Buffer.from(raw).toString('base64');
      _resolvedSAKey = cachedKey;
      // console.log(`[cloudrun-auth] SA key from ${jsonPath}`);
      return cachedKey;
    }
  } catch (err) {
    console.warn(`[cloudrun-auth] File-based SA key resolution failed:`, err);
  }

  _resolvedSAKey = null;
  return null;
}

/**
 * Handles the zedge get Cloud Run Auth Headers workflow.
 */
export async function getCloudRunAuthHeaders(
  cloudRunUrl: string
): Promise<Record<string, string>> {
  const saKey = resolveSAKey();
  if (!saKey) return {};
  return getCloudRunHeaders(saKey, cloudRunUrl);
}
