/**
 * Moonshine container lifecycle for the Zedge companion sidecar.
 *
 * Starts the fat-station + openai-compat services at sidecar startup, then
 * waits for the /health endpoint to become ready.
 *
 * The preferred local path uses the repo-built fat-station binary and the
 * TypeScript OpenAI-compatible shim. Docker compose remains a fallback for
 * containerized environments.
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
const KNOT_PATH =
  process.env.ZEDGE_MOONSHINE_KNOT ??
  join(REPO_ROOT, 'open-source/bitwise/datasets/llama1b_fixed.knot');
const FAT_STATION_URL =
  process.env.ZEDGE_FAT_STATION_URL ?? 'http://127.0.0.1:8000';
const FAT_STATION_BIN =
  process.env.ZEDGE_FAT_STATION_BIN ??
  [
    join(
      REPO_ROOT,
      'open-source/gnosis/distributed-inference/target/release/fat-station'
    ),
    join(
      REPO_ROOT,
      'open-source/gnosis/distributed-inference/target/debug/fat-station'
    ),
  ].find((candidate) => existsSync(candidate));
const OPENAI_COMPAT_ENTRY = join(
  REPO_ROOT,
  'open-source/gnosis/distributed-inference-host/src/bin/openai-server.ts'
);
const OPENAI_COMPAT_CWD = join(
  REPO_ROOT,
  'open-source/gnosis/distributed-inference-host'
);
const TSX_CLI =
  process.env.ZEDGE_TSX_CLI ??
  [
    join(REPO_ROOT, 'node_modules/.pnpm/tsx@4.21.0/node_modules/tsx/dist/cli.mjs'),
    join(REPO_ROOT, 'node_modules/tsx/dist/cli.mjs'),
  ].find((candidate) => existsSync(candidate));

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

async function probeUrl(url: string): Promise<boolean> {
  try {
    const resp = await fetch(`${url}/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

async function waitUrlReady(
  url: string,
  timeoutMs = HEALTH_TIMEOUT_MS
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeUrl(url)) return true;
    await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
  }
  return false;
}

function spawnDetached(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
): void {
  const proc = spawn(command, args, {
    cwd: options.cwd,
    detached: true,
    env: {
      ...process.env,
      PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
      ...options.env,
    },
    stdio: 'ignore',
  });
  proc.unref();
}

async function startLocalMoonshine(): Promise<boolean> {
  if (!FAT_STATION_BIN || !existsSync(FAT_STATION_BIN)) {
    console.warn('[moonshine] local fat-station binary not found');
    return false;
  }
  if (!TSX_CLI || !existsSync(TSX_CLI)) {
    console.warn('[moonshine] local tsx CLI not found');
    return false;
  }
  if (!existsSync(KNOT_PATH)) {
    console.warn(`[moonshine] knot file not found: ${KNOT_PATH}`);
    return false;
  }

  if (!(await probeUrl(FAT_STATION_URL))) {
    console.log(`[moonshine] Starting local fat-station: ${FAT_STATION_BIN}`);
    spawnDetached(FAT_STATION_BIN, [
      '--knot',
      KNOT_PATH,
      '--port',
      '8000',
      '--role',
      'both',
      '--layers',
      '0..22',
    ]);
    if (!(await waitUrlReady(FAT_STATION_URL))) {
      console.warn('[moonshine] local fat-station did not become healthy');
      return false;
    }
  }

  console.log('[moonshine] Starting local OpenAI-compatible shim');
  spawnDetached(process.execPath, [TSX_CLI, OPENAI_COMPAT_ENTRY], {
    cwd: OPENAI_COMPAT_CWD,
    env: {
      FAT_STATION_URL,
      PORT: '8080',
      MODEL_NAME: 'gnosis-local',
      AGENTIC: '0',
      AUX_KNOT_PATH: KNOT_PATH,
    },
  });

  return await waitReady();
}

async function startDockerMoonshine(): Promise<boolean> {
  if (!existsSync(COMPOSE_FILE)) {
    console.warn(`[moonshine] compose file not found: ${COMPOSE_FILE} — set ZEDGE_MOONSHINE_COMPOSE_FILE to override`);
    return false;
  }

  console.log('[moonshine] Starting fat-station + openai-compat via docker compose...');
  try {
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
  } catch (error) {
    console.warn(`[moonshine] docker startup failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }

  console.log('[moonshine] Waiting for /health...');
  return await waitReady();
}

export async function ensureMoonshineRunning(): Promise<void> {
  if (await probe()) {
    console.log('[moonshine] OpenAI-compatible endpoint already running');
    return;
  }

  const ready = (await startLocalMoonshine()) || (await startDockerMoonshine());
  if (ready) {
    console.log('[moonshine] Ready');
  } else {
    console.warn('[moonshine] Did not become healthy within timeout — inference will fail until container is up');
  }
}
