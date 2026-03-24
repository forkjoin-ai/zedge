import {
  getCloudRunHeaders,
  resolveCloudRunServiceAccountKey,
} from '@affectively/shared-utils/edge/cloudrun-auth';

export const CLOUD_RUN_HEALTH_PATHS = ['/api/v1/health', '/health'] as const;

export function buildCloudRunHealthUrls(baseUrl: string): string[] {
  const normalizedBaseUrl = baseUrl.replace(/\/$/, '');
  return CLOUD_RUN_HEALTH_PATHS.map((path) => `${normalizedBaseUrl}${path}`);
}

// Cache the SA key after first resolution
let _resolvedSAKey: string | null | undefined;

function resolveSAKey(): string | null {
  if (_resolvedSAKey !== undefined) return _resolvedSAKey;

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
    const { readFileSync, existsSync } = require('fs');
    const { join } = require('path');
    const { homedir } = require('os');

    const b64Path = join(homedir(), '.edgework', 'cloudrun-sa-key.b64');
    if (existsSync(b64Path)) {
      _resolvedSAKey = readFileSync(b64Path, 'utf-8').trim();
      console.log(`[cloudrun-auth] SA key from ${b64Path}`);
      return _resolvedSAKey;
    }

    const jsonPath = join(homedir(), '.edgework', 'cloudrun-sa-key.json');
    if (existsSync(jsonPath)) {
      const raw = readFileSync(jsonPath, 'utf-8').trim();
      _resolvedSAKey = Buffer.from(raw).toString('base64');
      console.log(`[cloudrun-auth] SA key from ${jsonPath}`);
      return _resolvedSAKey;
    }
  } catch {}

  _resolvedSAKey = null;
  return null;
}

export async function getCloudRunAuthHeaders(
  cloudRunUrl: string
): Promise<Record<string, string>> {
  const saKey = resolveSAKey();
  if (!saKey) return {};
  return getCloudRunHeaders(saKey, cloudRunUrl);
}
