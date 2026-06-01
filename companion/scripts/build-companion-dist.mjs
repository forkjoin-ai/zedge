#!/usr/bin/env node
/**
 * Build stable launchd artifacts for the Zedge companion.
 *
 * Outputs:
 *   dist/companion-supervisor.mjs  — supervisor (bundled, no tsx)
 *   dist/companion.mjs             — sidecar entry (bundled, workspace packages external)
 *   dist/package.json              — import map for external workspace packages at runtime
 */
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import esbuild from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const companionRoot = resolve(__dirname, '..');
const repoRoot = resolve(companionRoot, '../../..');

const distDir = join(companionRoot, 'dist');
mkdirSync(distDir, { recursive: true });

const workspaceImports = {
  '@a0n/buleyean-kernel': '../../../packages/buleyean-kernel/src/index.ts',
  '@a0n/gnosis': '../../../open-source/gnosis/src/lib.ts',
  '@a0n/x-gnosis': '../../../open-source/x-gnosis/src/index.ts',
  '@a0n/shared-utils': '../../../shared-utils/src/index.ts',
  '@a0n/auth': '../../../open-source/auth/src/index.ts',
  '@a0n/distributed-inference-host': '../../../open-source/gnosis/distributed-inference-host/src/index.ts',
  '@dashrelay/client': '../../../packages/dashrelay-client/src/index.ts',
};

const externalNative = [
  'onnxruntime-node',
  '@xenova/transformers',
  'sharp',
  'fsevents',
];

const externalizeWasmAndBitwise = {
  name: 'externalize-wasm-bitwise',
  setup(build) {
    build.onResolve({ filter: /\.wasm$/ }, (args) => ({
      path: args.path,
      external: true,
    }));
    build.onResolve({ filter: /bitwise/ }, (args) => ({
      path: args.path,
      external: true,
    }));
  },
};

const supervisorBuild = {
  platform: 'node',
  format: 'esm',
  target: 'node22',
  bundle: true,
  minify: true,
  sourcemap: true,
  logLevel: 'info',
  packages: 'external',
  external: externalNative,
  plugins: [externalizeWasmAndBitwise],
};

await esbuild.build({
  ...supervisorBuild,
  entryPoints: [join(companionRoot, 'src/companion-supervisor.ts')],
  outfile: join(distDir, 'companion-supervisor.mjs'),
});

await esbuild.build({
  ...supervisorBuild,
  entryPoints: [join(companionRoot, 'src/index.ts')],
  outfile: join(distDir, 'companion.mjs'),
});

writeFileSync(
  join(distDir, 'package.json'),
  `${JSON.stringify(
    {
      name: '@affectively/zedge-companion-dist',
      type: 'module',
      private: true,
      imports: workspaceImports,
    },
    null,
    2
  )}\n`
);

writeFileSync(
  join(distDir, 'launch-supervisor.mjs'),
  `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, 'companion-supervisor.mjs');
const child = spawn(process.execPath, [entry], {
  stdio: 'inherit',
  env: { ...process.env, ZEDGE_COMPANION_DIST: '1' },
  cwd: join(here, '../../../..'),
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});
`
);

console.log('[zedge:build] wrote dist/companion-supervisor.mjs, dist/companion.mjs, dist/package.json');
