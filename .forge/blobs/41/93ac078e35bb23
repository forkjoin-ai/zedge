import { afterEach, beforeEach, describe, expect, test } from '@a0n/gnosis/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  clearCompanionActivity,
  clearCompanionActivityOnBoot,
  clearStaleCompanionActivity,
  getOwnedCompanionActivity,
  isCompanionInferenceBusy,
  markCompanionActivity,
  readCompanionActivity,
} from '../companion-activity';

describe('companion activity tracking', () => {
  let previousActivityFile: string | undefined;

  beforeEach(() => {
    previousActivityFile = process.env.ZEDGE_COMPANION_ACTIVITY_FILE;
    process.env.ZEDGE_COMPANION_ACTIVITY_FILE = join(
      mkdtempSync(join(tmpdir(), 'zedge-activity-')),
      'companion-activity.json'
    );
  });

  afterEach(() => {
    if (previousActivityFile === undefined) {
      delete process.env.ZEDGE_COMPANION_ACTIVITY_FILE;
    } else {
      process.env.ZEDGE_COMPANION_ACTIVITY_FILE = previousActivityFile;
    }
  });

  test('reads back the owned busy activity while it is still fresh', () => {
    const activity = markCompanionActivity('wasm-chat', 5_000, 'chat');

    expect(readCompanionActivity()).toEqual(activity);
    expect(
      getOwnedCompanionActivity(process.pid, activity.startedAt + 1)
    ).toEqual(activity);
  });

  test('ignores stale or mismatched activity records', () => {
    const activity = markCompanionActivity('wasm-prewarm', 50, 'startup');

    expect(
      getOwnedCompanionActivity(process.pid + 1, activity.startedAt + 1)
    ).toBe(null);
    expect(getOwnedCompanionActivity(process.pid, activity.busyUntil + 1)).toBe(
      null
    );
  });

  test('does not clear a newer activity when an older scope finishes', () => {
    const first = markCompanionActivity('wasm-prewarm', 5_000, 'startup');
    const second = markCompanionActivity('wasm-chat', 5_000, 'request');

    clearCompanionActivity(first.activityId, first.pid);

    expect(readCompanionActivity()).toEqual(second);
  });

  test('clearCompanionActivityOnBoot removes an existing lock file', () => {
    markCompanionActivity('moonshine-chat', 5_000, 'stuck');

    clearCompanionActivityOnBoot();

    expect(readCompanionActivity()).toBeNull();
  });

  test('clearStaleCompanionActivity drops foreign-pid locks', () => {
    markCompanionActivity('moonshine-chat', 60_000, 'other-process');
    const filePath = process.env.ZEDGE_COMPANION_ACTIVITY_FILE!;
    const raw = JSON.parse(readFileSync(filePath, 'utf-8') as string) as {
      pid: number;
    };
    writeFileSync(
      filePath,
      JSON.stringify({ ...raw, pid: process.pid + 9_999 })
    );

    expect(clearStaleCompanionActivity()).toBe(true);
    expect(readCompanionActivity()).toBeNull();
  });

  test('isCompanionInferenceBusy ignores locks owned by another pid', () => {
    const filePath = process.env.ZEDGE_COMPANION_ACTIVITY_FILE!;
    markCompanionActivity('moonshine-chat', 60_000, 'stuck');
    const record = JSON.parse(readFileSync(filePath, 'utf-8') as string) as {
      pid: number;
      busyUntil: number;
    };
    writeFileSync(
      filePath,
      JSON.stringify({
        ...record,
        pid: process.pid + 9_999,
        busyUntil: Date.now() + 60_000,
      })
    );

    expect(isCompanionInferenceBusy()).toBe(false);
  });
});
