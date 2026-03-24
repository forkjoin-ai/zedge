import { describe, expect, test } from 'bun:test';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import {
  buildTypeScriptEntrypointCommand,
  resolveTypeScriptEntrypointCommand,
} from '../runtime-command';

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultLauncher = resolve(__dirname, '../../scripts/run-ts-entry.sh');

describe('runtime command resolution', () => {
  test('builds wrapper-backed entrypoint commands', () => {
    const command = buildTypeScriptEntrypointCommand(
      'src/index.ts',
      '/tmp/run-ts-entry.sh'
    );

    expect(command.command).toBe('/tmp/run-ts-entry.sh');
    expect(command.args).toEqual(['src/index.ts']);
    expect(command.display).toBe('/tmp/run-ts-entry.sh src/index.ts');
  });

  test('resolves the repo launcher for companion entrypoints', () => {
    const command = resolveTypeScriptEntrypointCommand('src/index.ts');

    expect(command.command).toBe(defaultLauncher);
    expect(command.args).toEqual(['src/index.ts']);
  });
});
