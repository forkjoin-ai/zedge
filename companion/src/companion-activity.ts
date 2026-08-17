import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';

export type CompanionActivityKind =
  | 'forkjoin-chat'
  | 'skymesh-relay-chat'
  | 'moonshine-chat'
  | 'wasm-chat'
  | 'wasm-fim'
  | 'wasm-prewarm';

export interface CompanionActivityRecord {
  activityId: string;
  pid: number;
  kind: CompanionActivityKind;
  detail?: string;
  startedAt: number;
  updatedAt: number;
  busyUntil: number;
}

const DEFAULT_ACTIVITY_FILE = join(
  homedir(),
  '.edgework',
  'companion-activity.json'
);

function getActivityFilePath(): string {
  return process.env.ZEDGE_COMPANION_ACTIVITY_FILE ?? DEFAULT_ACTIVITY_FILE;
}

function ensureActivityDirectory(): void {
  mkdirSync(dirname(getActivityFilePath()), { recursive: true });
}

function isCompanionActivityRecord(
  value: unknown
): value is CompanionActivityRecord {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const record = value as Partial<CompanionActivityRecord>;
  return (
    typeof record.activityId === 'string' &&
    typeof record.pid === 'number' &&
    typeof record.kind === 'string' &&
    typeof record.startedAt === 'number' &&
    typeof record.updatedAt === 'number' &&
    typeof record.busyUntil === 'number'
  );
}

function isStaleCompanionActivity(
  activity: CompanionActivityRecord,
  now = Date.now()
): boolean {
  if (activity.busyUntil <= now) {
    return true;
  }
  return activity.pid !== process.pid;
}

/**
 * Remove a leftover activity file from a prior companion or hung inference.
 * Call on companion/supervisor boot before accepting traffic.
 */
export function clearCompanionActivityOnBoot(): void {
  const filePath = getActivityFilePath();
  if (!existsSync(filePath)) {
    return;
  }

  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (isCompanionActivityRecord(parsed)) {
      console.log(
        `[zedge:activity] clearing activity lock on boot (pid=${parsed.pid} kind=${parsed.kind} busyUntil=${parsed.busyUntil})`
      );
    } else {
      // console.log('[zedge:activity] clearing invalid activity lock on boot');
    }
  } catch {
    // console.log('[zedge:activity] clearing unreadable activity lock on boot');
  }

  try {
    rmSync(filePath, { force: true });
  } catch {
    // Best effort only.
  }
}

function readCompanionActivityRecord(): CompanionActivityRecord | null {
  const filePath = getActivityFilePath();
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    const raw = readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    return isCompanionActivityRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Drop expired or foreign-pid activity records without requiring a restart. */
export function clearStaleCompanionActivity(now = Date.now()): boolean {
  const filePath = getActivityFilePath();
  const activity = readCompanionActivityRecord();
  if (!activity || !isStaleCompanionActivity(activity, now)) {
    return false;
  }

  try {
    rmSync(filePath, { force: true });
  } catch {
    return false;
  }
  return true;
}

/**
 * Handles the zedge read Companion Activity workflow.
 */
export function readCompanionActivity(): CompanionActivityRecord | null {
  clearStaleCompanionActivity();
  return readCompanionActivityRecord();
}

/**
 * Handles the zedge get Owned Companion Activity workflow.
 */
export function getOwnedCompanionActivity(
  pid: number | null | undefined,
  now = Date.now()
): CompanionActivityRecord | null {
  if (!pid) {
    return null;
  }

  const activity = readCompanionActivity();
  if (!activity || activity.pid !== pid || activity.busyUntil <= now) {
    return null;
  }

  return activity;
}

/** True when this process holds the inference lock (moonshine/forkjoin chat). */
export function isCompanionInferenceBusy(
  now = Date.now()
): boolean {
  const activity = readCompanionActivity();
  if (
    !activity ||
    activity.pid !== process.pid ||
    activity.busyUntil <= now
  ) {
    return false;
  }
  return activity.kind === 'moonshine-chat' || activity.kind === 'forkjoin-chat';
}

/**
 * Handles the zedge mark Companion Activity workflow.
 */
export function markCompanionActivity(
  kind: CompanionActivityKind,
  busyWindowMs: number,
  detail?: string
): CompanionActivityRecord {
  const now = Date.now();
  const record: CompanionActivityRecord = {
    activityId: `${process.pid}:${now}:${Math.random()
      .toString(36)
      .slice(2, 10)}`,
    pid: process.pid,
    kind,
    detail,
    startedAt: now,
    updatedAt: now,
    busyUntil: now + Math.max(1, busyWindowMs),
  };

  ensureActivityDirectory();
  writeFileSync(getActivityFilePath(), JSON.stringify(record));
  return record;
}

/**
 * Handles the zedge clear Companion Activity workflow.
 */
export function clearCompanionActivity(
  expectedActivityId?: string,
  expectedPid = process.pid
): void {
  const filePath = getActivityFilePath();
  const activity = readCompanionActivity();
  if (!activity || activity.pid !== expectedPid) {
    return;
  }

  if (
    expectedActivityId !== undefined &&
    activity.activityId !== expectedActivityId
  ) {
    return;
  }

  try {
    rmSync(filePath, { force: true });
  } catch {
    // Best effort only.
  }
}

export async function runWithCompanionActivity<T>(
  kind: CompanionActivityKind,
  busyWindowMs: number,
  run: () => Promise<T>,
  detail?: string
): Promise<T> {
  const activity = markCompanionActivity(kind, busyWindowMs, detail);
  try {
    return await run();
  } finally {
    clearCompanionActivity(activity.activityId, activity.pid);
  }
}
