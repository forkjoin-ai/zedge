import {
  getCloudRunHeaders,
  resolveCloudRunServiceAccountKey,
} from '@affectively/shared-utils/edge/cloudrun-auth';

export const CLOUD_RUN_HEALTH_PATHS = ['/api/v1/health', '/health'] as const;

export function buildCloudRunHealthUrls(baseUrl: string): string[] {
  const normalizedBaseUrl = baseUrl.replace(/\/$/, '');
  return CLOUD_RUN_HEALTH_PATHS.map((path) => `${normalizedBaseUrl}${path}`);
}

export async function getCloudRunAuthHeaders(
  cloudRunUrl: string
): Promise<Record<string, string>> {
  const resolvedServiceAccount = resolveCloudRunServiceAccountKey(
    process.env as Record<string, string | undefined>
  );

  if (!resolvedServiceAccount.key) {
    return {};
  }

  return getCloudRunHeaders(resolvedServiceAccount.key, cloudRunUrl);
}
