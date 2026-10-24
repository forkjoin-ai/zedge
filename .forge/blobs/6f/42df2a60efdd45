/**
 * Guarded subagent client for the Zedge companion sidecar.
 *
 * This is the DEFAULT inference hotpath passthrough: instead of bare-spawning
 * the fat-station as a detached child, the companion births and reaps it as a
 * UCAN-leased, sandboxed subagent through the monster-swarm / monster-resident
 * producer surface (`open-source/gnosis`).
 *
 * Two integration shapes are described in the consumer map
 * (`distributed-inference-host/ZEDGE_CONSUMER_MAP.md`). This implements the
 * recommended Shape B: shell out to the `monster-swarm` CLI, which shares the
 * same `ops` core that monster-resident's `subagent_create` / `subagent_reap`
 * MCP tools call. The CLI is the minimum-blast-radius surface — it takes the
 * exact same `{ ucan, node, caste, caps, lease, grant-ttl, -- node_args }`
 * contract and resolves the node through the `MONSTER_SWARM_NODES` / `DI_BIN_DIR`
 * allowlist under `monster-guard`.
 *
 * Reversibility: everything here is gated behind `ZEDGE_GUARDED_SUBAGENT`.
 * The default (unset) is guarded. `ZEDGE_GUARDED_SUBAGENT=0` opts out and the
 * caller falls back to the legacy bare spawn. If a required piece of the
 * guarded path is missing (binary, knot allowlist, fleet UCAN) we log a clear
 * warning and report "not available" so the caller falls back to legacy rather
 * than hard-failing the editor.
 */

import { execFile } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const GNOSIS_ROOT_FROM_REPO = 'open-source/gnosis';

