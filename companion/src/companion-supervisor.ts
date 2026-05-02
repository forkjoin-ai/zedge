#!/usr/bin/env bun

import { spawn, type ChildProcess } from 'child_process';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { getCompanionPort } from './config.ts';
import {
  COMPANION_STOP_TIMEOUT_MS,
  CONSECUTIVE_FAILURES_BEFORE_RESTART,
  HEALTH_CHECK_INTERVAL_MS,
  HEALTH_CHECK_TIMEOUT_MS,
  decideCompanionRestart,
} from './companion-restart-policy.ts';
import { getOwnedCompanionActivity } from './companion-activity.ts';
import { resolveTypeScriptEntrypointCommand } from './runtime-command.ts';

let childProc: ChildProcess | null = null;
let supervisorTimer: ReturnType<typeof setInterval> | null = null;
let childSpawnedAt = 0;
let consecutiveHealthFailures = 0;
let recentRestartTimestamps: number[] = [];
let restartInFlight: Promise<boolean> | null = null;
let suppressExitRestart = false;
let shuttingDown = false;
let healthCheckInFlight = false;
const COMPANION_STARTUP_ATTEMPTS = 240;

function getCompanionEntry(): string {
  // pnpm start runs from companion/ dir. Resolve relative to cwd.
  // AEON_ROOT overrides for monorepo-root invocation.
  if (process.env.AEON_ROOT) {
    return resolve(
      process.env.AEON_ROOT,
      'open-source/zedge/companion/src/index.ts'
    );
  }
  return resolve(process.cwd(), 'src/index.ts');
}

