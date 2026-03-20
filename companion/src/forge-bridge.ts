/**
 * Zedge Forge Bridge
 *
 * Wraps ForgoCD's deploy engine for use by the companion HTTP server.
 * Provides project discovery, deploy, status, logs, and stop capabilities
 * using the filesystem-based deploy path (no VFS/CRDT required).
 */

import { join } from 'node:path';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { spawn as nodeSpawn } from 'node:child_process';

/** Run a shell command and collect output */
function execShellForge(
  command: string,
  options: { cwd?: string; env?: Record<string, string> } = {}
): Promise<{ output: string; exitCode: number }> {
  return new Promise((resolve) => {
    const proc = nodeSpawn('bash', ['-c', command], {
      cwd: options.cwd ?? process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: options.env as NodeJS.ProcessEnv,
    });
    const chunks: Buffer[] = [];
    proc.stdout?.on('data', (c: Buffer) => chunks.push(c));
    proc.stderr?.on('data', (c: Buffer) => chunks.push(c));
    proc.on('close', (code) => resolve({ output: Buffer.concat(chunks).toString(), exitCode: code ?? 1 }));
    proc.on('error', (err) => resolve({ output: err.message, exitCode: 1 }));
  });
}
import type {
  ForgoProject,
  ForgoProcess,
  ForgoProcessState,
  ForgoProjectConfig,
  ForgoDeployEvent,
} from '../../../aeon-forge/src/deploy/types';
import { discoverProjects } from '../../../aeon-forge/src/deploy/discovery';
import { createLogger } from '../../../aeon-forge/src/deploy/logger';
import type {
  ForgeEventBus,
  ExtendedForgoEvent,
  EventHandler,
} from '../../../aeon-forge/src/deploy/event-bus';

const log = createLogger('zedge-forge');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ForgeStatus {
  running: boolean;
  processes: ForgoProcess[];
  summary: {
    total: number;
    running: number;
    failed: number;
    spawning: number;
    stopped: number;
  };
}

export interface DeployResult {
  success: boolean;
  process?: ForgoProcess;
  error?: string;
}

export interface ForgeLogEntry {
  timestamp: number;
  level: 'info' | 'warn' | 'error';
  message: string;
}

// ---------------------------------------------------------------------------
// ForgeBridge
// ---------------------------------------------------------------------------

