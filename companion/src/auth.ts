/**
 * Zedge Auth Flow
 *
 * Uses the same ~/.edgework token storage as edgework-cli, but drives
 * browser login through OAuth device authorization instead of a local
 * callback server.
 */

import { homedir } from 'os';
import { join } from 'path';
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
} from 'fs';
import { getEdgeworkConfig } from './config';

const CONFIG_DIR = join(homedir(), '.edgework');
const TOKEN_FILE = join(CONFIG_DIR, 'token.json');
const API_KEY_FILE = join(CONFIG_DIR, 'api-key');
const DEVICE_CODE_ENDPOINT = '/auth/device/code';
const DEVICE_TOKEN_ENDPOINT = '/auth/device/token';
const USER_INFO_ENDPOINT = '/auth/me';

interface AuthToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  userId: string;
  email: string;
}

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval?: number;
}

interface DeviceTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  error?: string;
  error_description?: string;
}

interface UserInfoResponse {
  id: string;
  email: string;
}

interface PendingDeviceAuthorization {
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete: string;
  readonly expiresAt: number;
  readonly intervalMs: number;
  readonly browserOpened: boolean;
  pollPromise?: Promise<void>;
}

export interface LoginResult {
  success: boolean;
  pending?: boolean;
  email?: string;
  error?: string;
  userCode?: string;
  verificationUri?: string;
  verificationUriComplete?: string;
  expiresAt?: number;
  browserOpened?: boolean;
}

let pendingDeviceAuthorization: PendingDeviceAuthorization | null = null;

function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function openBrowser(url: string): Promise<boolean> {
  const bunRuntime = Bun as unknown as {
    open?: (target: string) => unknown;
  };

  if (typeof Bun === 'undefined' || typeof bunRuntime.open !== 'function') {
    return false;
  }

  try {
    await Promise.resolve(bunRuntime.open(url));
    return true;
  } catch {
    return false;
  }
}

function saveAuthToken(
  tokenData: DeviceTokenResponse,
  user: UserInfoResponse
): void {
  const token: AuthToken = {
    accessToken: tokenData.access_token,
    refreshToken: tokenData.refresh_token,
    expiresAt: Date.now() + tokenData.expires_in * 1000,
    userId: user.id,
    email: user.email,
  };

  ensureConfigDir();
  writeFileSync(TOKEN_FILE, JSON.stringify(token, null, 2), {
    mode: 0o600,
  });
}

async function fetchUserInfo(
  baseUrl: string,
  accessToken: string
): Promise<UserInfoResponse> {
  const response = await fetch(`${baseUrl}${USER_INFO_ENDPOINT}`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch user info: ${response.status}`);
  }

  return (await response.json()) as UserInfoResponse;
}

function pendingLoginResult(
  authorization: PendingDeviceAuthorization
): LoginResult {
  return {
    success: false,
    pending: true,
    userCode: authorization.userCode,
    verificationUri: authorization.verificationUri,
    verificationUriComplete: authorization.verificationUriComplete,
    expiresAt: authorization.expiresAt,
    browserOpened: authorization.browserOpened,
  };
}

async function pollForDeviceToken(
  baseUrl: string,
  authorization: PendingDeviceAuthorization
): Promise<void> {
  try {
    while (Date.now() < authorization.expiresAt) {
      await sleep(authorization.intervalMs);

      try {
        const tokenResponse = await fetch(`${baseUrl}${DEVICE_TOKEN_ENDPOINT}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            client_id: 'zedge-companion',
            device_code: authorization.deviceCode,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
          }),
          signal: AbortSignal.timeout(15_000),
        });

        const tokenData =
          (await tokenResponse.json()) as DeviceTokenResponse;

        if (tokenData.error) {
          if (tokenData.error === 'authorization_pending') {
            continue;
          }
          if (tokenData.error === 'slow_down') {
            await sleep(5_000);
            continue;
          }
          if (
            tokenData.error === 'expired_token' ||
            tokenData.error === 'access_denied'
          ) {
            pendingDeviceAuthorization = null;
            return;
          }

          continue;
        }

        const user = await fetchUserInfo(baseUrl, tokenData.access_token);
        saveAuthToken(tokenData, user);
        pendingDeviceAuthorization = null;
        return;
      } catch {
        continue;
      }
    }
  } finally {
    if (
      pendingDeviceAuthorization &&
      pendingDeviceAuthorization.expiresAt <= Date.now()
    ) {
      pendingDeviceAuthorization = null;
    }
  }
}