function getCompanionBase(): string {
  return `http://127.0.0.1:${getCompanionPort()}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isCompanionAlive(): Promise<boolean> {
  try {
    const response = await fetch(`${getCompanionBase()}/probe/ready`, {
      signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForCompanion(
  maxAttempts = COMPANION_STARTUP_ATTEMPTS
): Promise<boolean> {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (await isCompanionAlive()) {
      return true;
    }
    await sleep(500);
  }

  return false;
}

function spawnCompanion(): void {
  if (
    childProc &&
    childProc.exitCode === null &&
    childProc.signalCode === null
  ) {
    console.warn(
      '[zedge:supervisor] Refusing duplicate companion spawn while owned child is still active'
    );
    return;
  }

  const runtimeCommand = resolveTypeScriptEntrypointCommand(
    getCompanionEntry()
  );
  console.log(
    `[zedge:supervisor] Spawning companion: ${runtimeCommand.display}`
  );
  const child = spawn(runtimeCommand.command, [...runtimeCommand.args], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env },
  });
  childProc = child;
  childSpawnedAt = Date.now();
  consecutiveHealthFailures = 0;

  child.on('error', (error) => {
    console.warn(
      `[zedge:supervisor] Failed to spawn companion: ${error.message}`
    );
    if (childProc === child) {
      childProc = null;
    }
  });

  child.on('exit', (code, signal) => {
    console.log(
      `[zedge:supervisor] Companion exited with code ${code} signal ${
        signal ?? 'none'
      }`
    );
    if (childProc === child) {
      childProc = null;
    }
    if (!shuttingDown && !suppressExitRestart) {
      void restartCompanion('owned child exited unexpectedly', { force: true });
    }
  });
}

async function stopCompanion(): Promise<void> {
  const child = childProc;
  if (!child) {
    return;
  }

  suppressExitRestart = true;
  const exitPromise = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once('exit', () => resolve());
  });

  try {
    child.kill('SIGTERM');
  } catch {
    // Best-effort shutdown only.
  }

  const exitedGracefully = await Promise.race([
    exitPromise.then(() => true),
    sleep(COMPANION_STOP_TIMEOUT_MS).then(() => false),
  ]);

  if (
    !exitedGracefully &&
    child.exitCode === null &&
    child.signalCode === null
  ) {
    try {
      child.kill('SIGKILL');
    } catch {
      // Best-effort hard stop only.
    }
    await Promise.race([exitPromise, sleep(1_000)]);
  }

  if (childProc === child) {
    childProc = null;
  }
  suppressExitRestart = false;
}

async function restartCompanion(
  reason: string,
  options: { force?: boolean } = {}
): Promise<boolean> {
  if (restartInFlight) {
    return restartInFlight;
  }

  restartInFlight = (async () => {
    const busyActivity = getOwnedCompanionActivity(childProc?.pid);
    const decision = decideCompanionRestart({
      now: Date.now(),
      activityBusyUntil: busyActivity?.busyUntil ?? null,
      companionSpawnedAt: childSpawnedAt,
      consecutiveFailures: consecutiveHealthFailures,
      restartTimestamps: recentRestartTimestamps,
      force: options.force,
    });
    recentRestartTimestamps = decision.restartTimestamps;

    if (!decision.shouldRestart) {
      if (decision.reason === 'busy' && busyActivity) {
        console.debug(
          `[zedge:supervisor] Companion busy with ${
            busyActivity.kind
          }; skipping restart until ${new Date(
            busyActivity.busyUntil
          ).toISOString()}`
        );
      } else if (decision.reason === 'startup_grace') {
        console.debug(
          '[zedge:supervisor] Skipping restart during companion startup grace window'
        );
      } else if (decision.reason === 'rate_limited') {
        console.warn(
          `[zedge:supervisor] Restart suppressed after ${recentRestartTimestamps.length} restarts in the last 60s`
        );
      }
      return false;
    }

    console.log(`[zedge:supervisor] Restarting companion: ${reason}`);
    await stopCompanion();
    spawnCompanion();

    const alive = await waitForCompanion();
    if (!alive) {
      console.warn(
        '[zedge:supervisor] Companion did not become healthy after restart'
      );
      return false;
    }

    consecutiveHealthFailures = 0;
    console.log('[zedge:supervisor] Companion healthy after restart');
    return true;
  })().finally(() => {
    restartInFlight = null;
  });

  return restartInFlight;
}

function startSupervisor(): void {
  if (supervisorTimer) {
    return;
  }

  supervisorTimer = setInterval(async () => {
    if (healthCheckInFlight || restartInFlight) {
      return;
    }

    healthCheckInFlight = true;
    try {
      const alive = await isCompanionAlive();
      if (alive) {
        consecutiveHealthFailures = 0;
        return;
      }

      consecutiveHealthFailures += 1;

      const busyActivity = getOwnedCompanionActivity(childProc?.pid);
      if (busyActivity) {
        console.debug(
          `[zedge:supervisor] Health check failed during ${busyActivity.kind} (${consecutiveHealthFailures}/${CONSECUTIVE_FAILURES_BEFORE_RESTART})`
        );
      }
      console.warn(
        `[zedge:supervisor] Companion health check failed (${consecutiveHealthFailures}/${CONSECUTIVE_FAILURES_BEFORE_RESTART})`
      );
      await restartCompanion(
        `health check failed ${consecutiveHealthFailures} consecutive times`
      );
    } finally {
      healthCheckInFlight = false;
    }
  }, HEALTH_CHECK_INTERVAL_MS);
}

async function runSupervisor(): Promise<void> {
  if (await isCompanionAlive()) {
    console.log(
      `[zedge:supervisor] Companion already healthy at ${getCompanionBase()}; adopting as unowned (will restart on failure)`
    );
  } else {
    spawnCompanion();
    const alive = await waitForCompanion();
    if (!alive) {
      throw new Error(
        `Companion sidecar did not become healthy at ${getCompanionBase()}`
      );
    }
    console.log('[zedge:supervisor] Companion sidecar is ready');
  }

  startSupervisor();
}

let shutdownResolve: (() => void) | null = null;

async function runSupervisorEntry(): Promise<number> {
  registerShutdownHandlers();
  await runSupervisor();
  await new Promise<void>((resolve) => {
    shutdownResolve = resolve;
  });
  return 0;
}

export async function main(): Promise<number> {
  return await runSupervisorEntry();
}

function registerShutdownHandlers(): void {
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log(`[zedge:supervisor] Shutting down (${signal})`);
    if (supervisorTimer) {
      clearInterval(supervisorTimer);
      supervisorTimer = null;
    }
    await stopCompanion();
    shutdownResolve?.();
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('exit', () => {
    shuttingDown = true;
    if (supervisorTimer) {
      clearInterval(supervisorTimer);
      supervisorTimer = null;
    }
    if (childProc && !childProc.killed) {
      try {
        childProc.kill('SIGTERM');
      } catch {
        // Best effort only.
      }
    }
  });
}

function isExecutedDirectly(importMetaUrl: string): boolean {
  if (process.env.GNODE_RUNTIME === '1') {
    return false;
  }

  const entryPath = process.argv[1];
  if (!entryPath) {
    return false;
  }

  return resolve(fileURLToPath(importMetaUrl)) === resolve(entryPath);
}

if (isExecutedDirectly(import.meta.url)) {
  main().catch((error) => {
    console.error(
      `[zedge:supervisor] Fatal error: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    process.exit(1);
  });
}