/** Resolves the first existing candidate path, or undefined. */
function firstExisting(candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** Expands a leading `~` to the user's home directory. */
function expandHome(value: string): string {
  if (value === '~') return homedir();
  if (value.startsWith('~/')) return join(homedir(), value.slice(2));
  return value;
}

export interface GuardedSubagentEnv {
  /** monster-swarm CLI binary path. */
  swarmBin: string;
  /** monster-guard binary path (passed to the spawn as MONSTER_GUARD_BIN). */
  guardBin: string;
  /** Node allowlist directory (MONSTER_SWARM_NODES + DI_BIN_DIR). */
  nodesDir: string;
  /** Shared guard state home (MONSTER_GUARD_HOME, default ~/.moonshine.d). */
  guardHome: string;
  /** The fleet UCAN token used to authorize agent/* on agent:fleet. */
  fleetUcan: string;
}

export interface GuardedSpawnRequest {
  /** Node binary name resolved by the allowlist, e.g. "fat-station". */
  node: string;
  /** Stable subagent id so reap/reconcile can target it. */
  id: string;
  /** Caste: "breeder" is persistent (the editor's model host), "scout" is ephemeral. */
  caste: 'scout' | 'breeder';
  /** Capabilities granted to the node, e.g. ["net"]. */
  caps: string[];
  /** Lease duration in seconds; the node dies at the next tick past this. */
  leaseSecs: number;
  /** Grant TTL in seconds for the per-subagent delegated capability. */
  grantTtlSecs?: number;
  /** Hard ceiling in seconds (optional). */
  maxSecs?: number;
  /**
   * The node argv after `--`. These are byte-for-byte the flags the legacy bare
   * spawn passed to fat-station (e.g. --knot <path> --port 8000 --role both
   * --layers 0..28).
   */
  nodeArgs: string[];
  /** Extra env to set on the spawn launcher (inherited by the node). */
  extraEnv?: NodeJS.ProcessEnv;
}

export interface GuardedSpawnResult {
  ok: boolean;
  /** Raw stdout line from the CLI ("monster-swarm: spawned ..."). */
  output?: string;
  error?: string;
}

const REASON_OPTED_OUT = 'ZEDGE_GUARDED_SUBAGENT=0 (legacy bare spawn)';

/**
 * Returns true unless the operator explicitly opted out with
 * `ZEDGE_GUARDED_SUBAGENT=0` (or `false`/`off`/`no`). Default (unset) = guarded.
 */
export function isGuardedSubagentEnabled(): boolean {
  const raw = process.env.ZEDGE_GUARDED_SUBAGENT?.trim().toLowerCase();
  if (raw === undefined || raw === '') return true;
  return !(raw === '0' || raw === 'false' || raw === 'off' || raw === 'no');
}

/** Human-readable explanation of why the guarded path is/ isn't engaged. */
export function guardedSubagentDisabledReason(): string | undefined {
  return isGuardedSubagentEnabled() ? undefined : REASON_OPTED_OUT;
}

/**
 * Resolves the guarded-path environment from explicit env overrides, then
 * sensible defaults rooted at the monorepo + ~/.edgework. Returns either a
 * fully-resolved env or a list of human-readable missing pieces. Never throws.
 */
export function resolveGuardedSubagentEnv(repoRoot: string): {
  env?: GuardedSubagentEnv;
  missing: string[];
} {
  const gnosisRoot = join(repoRoot, GNOSIS_ROOT_FROM_REPO);
  const missing: string[] = [];

  const swarmBin = firstExisting([
    process.env.ZEDGE_MONSTER_SWARM_BIN?.trim() ?? '',
    join(gnosisRoot, 'monster-swarm/target/release/monster-swarm'),
    join(gnosisRoot, 'monster-swarm/target/debug/monster-swarm'),
  ]);
  if (!swarmBin) {
    missing.push(
      'monster-swarm binary (set ZEDGE_MONSTER_SWARM_BIN or build monster-swarm)'
    );
  }

  const guardBin = firstExisting([
    process.env.ZEDGE_MONSTER_GUARD_BIN?.trim() ??
      process.env.MONSTER_GUARD_BIN?.trim() ??
      '',
    join(gnosisRoot, 'monster-guard/target/release/monster-guard'),
    join(gnosisRoot, 'monster-guard/target/debug/monster-guard'),
  ]);
  if (!guardBin) {
    missing.push(
      'monster-guard binary (set ZEDGE_MONSTER_GUARD_BIN or build monster-guard)'
    );
  }

  // Node allowlist directory: must contain the fat-station binary so the guard
  // can resolve `node: "fat-station"`. Fails closed if unset (guard.rs:65-69).
  const nodesDir = firstExisting([
    process.env.ZEDGE_MONSTER_SWARM_NODES?.trim() ??
      process.env.MONSTER_SWARM_NODES?.trim() ??
      process.env.DI_BIN_DIR?.trim() ??
      '',
    join(gnosisRoot, 'distributed-inference/target/release'),
    join(gnosisRoot, 'distributed-inference/target/debug'),
  ]);
  if (!nodesDir) {
    missing.push(
      'node allowlist dir (set ZEDGE_MONSTER_SWARM_NODES / DI_BIN_DIR to the dir holding fat-station)'
    );
  }

  const guardHome = expandHome(
    process.env.MONSTER_GUARD_HOME?.trim() ?? join(homedir(), '.moonshine.d')
  );

  const fleetUcan = resolveFleetUcan();
  if (!fleetUcan) {
    missing.push(
      'fleet UCAN (set ZEDGE_FLEET_UCAN to the token, or ZEDGE_FLEET_UCAN_FILE / ~/.edgework/fleet.ucan to a file; ' +
        'mint via `monster-resident grant --with agent:fleet --can agent/* --caps net`)'
    );
  }

  if (!swarmBin || !guardBin || !nodesDir || !fleetUcan) {
    return { missing };
  }

  return {
    env: { swarmBin, guardBin, nodesDir, guardHome, fleetUcan },
    missing,
  };
}

/**
 * Resolves the fleet UCAN token. Order: ZEDGE_FLEET_UCAN (inline token),
 * ZEDGE_FLEET_UCAN_FILE (path), then ~/.edgework/fleet.ucan. Returns the token
 * string or undefined. A file is read and trimmed.
 */
function resolveFleetUcan(): string | undefined {
  const inline = process.env.ZEDGE_FLEET_UCAN?.trim();
  if (inline) return inline;

  const candidates = [
    process.env.ZEDGE_FLEET_UCAN_FILE?.trim() ?? '',
    join(homedir(), '.edgework', 'fleet.ucan'),
  ].map(expandHome);

  for (const path of candidates) {
    if (path && existsSync(path)) {
      try {
        const token = readFileSync(path, 'utf8').trim();
        if (token) return token;
      } catch {
        // fall through; treated as missing
      }
    }
  }
  return undefined;
}

/** Builds the env handed to the monster-swarm CLI process. */
function guardLauncherEnv(
  env: GuardedSubagentEnv,
  extraEnv?: NodeJS.ProcessEnv
): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    MONSTER_GUARD_HOME: env.guardHome,
    MONSTER_GUARD_BIN: env.guardBin,
    MONSTER_SWARM_NODES: env.nodesDir,
    DI_BIN_DIR: env.nodesDir,
    ...extraEnv,
  };
}

