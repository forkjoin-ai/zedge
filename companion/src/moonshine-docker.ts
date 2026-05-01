/**
 * Moonshine container lifecycle for the Zedge companion sidecar.
 *
 * Starts the fat-station + openai-compat services from docker-compose.moonshine.yml
 * at sidecar startup, then waits for the /health endpoint to become ready.
 * Set ZEDGE_MOONSHINE_COMPOSE_FILE to override the compose file path.
 */

import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __here = dirname(fileURLToPath(import.meta.url));
// companion/src → companion → zedge → open-source → repo root
const REPO_ROOT = join(__here, '..', '..', '..', '..');
const COMPOSE_FILE =
  process.env.ZEDGE_MOONSHINE_COMPOSE_FILE ??
  join(REPO_ROOT, 'docker-compose.moonshine.yml');

const MOONSHINE_URL = process.env.ZEDGE_MOONSHINE_URL ?? 'http://127.0.0.1:8080';
const HEALTH_POLL_MS = 2_000;
const HEALTH_TIMEOUT_MS = 90_000;

async function probe(): Promise<boolean> {
  try {
    const resp = await fetch(`${MOONSHINE_URL}/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

async function waitReady(timeoutMs = HEALTH_TIMEOUT_MS): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return true;
    await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
  }
  return false;
}

export async function ensureMoonshineRunning(): Promise<void> {
  if (!existsSync(COMPOSE_FILE)) {
    console.warn(`[moonshine] compose file not found: ${COMPOSE_FILE} — set ZEDGE_MOONSHINE_COMPOSE_FILE to override`);
    return;
  }

  if (await probe()) {
    console.log('[moonshine] Container already running');
    return;
  }

  console.log('[moonshine] Starting fat-station + openai-compat...');
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(
      'docker',
      ['compose', '-f', COMPOSE_FILE, 'up', '-d', 'fat-station', 'openai-compat'],
      { stdio: 'inherit' }
    );
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`docker compose up exited with code ${code}`));
    });
    proc.on('error', reject);
  });

  console.log('[moonshine] Waiting for /health...');
  const ready = await waitReady();
  if (ready) {
    console.log('[moonshine] Ready');
  } else {
    console.warn('[moonshine] Did not become healthy within timeout — inference will fail until container is up');
  }
}