export class ForgeBridge {
  private workspacePath: string;
  private processes = new Map<string, ForgoProcess>();
  private logs = new Map<string, ForgeLogEntry[]>();
  private events: ForgoDeployEvent[] = [];
  private eventBus: ForgeEventBus | null = null;
  private eventHandlers = new Map<string, EventHandler[]>();
  private unsubscribe: (() => void) | null = null;

  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
  }

  /**
   * Connect to a forge event bus for bidirectional streaming.
   */
  connectEventBus(bus: ForgeEventBus): void {
    this.eventBus = bus;
    this.unsubscribe = bus.subscribe((event) => {
      this.addEvent(event as ForgoDeployEvent);
      const handlers = this.eventHandlers.get(event.type) ?? [];
      for (const handler of handlers) {
        try {
          handler(event);
        } catch {
          // Handler errors should not break the bridge
        }
      }
    });
  }

  /**
   * Subscribe to specific event types from the forge event bus.
   */
  on(
    eventType: ExtendedForgoEvent['type'],
    handler: EventHandler
  ): void {
    const handlers = this.eventHandlers.get(eventType) ?? [];
    handlers.push(handler);
    this.eventHandlers.set(eventType, handlers);
  }

  /**
   * Disconnect from the event bus.
   */
  disconnectEventBus(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.eventBus = null;
  }

  /**
   * Discover all projects with aeon.toml in the workspace.
   */
  async discoverProjects(): Promise<ForgoProject[]> {
    try {
      const projects = await discoverProjects(this.workspacePath);
      log.info('Discovered projects', {
        count: projects.length,
        names: projects.map((p) => p.name),
      });
      return projects;
    } catch (err) {
      log.error('Failed to discover projects', {
        error: String(err),
        workspace: this.workspacePath,
      });
      return [];
    }
  }

  /**
   * Trigger a deploy for a specific project or all projects.
   * Uses ForgoCD's filesystem-based deploy path.
   */
  async deploy(projectName?: string): Promise<DeployResult> {
    try {
      const projects = await this.discoverProjects();

      if (projects.length === 0) {
        return {
          success: false,
          error: 'No deployable projects found in workspace',
        };
      }

      let target: ForgoProject | undefined;
      if (projectName) {
        target = projects.find((p) => p.name === projectName);
        if (!target) {
          return {
            success: false,
            error: `Project "${projectName}" not found. Available: ${projects
              .map((p) => p.name)
              .join(', ')}`,
          };
        }
      } else {
        target = projects[0];
      }

      const pid = crypto.randomUUID();
      const now = Date.now();

      // Create a process record in "building" state
      const proc: ForgoProcess = {
        pid,
        name: target.name,
        kind: target.config.kind,
        state: 'building',
        port: target.config.port ?? 0,
        healthUrl: target.config.port
          ? `http://localhost:${target.config.port}/health`
          : '',
        startedAt: now,
        restartCount: 0,
      };

      this.processes.set(target.name, proc);
      this.appendLog(pid, 'info', `Deploy started for ${target.name}`);

      // Emit deploy-start event
      this.addEvent({
        type: 'deploy-start',
        projectName: target.name,
        timestamp: now,
      });

      // Execute build if configured
      if (target.config.buildCommand) {
        this.appendLog(pid, 'info', `Building: ${target.config.buildCommand}`);

        const workDir = join(this.workspacePath, target.dir);
        try {
          const { output: buildOutput, exitCode } = await execShellForge(
            target.config.buildCommand,
            { cwd: workDir, env: process.env as Record<string, string> }
          );

          if (exitCode !== 0) {
            this.appendLog(pid, 'error', `Build failed: ${buildOutput}`);
            proc.state = 'failed';
            this.processes.set(target.name, { ...proc });
            return {
              success: false,
              process: proc,
              error: `Build failed with exit code ${exitCode}`,
            };
          }

          this.appendLog(pid, 'info', 'Build succeeded');
        } catch (err) {
          this.appendLog(pid, 'error', `Build error: ${String(err)}`);
          proc.state = 'failed';
          this.processes.set(target.name, { ...proc });
          return {
            success: false,
            process: proc,
            error: String(err),
          };
        }
      }

      // Transition to spawning
      proc.state = 'spawning';
      this.processes.set(target.name, { ...proc });
      this.appendLog(pid, 'info', `Spawning ${target.name}...`);

      // Spawn the entry point
      const workDir = join(this.workspacePath, target.dir);
      const entryPoint = target.config.entryPoint || 'src/index.ts';
      const entryPath = join(workDir, entryPoint);

      if (!existsSync(entryPath)) {
        this.appendLog(pid, 'error', `Entry point not found: ${entryPath}`);
        proc.state = 'failed';
        this.processes.set(target.name, { ...proc });
        return {
          success: false,
          process: proc,
          error: `Entry point not found: ${entryPath}`,
        };
      }

      try {
        nodeSpawn('node', ['--import', 'tsx', entryPoint], {
          cwd: workDir,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...(process.env as NodeJS.ProcessEnv),
            PORT: String(target.config.port ?? 4000),
          },
          detached: true,
        });

        proc.state = 'running';
        this.processes.set(target.name, { ...proc });
        this.appendLog(pid, 'info', `Process running on port ${proc.port}`);

        this.addEvent({
          type: 'deploy-success',
          projectName: target.name,
          timestamp: Date.now(),
        });

        return { success: true, process: proc };
      } catch (err) {
        proc.state = 'failed';
        this.processes.set(target.name, { ...proc });
        this.appendLog(pid, 'error', `Spawn failed: ${String(err)}`);
        return {
          success: false,
          process: proc,
          error: String(err),
        };
      }
    } catch (err) {
      return { success: false, error: String(err) };
    }
  }

  /**
   * Get the current status of all tracked processes.
   */
  getStatus(): ForgeStatus {
    const procs = Array.from(this.processes.values());
    return {
      running: procs.some((p) => p.state === 'running'),
      processes: procs,
      summary: {
        total: procs.length,
        running: procs.filter((p) => p.state === 'running').length,
        failed: procs.filter((p) => p.state === 'failed').length,
        spawning: procs.filter((p) => p.state === 'spawning').length,
        stopped: procs.filter((p) => p.state === 'stopped').length,
      },
    };
  }

  /**
   * Get logs for a specific process by pid.
   */
  async *getLogs(processId: string): AsyncIterable<string> {
    const entries = this.logs.get(processId) ?? [];
    for (const entry of entries) {
      yield `[${new Date(entry.timestamp).toISOString()}] [${entry.level}] ${
        entry.message
      }`;
    }
  }

  /**
   * Stop a running process.
   */
  async stop(processId: string): Promise<void> {
    for (const [name, proc] of this.processes) {
      if (proc.pid === processId) {
        proc.state = 'stopped';
        this.processes.set(name, { ...proc });
        this.appendLog(processId, 'info', `Process ${name} stopped`);
        log.info('Stopped process', { name, pid: processId });
        return;
      }
    }
    log.warn('Process not found for stop', { pid: processId });
  }

  /**
   * Get recent deploy events.
   */
  getEvents(): ForgoDeployEvent[] {
    return this.events.slice(-50);
  }

  private static readonly MAX_LOG_ENTRIES = 500;
  private static readonly MAX_EVENTS = 200;

  private appendLog(
    processId: string,
    level: ForgeLogEntry['level'],
    message: string
  ): void {
    const entries = this.logs.get(processId) ?? [];
    entries.push({ timestamp: Date.now(), level, message });
    if (entries.length > ForgeBridge.MAX_LOG_ENTRIES) {
      entries.splice(0, entries.length - ForgeBridge.MAX_LOG_ENTRIES);
    }
    this.logs.set(processId, entries);
  }

  private addEvent(event: ForgoDeployEvent): void {
    this.events.push(event);
    if (this.events.length > ForgeBridge.MAX_EVENTS) {
      this.events.splice(0, this.events.length - ForgeBridge.MAX_EVENTS);
    }
  }
}
