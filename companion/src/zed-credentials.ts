import { execFileSync } from 'child_process';
import { LOCAL_ZED_PLACEHOLDER_API_KEY, getLocalZedgeApiUrl } from './zed-settings.ts';

export interface ZedKeychainSyncResult {
  updated: boolean;
  apiUrl: string;
  error?: string;
}

/** Zed stores openai_compatible keys in the system keychain (not settings.json). */
export function syncZedgeKeychainCredentials(
  port = 7331,
  apiKey = LOCAL_ZED_PLACEHOLDER_API_KEY
): ZedKeychainSyncResult {
  const apiUrl = getLocalZedgeApiUrl(port);

  if (process.platform !== 'darwin') {
    return { updated: false, apiUrl };
  }

  try {
    execFileSync(
      'security',
      [
        'add-internet-password',
        '-a',
        'Bearer',
        '-s',
        apiUrl,
        '-w',
        apiKey,
        '-U',
      ],
      { stdio: 'pipe' }
    );
    return { updated: true, apiUrl };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { updated: false, apiUrl, error: message };
  }
}
