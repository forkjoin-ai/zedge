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
  return buildTypeScriptEntrypointCommand(entryPath);
}
