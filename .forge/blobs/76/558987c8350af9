import { test, expect } from '@a0n/gnosis/test';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('source launcher preserves service main, literal argv and child exit through Monster', () => {
  const root = mkdtempSync(join(tmpdir(), 'zedge launcher '));
  try {
    const scripts = join(root, 'open-source/zedge/scripts');
    const bin = join(root, 'open-source/gnosis/bin');
    mkdirSync(scripts, { recursive: true });
    mkdirSync(bin, { recursive: true });
    const launcher = join(scripts, 'run-ts-entry.sh');
    copyFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../scripts/run-ts-entry.sh'), launcher);
    writeFileSync(join(bin, 'monster'), '#!/bin/sh\nprintf "%s\\0" "$MONSTER_NODE_RUNTIME" "$@"\nexit 37\n', { mode: 0o755 });
    const entry = join(root, 'open-source/zedge/companion/src/index.ts');
    const result = spawnSync('/bin/sh', [launcher, entry, 'two words', '$(not-a-command)', '--flag=value'], {
      env: { ...process.env, ZEDGE_NODE_RUNTIME: process.execPath }, encoding: 'utf8', timeout: 5000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(37);
    expect(result.stdout.split('\0').slice(0, -1)).toEqual([
      process.execPath, 'run', entry, '--export', 'main', '--', 'two words', '$(not-a-command)', '--flag=value',
    ]);
    expect(result.stderr).toBe('');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