/**
 * Start OAuth device login flow.
 *
 * Returns verification details immediately and completes token exchange
 * asynchronously in the background once the user approves the browser prompt.
 */
export async function login(): Promise<LoginResult> {
  const alreadyAuthenticated = whoami();
  if (alreadyAuthenticated.authenticated) {
    return {
      success: true,
      email: alreadyAuthenticated.email,
    };
  }

  if (
    pendingDeviceAuthorization &&
    pendingDeviceAuthorization.expiresAt > Date.now()
  ) {
    return pendingLoginResult(pendingDeviceAuthorization);
  }

  const config = getEdgeworkConfig();
  const deviceCodeResponse = await fetch(
    `${config.apiBaseUrl}${DEVICE_CODE_ENDPOINT}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        client_id: 'zedge-companion',
      }),
      signal: AbortSignal.timeout(15_000),
    }
  );

  if (!deviceCodeResponse.ok) {
    return {
      success: false,
      error: `Failed to initiate login: ${deviceCodeResponse.status}`,
    };
  }

  const deviceCode = (await deviceCodeResponse.json()) as DeviceCodeResponse;
  const browserOpened = await openBrowser(deviceCode.verification_uri_complete);
  const authorization: PendingDeviceAuthorization = {
    deviceCode: deviceCode.device_code,
    userCode: deviceCode.user_code,
    verificationUri: deviceCode.verification_uri,
    verificationUriComplete: deviceCode.verification_uri_complete,
    expiresAt: Date.now() + deviceCode.expires_in * 1000,
    intervalMs: Math.max(1, deviceCode.interval ?? 5) * 1000,
    browserOpened,
  };

  authorization.pollPromise = pollForDeviceToken(
    config.apiBaseUrl,
    authorization
  );
  pendingDeviceAuthorization = authorization;

  return pendingLoginResult(authorization);
}

/**
 * Logout — clear tokens and API key
 */
export function logout(): void {
  pendingDeviceAuthorization = null;
  try {
    if (existsSync(TOKEN_FILE)) unlinkSync(TOKEN_FILE);
  } catch {
    // Ignore
  }
  try {
    if (existsSync(API_KEY_FILE)) unlinkSync(API_KEY_FILE);
  } catch {
    // Ignore
  }
  console.log('[zedge] Logged out. Auth tokens cleared.');
}

/**
 * Get current user info
 */
export function whoami(): {
  authenticated: boolean;
  method?: 'token' | 'api-key';
  email?: string;
  expiresAt?: number;
  pendingAuth?: {
    userCode: string;
    verificationUri: string;
    verificationUriComplete: string;
    expiresAt: number;
    browserOpened: boolean;
  };
} {
  // Check token first
  try {
    if (existsSync(TOKEN_FILE)) {
      const token = JSON.parse(readFileSync(TOKEN_FILE, 'utf-8')) as AuthToken;
      if (token.expiresAt > Date.now()) {
        return {
          authenticated: true,
          method: 'token',
          email: token.email,
          expiresAt: token.expiresAt,
        };
      }
    }
  } catch {
    // Invalid token
  }

  // Check API key
  try {
    if (existsSync(API_KEY_FILE)) {
      const key = readFileSync(API_KEY_FILE, 'utf-8').trim();
      if (key.length > 0) {
        return {
          authenticated: true,
          method: 'api-key',
        };
      }
    }
  } catch {
    // No key
  }

  if (
    pendingDeviceAuthorization &&
    pendingDeviceAuthorization.expiresAt > Date.now()
  ) {
    return {
      authenticated: false,
      pendingAuth: {
        userCode: pendingDeviceAuthorization.userCode,
        verificationUri: pendingDeviceAuthorization.verificationUri,
        verificationUriComplete:
          pendingDeviceAuthorization.verificationUriComplete,
        expiresAt: pendingDeviceAuthorization.expiresAt,
        browserOpened: pendingDeviceAuthorization.browserOpened,
      },
    };
  }

  return { authenticated: false };
}
