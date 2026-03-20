/**
 * Zedge Auth Flow
 *
 * Opens browser OAuth, stores token in ~/.edgework/
 * Reuses the same auth infrastructure as edgework-cli.
 *
 * Usage:
 *   bunx zedge login
 *   bunx zedge logout
 *   bunx zedge whoami
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
import { createServer } from 'http';
import { getEdgeworkConfig } from './config';

const CONFIG_DIR = join(homedir(), '.edgework');
const TOKEN_FILE = join(CONFIG_DIR, 'token.json');
const API_KEY_FILE = join(CONFIG_DIR, 'api-key');

interface AuthToken {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  userId: string;
  email: string;
}

function ensureConfigDir(): void {
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }
}

/**
 * Start OAuth login flow
 *
 * 1. Opens browser to auth endpoint
 * 2. Starts local HTTP server on random port to receive callback
 * 3. Exchanges auth code for token
 * 4. Stores token in ~/.edgework/token.json
 */
export async function login(): Promise<{
  success: boolean;
  email?: string;
  error?: string;
}> {
  const config = getEdgeworkConfig();
  const callbackPort = 7340 + Math.floor(Math.random() * 100);
  const redirectUri = `http://localhost:${callbackPort}/callback`;

  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? '/', `http://localhost:${callbackPort}`);

      if (url.pathname === '/callback') {
        const code = url.searchParams.get('code');
        const error = url.searchParams.get('error');

        if (error) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(
            '<html><body><h1>Login Failed</h1><p>You can close this window.</p></body></html>'
          );
          server.close();
          resolve({ success: false, error });
          return;
        }

        if (!code) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(
            '<html><body><h1>No Auth Code</h1><p>You can close this window.</p></body></html>'
          );
          server.close();
          resolve({ success: false, error: 'No auth code received' });
          return;
        }

        // Exchange code for token
        try {
          const tokenResp = await fetch(`${config.apiBaseUrl}/auth/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              code,
              redirect_uri: redirectUri,
              grant_type: 'authorization_code',
            }),
          });

          if (!tokenResp.ok) {
            throw new Error(`Token exchange failed: ${tokenResp.status}`);
          }

          const tokenData = (await tokenResp.json()) as {
            access_token: string;
            refresh_token?: string;
            expires_in: number;
            user_id: string;
            email: string;
          };

          const token: AuthToken = {
            accessToken: tokenData.access_token,
            refreshToken: tokenData.refresh_token,
            expiresAt: Date.now() + tokenData.expires_in * 1000,
            userId: tokenData.user_id,
            email: tokenData.email,
          };

          ensureConfigDir();
          writeFileSync(TOKEN_FILE, JSON.stringify(token, null, 2), {
            mode: 0o600,
          });

          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(
            `<html><body><h1>Login Successful</h1><p>Logged in as ${token.email}. You can close this window.</p></body></html>`
          );
          server.close();
          resolve({ success: true, email: token.email });
        } catch (err) {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(
            '<html><body><h1>Login Failed</h1><p>Token exchange error. You can close this window.</p></body></html>'
          );
          server.close();
          resolve({
            success: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    });

    server.listen(callbackPort, () => {
      const authUrl = `${
        config.apiBaseUrl
      }/auth/login?redirect_uri=${encodeURIComponent(
        redirectUri
      )}&client=zedge`;

      // Open browser
      /* eslint-disable @typescript-eslint/no-require-imports */
      const { exec } = require('child_process');
      /* eslint-enable @typescript-eslint/no-require-imports */
      const openCmd =
        process.platform === 'darwin'
          ? 'open'
          : process.platform === 'win32'
          ? 'start'
          : 'xdg-open';

      exec(`${openCmd} "${authUrl}"`, (err: Error | null) => {
        if (err) {
          console.log(`[zedge] Open this URL in your browser:\n  ${authUrl}`);
        } else {
          console.log('[zedge] Browser opened for authentication...');
        }
      });

      // Timeout after 5 minutes
      setTimeout(() => {
        server.close();
        resolve({
          success: false,
          error: 'Login timed out after 5 minutes',
        });
      }, 300_000);
    });
  });
}

/**
 * Logout — clear tokens and API key
 */
export function logout(): void {
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

  return { authenticated: false };
}