/** Runs the monster-swarm CLI and resolves with {code, stdout, stderr}. */
function runSwarm(
  env: GuardedSubagentEnv,
  args: string[],
  extraEnv?: NodeJS.ProcessEnv
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      env.swarmBin,
      args,
      {
        env: guardLauncherEnv(env, extraEnv),
        maxBuffer: 8 * 1024 * 1024,
        timeout: 30_000,
      },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as { code?: unknown }).code === 'number'
            ? ((error as { code: number }).code as number)
            : error
              ? 1
              : 0;
        resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' });
      }
    );
  });
}

/**
 * Births the fat-station as a UCAN-leased, sandboxed subagent.
 *
 * Mirrors monster-resident's `subagent_create`: this is the guarded equivalent
 * of the legacy `spawnDetached(FAT_STATION_BIN, ...)`. The node serves on the
 * port given in `nodeArgs` exactly as before, so the OpenAI shim step is
 * unchanged.
 */
export async function guardedSubagentCreate(
  env: GuardedSubagentEnv,
  req: GuardedSpawnRequest
): Promise<GuardedSpawnResult> {
  const args = [
    'spawn',
    '--ucan',
    env.fleetUcan,
    '--node',
    req.node,
    '--id',
    req.id,
    '--caste',
    req.caste,
  ];
  if (req.caps.length > 0) {
    args.push('--caps', req.caps.join(','));
  }
  args.push('--lease', String(req.leaseSecs));
  if (req.maxSecs !== undefined) {
    args.push('--max', String(req.maxSecs));
  }
  if (req.grantTtlSecs !== undefined) {
    args.push('--grant-ttl', String(req.grantTtlSecs));
  }
  // Node argv after `--` — byte-for-byte the legacy fat-station flags.
  args.push('--', ...req.nodeArgs);

  const { code, stdout, stderr } = await runSwarm(env, args, req.extraEnv);
  if (code === 0) {
    return { ok: true, output: stdout.trim() };
  }
  return {
    ok: false,
    error: (stderr.trim() || stdout.trim() || `monster-swarm spawn exited ${code}`).slice(
      0,
      2000
    ),
  };
}

/**
 * Reaps (revokes) a leased subagent by id. The node dies at the next lease
 * tick. Mirrors monster-resident's `subagent_reap`.
 */
export async function guardedSubagentReap(
  env: GuardedSubagentEnv,
  id: string
): Promise<GuardedSpawnResult> {
  const { code, stdout, stderr } = await runSwarm(env, [
    'reap',
    '--ucan',
    env.fleetUcan,
    '--id',
    id,
  ]);
  if (code === 0) {
    return { ok: true, output: stdout.trim() };
  }
  return {
    ok: false,
    error: (stderr.trim() || stdout.trim() || `monster-swarm reap exited ${code}`).slice(
      0,
      2000
    ),
  };
}

export interface FleetSubagent {
  id: string;
  caste?: string;
  pid?: number | null;
  node_bin?: string;
  lease_secs?: number;
}

export interface FleetState {
  subagents: FleetSubagent[];
}

/**
 * Reads fleet state via `monster-swarm list --json` (no UCAN required).
 * Returns undefined on any failure so callers can fall back to port probing.
 */
export async function guardedSubagentList(
  env: GuardedSubagentEnv
): Promise<FleetState | undefined> {
  const { code, stdout } = await runSwarm(env, ['list', '--json']);
  if (code !== 0) return undefined;
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      Array.isArray((parsed as { subagents?: unknown }).subagents)
    ) {
      return parsed as FleetState;
    }
  } catch {
    // fall through
  }
  return undefined;
}

/** Returns true if a live subagent with the given id is present in the fleet. */
export async function guardedSubagentIsLive(
  env: GuardedSubagentEnv,
  id: string
): Promise<boolean> {
  const fleet = await guardedSubagentList(env);
  if (!fleet) return false;
  return fleet.subagents.some(
    (s) => s.id === id && s.pid !== null && s.pid !== undefined
  );
}
