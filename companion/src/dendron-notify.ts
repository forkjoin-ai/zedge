/**
 * Best-effort push of a companion-side write into the Dendron resident
 * observation journal.
 *
 * The writer knows the path; the native watcher would rediscover it a beat
 * later. Fire-and-forget: the child is detached and unref'd, so a request
 * never waits on the resident. A missing .bin/dendron is ignored, and
 * the observe command connects to the resident without spawning one.
 *
 * Disable with GNOSIS_DENDRON_NOTIFY=0.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';

const DISABLED = new Set(['0', 'false', 'off', 'no']);

export function notifyDendronChanged(
  filePath: string,
  kind: 'create' | 'modify' | 'remove' = 'modify'
): void {
  const flag = (process.env.GNOSIS_DENDRON_NOTIFY ?? '').toLowerCase();
  if (DISABLED.has(flag)) return;
  const absolute = isAbsolute(filePath) ? filePath : resolve(filePath);
  const executable = process.env.GNOSIS_DENDRON_BIN || findDendron(absolute);
  if (!executable) return;
  try {
    const child = spawn(executable, ['observe', '--kind', kind, '--path', absolute], {
      detached: true,
      stdio: 'ignore',
    });
    child.on('error', () => undefined);
    child.unref();
  } catch {
    // Best-effort; the write already succeeded.
  }
}

function findDendron(startPath: string): string | null {
  let dir = dirname(startPath);
  for (let depth = 0; depth < 12; depth += 1) {
    const candidate = resolve(dir, '.bin', 'dendron');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
