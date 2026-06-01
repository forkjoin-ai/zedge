#!/usr/bin/env node
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
