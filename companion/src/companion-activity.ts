import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

export type CompanionActivityKind =
  | 'forkjoin-chat'
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ACTIVITY_DIR = join(__dirname, '..', '..', '.edgework');
const DEFAULT_ACTIVITY_FILE = join(
  DEFAULT_ACTIVITY_DIR,
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

export function readCompanionActivity(): CompanionActivityRecord | null {
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

/** True when any companion process holds the inference lock (moonshine/forkjoin chat). */
export function isCompanionInferenceBusy(
  now = Date.now()
): boolean {
  const activity = readCompanionActivity();
  if (!activity || activity.busyUntil <= now) {
    return false;
  }
  return activity.kind === 'moonshine-chat' || activity.kind === 'forkjoin-chat';
}

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
