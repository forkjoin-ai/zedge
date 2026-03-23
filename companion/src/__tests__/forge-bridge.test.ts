import { describe, test, expect, beforeEach } from 'bun:test';
import { ForgeBridge } from '../forge-bridge';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';

const TEST_DIR = join(tmpdir(), `zedge-forge-test-${Date.now()}`);

function setupWorkspace(
  projects: Array<{
    name: string;
    dir: string;
    kind?: string;
    port?: number;
    buildCommand?: string;
  }>
): void {
  mkdirSync(TEST_DIR, { recursive: true });
  for (const p of projects) {
    const projectDir = join(TEST_DIR, p.dir);
    mkdirSync(projectDir, { recursive: true });
    const toml = [
      '[project]',
      `name = "${p.name}"`,
      'runtime = "bun"',
      `kind = "${p.kind ?? 'site'}"`,
      ...(p.port ? [`port = ${p.port}`] : []),
      ...(p.buildCommand ? [`buildCommand = "${p.buildCommand}"`] : []),
    ].join('\n');
    writeFileSync(join(projectDir, 'aeon.toml'), toml);
    // Create a minimal entry point
    mkdirSync(join(projectDir, 'src'), { recursive: true });
    writeFileSync(join(projectDir, 'src/index.ts'), 'console.log("hello");');
  }
}

function cleanupWorkspace(): void {
  try {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  } catch {
    // best effort
  }
}

describe('ForgeBridge', () => {
  beforeEach(() => {
    cleanupWorkspace();
  });

  test('discovers projects in workspace with aeon.toml files', async () => {
    setupWorkspace([
      { name: 'app-one', dir: 'apps/app-one', kind: 'site', port: 4100 },
      { name: 'app-two', dir: 'apps/app-two', kind: 'worker', port: 4200 },
    ]);

    const bridge = new ForgeBridge(TEST_DIR);
    const projects = await bridge.discoverProjects();

    expect(projects.length).toBe(2);
    const names = projects.map((p) => p.name);
    expect(names).toContain('app-one');
    expect(names).toContain('app-two');
  });

  test('discovers zero projects in empty workspace', async () => {
    mkdirSync(TEST_DIR, { recursive: true });

    const bridge = new ForgeBridge(TEST_DIR);
    const projects = await bridge.discoverProjects();

    expect(projects.length).toBe(0);
  });

  test('getStatus returns initial empty state', () => {
    const bridge = new ForgeBridge(TEST_DIR);
    const status = bridge.getStatus();

    expect(status.running).toBe(false);
    expect(status.processes).toEqual([]);
    expect(status.summary.total).toBe(0);
    expect(status.summary.running).toBe(0);
    expect(status.summary.failed).toBe(0);
  });

  test('deploy returns error for empty workspace', async () => {
    mkdirSync(TEST_DIR, { recursive: true });

    const bridge = new ForgeBridge(TEST_DIR);
    const result = await bridge.deploy();

    expect(result.success).toBe(false);
    expect(result.error).toContain('No deployable projects');
  });

  test('deploy returns error for nonexistent project name', async () => {
    setupWorkspace([
      { name: 'real-app', dir: 'apps/real-app', kind: 'site', port: 4100 },
    ]);

    const bridge = new ForgeBridge(TEST_DIR);
    const result = await bridge.deploy('nonexistent');

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
    expect(result.error).toContain('real-app');
  });

  test('getStatus reflects deploy state', async () => {
    setupWorkspace([
      { name: 'test-app', dir: 'apps/test-app', kind: 'site', port: 4500 },
    ]);

    const bridge = new ForgeBridge(TEST_DIR);
    await bridge.deploy('test-app');

    const status = bridge.getStatus();
    expect(status.summary.total).toBe(1);
    const proc = status.processes[0];
    expect(proc).toBeDefined();
    expect(proc!.name).toBe('test-app');
    expect(['running', 'spawning', 'failed']).toContain(proc!.state);
  });

  test('getLogs yields entries for a deployed process', async () => {
    setupWorkspace([
      { name: 'log-app', dir: 'apps/log-app', kind: 'site', port: 4600 },
    ]);

    const bridge = new ForgeBridge(TEST_DIR);
    const result = await bridge.deploy('log-app');

    const logs: string[] = [];
    if (result.process) {
      for await (const line of bridge.getLogs(result.process.pid)) {
        logs.push(line);
      }
    }

    expect(logs.length).toBeGreaterThan(0);
    expect(logs.some((l) => l.includes('Deploy started'))).toBe(true);
  });

  test('stop transitions process to stopped', async () => {
    setupWorkspace([
      { name: 'stop-app', dir: 'apps/stop-app', kind: 'site', port: 4700 },
    ]);

    const bridge = new ForgeBridge(TEST_DIR);
    const result = await bridge.deploy('stop-app');

    if (result.process) {
      await bridge.stop(result.process.pid);
    }

    const status = bridge.getStatus();
    const proc = status.processes.find((p) => p.name === 'stop-app');
    expect(proc).toBeDefined();
    expect(proc!.state).toBe('stopped');
  });

  test('stop is a no-op for unknown process id', async () => {
    const bridge = new ForgeBridge(TEST_DIR);
    // Should not throw
    await bridge.stop('nonexistent-pid');
    expect(bridge.getStatus().summary.total).toBe(0);
  });

  test(
    'deploy with failing build command returns failed',
    async () => {
      setupWorkspace([
        {
          name: 'fail-build',
          dir: 'apps/fail-build',
          kind: 'site',
          port: 4800,
          buildCommand: 'exit 1',
        },
      ]);

      const bridge = new ForgeBridge(TEST_DIR);
      const result = await bridge.deploy('fail-build');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Build failed');
      expect(result.process?.state).toBe('failed');
    },
    30_000
  );

  test('getEvents returns deploy events', async () => {
    setupWorkspace([
      { name: 'event-app', dir: 'apps/event-app', kind: 'site', port: 4900 },
    ]);

    const bridge = new ForgeBridge(TEST_DIR);
    await bridge.deploy('event-app');

    const events = bridge.getEvents();
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]!.type).toBe('deploy-start');
    expect(events[0]!.projectName).toBe('event-app');
  });

  test('discovers project config fields correctly', async () => {
    setupWorkspace([
      {
        name: 'config-app',
        dir: 'apps/config-app',
        kind: 'worker',
        port: 5000,
      },
    ]);

    const bridge = new ForgeBridge(TEST_DIR);
    const projects = await bridge.discoverProjects();

    const project = projects.find((p) => p.name === 'config-app');
    expect(project).toBeDefined();
    expect(project!.config.kind).toBe('worker');
    expect(project!.config.runtime).toBe('bun');
    expect(project!.configSource).toBe('aeon.toml');
  });
});
