import { existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

export interface TypeScriptEntrypointCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly display: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const TS_ENTRY_LAUNCHER = resolve(__dirname, '../../scripts/run-ts-entry.sh');

export function buildTypeScriptEntrypointCommand(
  entryPath: string,
  launcherPath = TS_ENTRY_LAUNCHER
): TypeScriptEntrypointCommand {
  return {
    command: launcherPath,
    args: [entryPath],
    display: `${launcherPath} ${entryPath}`,
  };
}

export function resolveTypeScriptEntrypointCommand(
  entryPath: string
): TypeScriptEntrypointCommand {
  if (entryPath.endsWith('.mjs') || entryPath.endsWith('.js')) {
    return {
      command: process.execPath,
      args: [entryPath],
      display: `${process.execPath} ${entryPath}`,
    };
  }
  return buildTypeScriptEntrypointCommand(entryPath);
}

/** Prefer bundled dist/companion.mjs when present (stable launchd path). */
export function resolveCompanionEntryPath(
  repoRoot: string | undefined,
  cwd: string
): string {
  const preferDist = process.env.ZEDGE_COMPANION_DIST !== '0';
  const roots = [
    repoRoot,
    cwd,
    resolve(__dirname, '..'),
  ].filter((value): value is string => Boolean(value));

  if (preferDist) {
    for (const root of roots) {
      const distEntry = resolve(
        root,
        'open-source/zedge/companion/dist/companion.mjs'
      );
      if (existsSync(distEntry)) {
        return distEntry;
      }
      const localDist = resolve(root, 'dist/companion.mjs');
      if (existsSync(localDist)) {
        return localDist;
      }
    }
  }

  if (repoRoot) {
    return resolve(repoRoot, 'open-source/zedge/companion/src/index.ts');
  }
  const cwdEntry = resolve(cwd, 'src/index.ts');
  const monorepoEntry = resolve(
    cwd,
    'open-source/zedge/companion/src/index.ts'
  );
  if (cwd.endsWith('open-source/zedge/companion')) {
    return cwdEntry;
  }
  return monorepoEntry;
}
