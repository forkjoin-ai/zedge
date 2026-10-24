import { execFileSync } from 'child_process';
import { LOCAL_ZED_PLACEHOLDER_API_KEY, getLocalZedgeApiUrl } from './zed-settings.ts';

export interface ZedKeychainSyncResult {
  updated: boolean;
  apiUrl: string;
  error?: string;
}

/**
 * Runs one `security` invocation. Injectable so the command contract can be
 * asserted without writing the developer's REAL login keychain — the previous
 * test added an internet password for the live service URL and then "restored"
 * the placeholder, which is a side effect a unit test must never have.
 */
export type SecurityRunner = (args: string[]) => void;

const runSecurityDefault: SecurityRunner = (args) => {
  execFileSync('security', args, { stdio: 'pipe' });
};

/**
 * The exact argv that seeds Zed's keychain item. Exported so the contract is
 * testable (and greppable) without executing `security`:
 * `add-internet-password -a Bearer -s <api_url> -w <key> -U`.
 */
export function buildKeychainAddArgs(
  apiUrl: string,
  apiKey: string
): string[] {
  return [
    'add-internet-password',
    '-a',
    'Bearer',
    '-s',
    apiUrl,
    '-w',
    apiKey,
    '-U',
  ];
}

/** Zed stores openai_compatible keys in the system keychain (not settings.json). */
export function syncZedgeKeychainCredentials(
  port = 7331,
  apiKey = LOCAL_ZED_PLACEHOLDER_API_KEY,
  runSecurity: SecurityRunner = runSecurityDefault
): ZedKeychainSyncResult {
  const apiUrl = getLocalZedgeApiUrl(port);

  if (process.platform !== 'darwin') {
    return { updated: false, apiUrl };
  }

  try {
    runSecurity(buildKeychainAddArgs(apiUrl, apiKey));
    return { updated: true, apiUrl };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { updated: false, apiUrl, error: message };
  }
}
