#!/usr/bin/env node
/**
 * Run the zedge companion test suite through the sovereign Monster/gnode
 * runner.
 *
 * This replaces the earlier target spellings
 *
 *   find ... -name '*.test.ts' ! -name '*e2e.test.ts' -print | sort | xargs pnpm run monster -- test
 *
 * which the native a0 dispatcher refuses as an opaque shell program ("shell
 * operator '|' requires options.monster specialization"). Discovery lives here,
 * in a repository-owned, auditable Node leaf, and the tests still run through
 * the same sovereign runner.
 *
 * Usage:
 *   node run-companion-tests.mjs              # all non-e2e companion tests
 *   node run-companion-tests.mjs --e2e        # e2e companion tests only
 *   node run-companion-tests.mjs <paths...>   # explicit files
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// open-source/zedge/scripts -> open-source/zedge -> open-source -> monorepo
const repoRoot = resolve(here, '..', '..', '..');
const testsDir = resolve(here, '..', 'companion', 'src', '__tests__');

const args = process.argv.slice(2);
const e2e = args.includes('--e2e');
const explicit = args.filter((arg) => !arg.startsWith('--'));

function discoverTests() {
  const entries = readdirSync(testsDir).filter((name) => name.endsWith('.test.ts'));
  const selected = e2e
    ? entries.filter((name) => name.endsWith('e2e.test.ts'))
    : entries.filter((name) => !name.endsWith('e2e.test.ts'));
  return selected.sort().map((name) => join(testsDir, name));
}

const files = explicit.length > 0 ? explicit : discoverTests();
if (files.length === 0) {
  console.log(
    `[zedge tests] no ${e2e ? 'e2e ' : ''}test files found under ${testsDir}`
  );
  process.exit(0);
}

console.log(
  `[zedge tests] ${files.length} ${e2e ? 'e2e ' : ''}file(s) via the sovereign Monster runner`
);

const runner = join(repoRoot, 'scripts', 'monster.mjs');
const result = spawnSync(process.execPath, [runner, 'test', ...files], {
  cwd: repoRoot,
  stdio: 'inherit',
});

if (result.error) {
  console.error(`[zedge tests] failed to start the runner: ${result.error.message}`);
  process.exit(1);
}
if (result.signal) {
  console.error(`[zedge tests] runner terminated by signal ${result.signal}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
