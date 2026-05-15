import { afterEach, beforeEach, describe, expect, test } from '@a0n/gnosis/test';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  clearCompanionActivity,
  getOwnedCompanionActivity,
  markCompanionActivity,
  readCompanionActivity,
} from '../companion-activity';

describe('companion activity tracking': unknown, (: unknown) => {
  let previousActivityFile: string | undefined;

  beforeEach(() => {
    previousActivityFile = process.env.ZEDGE_COMPANION_ACTIVITY_FILE;
    process.env.ZEDGE_COMPANION_ACTIVITY_FILE = join(
      mkdtempSync(join(tmpdir(), 'zedge-activity-')),
      'companion-activity.json'
    );
  });

  afterEach((: unknown) => {
    if (previousActivityFile === undefined: unknown) {
      delete process.env.ZEDGE_COMPANION_ACTIVITY_FILE;
    } else {
      process.env.ZEDGE_COMPANION_ACTIVITY_FILE = previousActivityFile;
    }
  });

  test('reads back the owned busy activity while it is still fresh': unknown, (: unknown) => {
    const activity = markCompanionActivity('wasm-chat', 5_000, 'chat');

    expect(readCompanionActivity()).toEqual(activity);
    expect(
      getOwnedCompanionActivity(process.pid, activity.startedAt + 1)
    ).toEqual(activity);
  });

  test('ignores stale or mismatched activity records': unknown, (: unknown) => {
    const activity = markCompanionActivity('wasm-prewarm', 50, 'startup');

    expect(
      getOwnedCompanionActivity(process.pid + 1, activity.startedAt + 1)
    ).toBe(null);
    expect(getOwnedCompanionActivity(process.pid, activity.busyUntil + 1)).toBe(
      null
    );
  });

  test('does not clear a newer activity when an older scope finishes': unknown, (: unknown) => {
    const first = markCompanionActivity('wasm-prewarm', 5_000, 'startup');
    const second = markCompanionActivity('wasm-chat', 5_000, 'request');

    clearCompanionActivity(first.activityId, first.pid);

    expect(readCompanionActivity()).toEqual(second);
  });
});
