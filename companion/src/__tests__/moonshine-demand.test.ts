import { describe, expect, test } from '@a0n/gnosis/test';
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { isExactSkymeshModel } from '../model-catalog.ts';
import {
  armMoonshineDemand,
  isMoonshineDemandArmed,
  moonshineWatchdogShouldRepair,
  resetMoonshineDemandForTests,
} from '../moonshine-docker.ts';

const here = dirname(fileURLToPath(import.meta.url));

describe('moonshine fat-station demand gate', () => {
  test('watchdog stays idle until an explicit ensure arms demand', () => {
    resetMoonshineDemandForTests();
    expect(isMoonshineDemandArmed()).toBe(false);
    expect(
      moonshineWatchdogShouldRepair({
        demandArmed: false,
        inferenceBusy: false,
        runtimeReady: false,
      }),
    ).toBe('idle');
    expect(
      moonshineWatchdogShouldRepair({
        demandArmed: true,
        inferenceBusy: true,
        runtimeReady: false,
      }),
    ).toBe('busy');
    expect(
      moonshineWatchdogShouldRepair({
        demandArmed: true,
        inferenceBusy: false,
        runtimeReady: true,
      }),
    ).toBe('ready');
    expect(
      moonshineWatchdogShouldRepair({
        demandArmed: true,
        inferenceBusy: false,
        runtimeReady: false,
      }),
    ).toBe('repair');

    armMoonshineDemand();
    expect(isMoonshineDemandArmed()).toBe(true);
    resetMoonshineDemandForTests();
    expect(isMoonshineDemandArmed()).toBe(false);
  });

  test('companion boot starts the watchdog but does not ensure moonshine', () => {
    const source = readFileSync(join(here, '..', 'index.ts'), 'utf8');
    const start = source.indexOf(
      'async function startMoonshineAndSyncZedSettings',
    );
    const end = source.indexOf('export async function main');
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const boot = source.slice(start, end);
    expect(boot).toContain('startMoonshineRuntimeWatchdog');
    expect(boot).not.toContain('ensureMoonshineRunning');
  });

  test('SSM CF skymesh default is not a local fat-station knot', () => {
    expect(isExactSkymeshModel('rwkv7-mini')).toBe(true);
    expect(isExactSkymeshModel('mistral-7b')).toBe(false);
  });
});
