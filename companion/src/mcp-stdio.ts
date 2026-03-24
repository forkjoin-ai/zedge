#!/usr/bin/env bun
/**
 * Zedge MCP Stdio Bridge
 *
 * Thin MCP server that Zed launches as a context server.
 * Speaks JSON-RPC over stdin/stdout (MCP protocol) and proxies
 * requests to the companion HTTP sidecar at localhost:7331.
 *
 * Auto-spawns the companion sidecar (index.ts) if it's not already
 * running, and babysits it with a periodic health check loop --
 * restarting it automatically if it crashes or becomes unreachable.
 */

import { readFileSync, existsSync } from 'fs';
import { spawn, type ChildProcess } from 'child_process';
import { resolve, dirname, relative, sep } from 'path';
import { fileURLToPath } from 'url';
import { getCompanionPort } from './config';
import { callBabelfishMcpTool, getBabelfishMcpTools } from './babelfish-mcp';
import {
  COMPANION_STOP_TIMEOUT_MS,
  CONSECUTIVE_FAILURES_BEFORE_RESTART,
  HEALTH_CHECK_INTERVAL_MS,
  HEALTH_CHECK_TIMEOUT_MS,
  RESTART_WINDOW_MS,
  decideCompanionRestart,
} from './companion-restart-policy';
import { resolveTypeScriptEntrypointCommand } from './runtime-command';

function getCompanionBase(): string {
  return `http://localhost:${getCompanionPort()}`;
}

// ---------- Companion babysitter ----------

const __dirname = dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = resolve(
  process.env.AEON_ROOT ?? resolve(__dirname, '../../../..')
);
const COMPANION_ENTRY = resolve(__dirname, 'index.ts');
let companionProc: ChildProcess | null = null;
let babysitterTimer: ReturnType<typeof setInterval> | null = null;
let stdioLoggingConfigured = false;
let companionSpawnedAt = 0;
let consecutiveHealthFailures = 0;
let recentRestartTimestamps: number[] = [];
let babysitterCheckInFlight = false;
let restartInFlight: Promise<boolean> | null = null;
let suppressExitRestart = false;
let shuttingDown = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function configureStdioLogging(): void {
  if (stdioLoggingConfigured) {
    return;
  }

  stdioLoggingConfigured = true;
  console.log = (...args: unknown[]) => console.error('[zedge:mcp]', ...args);
  console.warn = (...args: unknown[]) =>
    process.stderr.write(`[zedge:mcp:warn] ${args.join(' ')}\n`);
  console.info = (...args: unknown[]) =>
    process.stderr.write(`[zedge:mcp:info] ${args.join(' ')}\n`);
  console.debug = (...args: unknown[]) =>
    process.stderr.write(`[zedge:mcp:debug] ${args.join(' ')}\n`);
}

/** Check if companion is reachable */
async function isCompanionAlive(): Promise<boolean> {
  try {
    const resp = await fetch(`${getCompanionBase()}/health`, {
      signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

/** Spawn the companion sidecar as a child process via the current runtime */
function spawnCompanion(): void {
  if (
    companionProc &&
    companionProc.exitCode === null &&
    companionProc.signalCode === null
  ) {
    console.warn(
      '[zedge:babysitter] Refusing duplicate companion spawn while owned child is still active'
    );
    return;
  }

  const runtimeCommand = resolveTypeScriptEntrypointCommand(COMPANION_ENTRY);
  console.log(
    `[zedge:babysitter] Spawning companion: ${runtimeCommand.display}`
  );
  const child = spawn(runtimeCommand.command, [...runtimeCommand.args], {
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env },
  });
  companionProc = child;
  companionSpawnedAt = Date.now();
  consecutiveHealthFailures = 0;

  child.on('error', (error) => {
    console.warn(
      `[zedge:babysitter] Failed to spawn companion: ${error.message}`
    );
    if (companionProc === child) {
      companionProc = null;
    }
  });

  child.on('exit', (code, signal) => {
    console.log(
      `[zedge:babysitter] Companion exited with code ${code} signal ${
        signal ?? 'none'
      }`
    );
    if (companionProc === child) {
      companionProc = null;
    }
    if (!shuttingDown && !suppressExitRestart) {
      void restartCompanion('owned child exited unexpectedly', {
        force: true,
      });
    }
  });
}

async function stopCompanion(): Promise<void> {
  const child = companionProc;
  if (!child) {
    return;
  }

  suppressExitRestart = true;
  const exitPromise = new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once('exit', () => resolve());
  });

  try {
    child.kill('SIGTERM');
  } catch {
    // Best-effort shutdown only.
  }

  const exitedGracefully = await Promise.race([
    exitPromise.then(() => true),
    sleep(COMPANION_STOP_TIMEOUT_MS).then(() => false),
  ]);

  if (
    !exitedGracefully &&
    child.exitCode === null &&
    child.signalCode === null
  ) {
    try {
      child.kill('SIGKILL');
    } catch {
      // Best-effort hard stop only.
    }
    await Promise.race([exitPromise, sleep(1_000)]);
  }

  if (companionProc === child) {
    companionProc = null;
  }
  suppressExitRestart = false;
}

async function restartCompanion(
  reason: string,
  options: { force?: boolean } = {}
): Promise<boolean> {
  if (restartInFlight) {
    return restartInFlight;
  }

  restartInFlight = (async () => {
    const decision = decideCompanionRestart({
      now: Date.now(),
      companionSpawnedAt,
      consecutiveFailures: consecutiveHealthFailures,
      restartTimestamps: recentRestartTimestamps,
      force: options.force,
    });
    recentRestartTimestamps = decision.restartTimestamps;

    if (!decision.shouldRestart) {
      if (decision.reason === 'startup_grace') {
        console.debug(
          '[zedge:babysitter] Skipping restart during companion startup grace window'
        );
      } else if (decision.reason === 'rate_limited') {
        console.warn(
          `[zedge:babysitter] Restart suppressed after ${recentRestartTimestamps.length} restarts in the last ${Math.round(
            RESTART_WINDOW_MS / 1000
          )}s`
        );
      }
      return false;
    }

    console.log(`[zedge:babysitter] Restarting companion: ${reason}`);
    await stopCompanion();
    spawnCompanion();

    const alive = await waitForCompanion();
    if (!alive) {
      console.warn(
        '[zedge:babysitter] Companion did not become healthy after restart'
      );
      return false;
    }

    consecutiveHealthFailures = 0;
    console.log('[zedge:babysitter] Companion healthy after restart');
    return true;
  })().finally(() => {
    restartInFlight = null;
  });

  return restartInFlight;
}

/** Start the babysitter loop: check health, restart if dead */
function startBabysitter(): void {
  if (babysitterTimer) return;

  babysitterTimer = setInterval(async () => {
    if (babysitterCheckInFlight || restartInFlight) {
      return;
    }

    babysitterCheckInFlight = true;
    const alive = await isCompanionAlive();
    try {
      if (alive) {
        consecutiveHealthFailures = 0;
        return;
      }

      consecutiveHealthFailures += 1;
      console.warn(
        `[zedge:babysitter] Companion health check failed (${consecutiveHealthFailures}/${CONSECUTIVE_FAILURES_BEFORE_RESTART})`
      );
      await restartCompanion(
        `health check failed ${consecutiveHealthFailures} consecutive times`
      );
    } finally {
      babysitterCheckInFlight = false;
    }
  }, HEALTH_CHECK_INTERVAL_MS);

  // Clean up on exit
  process.on('exit', () => {
    shuttingDown = true;
    if (babysitterTimer) clearInterval(babysitterTimer);
    if (companionProc && !companionProc.killed) {
      try { companionProc.kill('SIGTERM'); } catch {}
    }
  });
}

// ---------- MCP JSON-RPC types ----------

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface McpPromptArgument {
  name: string;
  description: string;
  required?: boolean;
}

interface McpPromptDefinition {
  name: string;
  description: string;
  arguments?: McpPromptArgument[];
  instructions: string;
}

// ---------- Companion health check ----------

async function waitForCompanion(maxAttempts = 20): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const resp = await fetch(`${getCompanionBase()}/health`, {
        signal: AbortSignal.timeout(2000),
      });
      if (resp.ok) return true;
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// ---------- MCP message handlers ----------

const slashArgsPrompt: McpPromptArgument[] = [
  {
    name: 'args',
    description:
      'The raw argument text after the slash command, matching the extension command surface',
  },
];

const ZEDGE_PROMPTS: McpPromptDefinition[] = [
  {
    name: 'zedge-status',
    description: 'Show inference chain health, compute pool stats, and token balance',
    instructions:
      'Inspect the Zedge companion status. Use the `zedge_command` tool with `command: "zedge-status"` and summarize health, preferred model, mesh, compute pool, workspace bridges, and inference-tier availability.',
  },
  {
    name: 'zedge-models',
    description: 'List available models with latency tier and readiness',
    instructions:
      'List the current Zedge models. Use the `zedge_command` tool with `command: "zedge-models"` and summarize which model IDs are available.',
  },
  {
    name: 'zedge-pool',
    description: 'Show or change compute pool participation and earnings',
    arguments: slashArgsPrompt,
    instructions:
      'Inspect or change compute-pool participation. Use the `zedge_command` tool with `command: "zedge-pool"`. Pass `args` as `status`, `join`, or `leave`.',
  },
  {
    name: 'zedge-logs',
    description: 'Show recent inference logs from the companion',
    arguments: slashArgsPrompt,
    instructions:
      'Fetch recent Zedge inference logs. Use the `zedge_command` tool with `command: "zedge-logs"`. If the user supplied an argument, treat it as the line count to request.',
  },
  {
    name: 'zedge-clear',
    description: 'Clear inference logs',
    instructions:
      'Clear the Zedge inference log buffer. Use the `zedge_command` tool with `command: "zedge-clear"` and report that the logs were cleared.',
  },
  {
    name: 'zedge-restart',
    description: 'Restart the companion sidecar',
    instructions:
      'Restart the Zedge companion sidecar. Use the `zedge_command` tool with `command: "zedge-restart"` and report that the sidecar is restarting.',
  },
  {
    name: 'zedge-selftest',
    description: 'Run a live inference self-test for health and SSE progress',
    arguments: slashArgsPrompt,
    instructions:
      'Run the live Zedge inference self-test. Use the `zedge_command` tool with `command: "zedge-selftest"`. If the user supplied an argument, treat it as the model ID. Report edge-model readiness, Cloud Run health, and whether companion/direct SSE emitted prefill, heartbeat, data, and done events.',
  },
  {
    name: 'zedgework',
    description: 'Run edgework commands for analysis and account operations',
    arguments: slashArgsPrompt,
    instructions:
      'Run an edgework CLI command through the Zedge companion. Use the `zedge_command` tool with `command: "zedgework"`. If no argument was supplied, list the available edgework commands instead of executing one.',
  },
  {
    name: 'zedge-admin',
    description: 'Run aeon-cli admin commands',
    arguments: slashArgsPrompt,
    instructions:
      'Run an aeon admin command through the Zedge companion. Use the `zedge_command` tool with `command: "zedge-admin"`. If no argument was supplied, list the available admin commands instead of executing one.',
  },
  {
    name: 'zedge-mesh',
    description: 'Start, stop, or inspect the P2P inference mesh',
    arguments: slashArgsPrompt,
    instructions:
      'Control or inspect the P2P inference mesh. Use the `zedge_command` tool with `command: "zedge-mesh"`. The argument should be `status`, `start`, or `stop`.',
  },
  {
    name: 'zedge-crdt',
    description: 'Inspect Ghostwriter CRDT status and collaboration state',
    arguments: slashArgsPrompt,
    instructions:
      'Inspect Ghostwriter CRDT state. Use the `zedge_command` tool with `command: "zedge-crdt"`. The argument may be `status`, `files`, `cursors`, `participants`, `ledger`, or `diagnostics`.',
  },
  {
    name: 'zedge-forge',
    description: 'Inspect or trigger Forge deployment work',
    arguments: slashArgsPrompt,
    instructions:
      'Inspect Forge status or trigger a deployment. Use the `zedge_command` tool with `command: "zedge-forge"`. The argument may be `status`, `projects`, or `deploy <project-name>`.',
  },
  {
    name: 'zedge-kernel',
    description: 'Inspect kernel daemons, plugins, commands, and flight logs',
    arguments: slashArgsPrompt,
    instructions:
      'Inspect kernel runtime surfaces. Use the `zedge_command` tool with `command: "zedge-kernel"`. The argument may be `status`, `daemons`, `plugins`, `commands`, or `flight-log`.',
  },
  {
    name: 'zedge-scaffold',
    description: 'Create a new project from a scaffold template',
    arguments: slashArgsPrompt,
    instructions:
      'Create or inspect scaffolds through the companion. Use the `zedge_command` tool with `command: "zedge-scaffold"`. With no argument, list templates. To create a project, pass `<template> <project-name>`.',
  },
  {
    name: 'zedge-gnosis',
    description: 'Analyze a Gnosis topological graph string',
    arguments: slashArgsPrompt,
    instructions:
      'Evaluate a Gnosis topology string. Use the `zedge_command` tool with `command: "zedge-gnosis"` and pass the topology source as the raw argument text.',
  },
  {
    name: 'zedge-gnosis-run',
    description: 'Run a Gnosis file from the workspace',
    arguments: slashArgsPrompt,
    instructions:
      'Run a workspace Gnosis file. Use the `zedge_command` tool with `command: "zedge-gnosis-run"`. With no argument, fall back to `main.gg` or `example.gg` from the workspace root.',
  },
  {
    name: 'zedge-gnosis-viz',
    description: 'Open the Gnosis topology visualization URL',
    arguments: slashArgsPrompt,
    instructions:
      'Return the Gnosis visualization URL. Use the `zedge_command` tool with `command: "zedge-gnosis-viz"`. Optionally pass a file path argument to preselect a workspace file.',
  },
  {
    name: 'zedge-test',
    description: 'Run the Gnosis isolation test graph',
    arguments: slashArgsPrompt,
    instructions:
      'Run the Zedge isolation test surface. Use the `zedge_command` tool with `command: "zedge-test"`. If the user supplied an argument, treat it as the Gnosis file path; otherwise use the built-in isolation runner.',
  },
  {
    name: 'zedge-feedback',
    description: 'Submit or inspect local RLHF feedback for Zedge responses',
    instructions:
      'Submit or inspect local Zedge feedback. Use the `zedge_command` tool with `command: "zedge-feedback"`. With no arguments, inspect recent feedback entries. To submit feedback, pass `args` as `<rating 1-5> [comment]` or use the structured `rating`, `comment`, and optional `model` fields.',
  },
  {
    name: 'zedge-babelfish',
    description: 'Babelfish over Gnosis: capabilities, explain, translate, generate, and apply',
    arguments: slashArgsPrompt,
    instructions:
      'Run a Babelfish operation. Use the `zedge_command` tool with `command: "zedge-babelfish"`. With no argument, list capabilities. Supported argument forms mirror the extension slash command: `capabilities`, `explain <file-path> [audience-language]`, `translate-code <target-language> <file-path>`, `translate-text <target-language> <file-path>`, `generate <target-language> <file-path>`, `rewrite-preview <target-language> <file-path>`, and `apply <preview-id> [rewrite_in_place|generate_files]`.',
  },
  {
    name: 'zedge-review',
    description:
      'Consensus code review over the current diff via constructive superinference',
    instructions:
      'Run a consensus review of the current git diff. Use the `zedge_command` tool with `command: "zedge-review"` and summarize the highest-signal findings and disagreements between reviewers.',
  },
];

function optionalString(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function optionalNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
}

function tokenizeArgs(value: string | null): string[] {
  if (!value) {
    return [];
  }

  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (const char of value) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current);
        current = '';
      }
      continue;
    }

    current += char;
  }

  if (escaped) {
    current += '\\';
  }

  if (current.length > 0) {
    tokens.push(current);
  }

  return tokens;
}

function createToolResult(
  text: string,
  isError = false
): Record<string, unknown> {
  const result: Record<string, unknown> = {
    content: [{ type: 'text', text }],
  };
  if (isError) {
    result.isError = true;
  }
  return result;
}

function renderPromptText(prompt: McpPromptDefinition, args: string | null): string {
  const payload: Record<string, unknown> = { command: prompt.name };
  if (args) {
    payload.args = args;
  }

  const invocation = JSON.stringify(payload, null, 2);
  return `${prompt.instructions}\n\nUse this MCP tool payload:\n\`\`\`json\n${invocation}\n\`\`\``;
}

function resolveWorkspacePath(filePath: string): string {
  const resolvedPath = resolve(WORKSPACE_ROOT, filePath);
  const relativePath = relative(WORKSPACE_ROOT, resolvedPath);

  if (relativePath === '..' || relativePath.startsWith(`..${sep}`)) {
    throw new Error(`Path escapes workspace root: ${filePath}`);
  }

  return resolvedPath;
}

function readWorkspaceFile(filePath: string): string {
  const resolvedPath = resolveWorkspacePath(filePath);
  if (!existsSync(resolvedPath)) {
    throw new Error(`Workspace file not found: ${filePath}`);
  }

  return readFileSync(resolvedPath, 'utf8');
}

function readFirstWorkspaceFile(
  candidates: string[]
): { filePath: string; sourceText: string } {
  for (const candidate of candidates) {
    const resolvedPath = resolveWorkspacePath(candidate);
    if (existsSync(resolvedPath)) {
      return {
        filePath: candidate,
        sourceText: readFileSync(resolvedPath, 'utf8'),
      };
    }
  }

  throw new Error(`Could not find any of: ${candidates.join(', ')}`);
}

async function responseToText(response: Response): Promise<string> {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    return JSON.stringify(await response.json(), null, 2);
  }

  const body = await response.text();
  return body.length > 0 ? body : `${response.status} ${response.statusText}`;
}

async function fetchCompanionText(
  path: string,
  init: RequestInit = {},
  timeoutMs = 10_000
): Promise<string> {
  const response = await fetch(`${getCompanionBase()}${path}`, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await responseToText(response);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${body}`);
  }

  return body;
}

async function postCompanionJson(
  path: string,
  body?: Record<string, unknown>,
  timeoutMs = 30_000
): Promise<string> {
  if (body) {
    return fetchCompanionText(
      path,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      timeoutMs
    );
  }

  return fetchCompanionText(path, { method: 'POST' }, timeoutMs);
}

function createBabelfishScope(filePath: string): Record<string, unknown> {
  return {
    kind: 'file',
    filePath,
    sourceText: readWorkspaceFile(filePath),
  };
}

async function handleBabelfishSlashCommand(argsText: string | null): Promise<string> {
  const parts = tokenizeArgs(argsText);
  const subcommand = parts[0] ?? 'capabilities';

  switch (subcommand) {
    case 'capabilities':
      return callBabelfishMcpTool(
        getCompanionBase(),
        'zedge_babelfish_capabilities',
        {}
      );
    case 'apply': {
      const previewId = optionalString(parts[1]);
      if (!previewId) {
        throw new Error(
          'Usage: /zedge-babelfish apply <preview-id> [rewrite_in_place|generate_files]'
        );
      }

      const applyMode = parts[2] ?? 'rewrite_in_place';
      return callBabelfishMcpTool(getCompanionBase(), 'zedge_babelfish_apply', {
        previewId,
        applyMode,
      });
    }
    case 'translate-code':
    case 'generate':
    case 'rewrite-preview': {
      const targetLanguage = optionalString(parts[1]);
      const filePath = optionalString(parts[2]);
      if (!targetLanguage || !filePath) {
        throw new Error(
          'Usage: /zedge-babelfish <translate-code|generate|rewrite-preview> <target-language> <file-path>'
        );
      }

      const outputMode =
        subcommand === 'generate'
          ? 'generate_files'
          : subcommand === 'rewrite-preview'
            ? 'rewrite_in_place_requested'
            : 'preview';

      return callBabelfishMcpTool(getCompanionBase(), 'zedge_babelfish_code', {
        scope: createBabelfishScope(filePath),
        targetLanguage,
        mode: subcommand,
        outputMode,
      });
    }
    case 'translate-text': {
      const targetHumanLanguage = optionalString(parts[1]);
      const filePath = optionalString(parts[2]);
      if (!targetHumanLanguage || !filePath) {
        throw new Error(
          'Usage: /zedge-babelfish translate-text <target-language> <file-path>'
        );
      }

      return callBabelfishMcpTool(getCompanionBase(), 'zedge_babelfish_text', {
        scope: createBabelfishScope(filePath),
        targetHumanLanguage,
        includeComments: true,
        includeDiagnostics: true,
        includeMarkdown: true,
      });
    }
    case 'explain': {
      const filePath = optionalString(parts[1]);
      if (!filePath) {
        throw new Error(
          'Usage: /zedge-babelfish explain <file-path> [audience-language]'
        );
      }

      const audienceLanguage = parts[2] ?? 'en';
      return callBabelfishMcpTool(getCompanionBase(), 'zedge_babelfish_explain', {
        scope: createBabelfishScope(filePath),
        audienceLanguage,
        includeGg: true,
      });
    }
    default:
      return [
        'Usage:',
        '- /zedge-babelfish capabilities',
        '- /zedge-babelfish explain <file-path> [audience-language]',
        '- /zedge-babelfish translate-code <target-language> <file-path>',
        '- /zedge-babelfish translate-text <target-language> <file-path>',
        '- /zedge-babelfish generate <target-language> <file-path>',
        '- /zedge-babelfish rewrite-preview <target-language> <file-path>',
        '- /zedge-babelfish apply <preview-id> [rewrite_in_place|generate_files]',
      ].join('\n');
  }
}

async function executeZedgeCommandTool(
  args: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const command = optionalString(args.command);
  if (!command) {
    return createToolResult('Missing required `command` argument.', true);
  }

  const argsText = optionalString(args.args);
  const parts = tokenizeArgs(argsText);

  try {
    switch (command) {
      case 'zedge-status':
        return createToolResult(await fetchCompanionText('/health'));
      case 'zedge-models':
        return createToolResult(await fetchCompanionText('/v1/models'));
      case 'zedge-pool': {
        const subcommand = parts[0] ?? 'status';
        if (subcommand === 'join') {
          return createToolResult(
            await postCompanionJson('/compute-pool/join', undefined, 30_000)
          );
        }
        if (subcommand === 'leave') {
          return createToolResult(
            await postCompanionJson('/compute-pool/leave', undefined, 30_000)
          );
        }
        return createToolResult(
          await fetchCompanionText('/compute-pool/status', {}, 10_000)
        );
      }
      case 'zedge-logs': {
        const requestedLimit = optionalNumber(args.limit) ?? optionalNumber(argsText);
        const limit = Math.max(1, Math.min(requestedLimit ?? 100, 1000));
        return createToolResult(await fetchCompanionText(`/logs?n=${limit}`));
      }
      case 'zedge-clear':
        return createToolResult(
          await fetchCompanionText('/logs', { method: 'DELETE' }, 10_000)
        );
      case 'zedge-restart':
        return createToolResult(
          await postCompanionJson('/restart', undefined, 10_000)
        );
      case 'zedge-selftest': {
        const model = optionalString(args.model) ?? argsText;
        const path = model
          ? `/selftest/inference?model=${encodeURIComponent(model)}`
          : '/selftest/inference';
        return createToolResult(await fetchCompanionText(path, {}, 120_000));
      }
      case 'zedgework': {
        if (!argsText) {
          return createToolResult(await fetchCompanionText('/edgework/commands'));
        }

        const commandText = argsText.startsWith('edgework ')
          ? argsText
          : `edgework ${argsText}`;
        return createToolResult(
          await postCompanionJson(
            '/edgework/exec',
            { command: commandText },
            30_000
          )
        );
      }
      case 'zedge-admin': {
        if (!argsText) {
          return createToolResult(await fetchCompanionText('/admin/commands'));
        }

        const commandText = argsText.startsWith('aeon ')
          ? argsText
          : `aeon ${argsText}`;
        return createToolResult(
          await postCompanionJson(
            '/admin/exec',
            { command: commandText },
            30_000
          )
        );
      }
      case 'zedge-mesh': {
        const subcommand = parts[0] ?? 'status';
        if (subcommand === 'start') {
          return createToolResult(await postCompanionJson('/mesh/start'));
        }
        if (subcommand === 'stop') {
          return createToolResult(await postCompanionJson('/mesh/stop'));
        }
        return createToolResult(await fetchCompanionText('/mesh/status'));
      }
      case 'zedge-crdt': {
        const subcommand = parts[0] ?? 'status';
        const path =
          subcommand === 'files'
            ? '/crdt/files'
            : subcommand === 'cursors'
              ? '/crdt/cursors'
              : subcommand === 'participants'
                ? '/crdt/participants'
                : subcommand === 'ledger'
                  ? '/crdt/ledger'
                  : subcommand === 'diagnostics'
                    ? '/crdt/diagnostics'
                    : '/crdt/status';
        return createToolResult(await fetchCompanionText(path));
      }
      case 'zedge-forge': {
        const subcommand = parts[0] ?? 'status';
        if (subcommand === 'projects') {
          return createToolResult(await fetchCompanionText('/forge/projects'));
        }
        if (subcommand === 'deploy') {
          const project =
            optionalString(args.projectName) ?? optionalString(parts.slice(1).join(' '));
          if (!project) {
            return createToolResult(
              'Usage: /zedge-forge deploy <project-name>',
              true
            );
          }
          return createToolResult(
            await postCompanionJson('/forge/deploy', { project }, 60_000)
          );
        }
        return createToolResult(await fetchCompanionText('/forge/status'));
      }
      case 'zedge-kernel': {
        const subcommand = parts[0] ?? 'status';
        if (subcommand === 'daemons') {
          return createToolResult(await fetchCompanionText('/kernel/daemons'));
        }
        if (subcommand === 'plugins') {
          return createToolResult(await fetchCompanionText('/kernel/plugins'));
        }
        if (subcommand === 'commands') {
          return createToolResult(await fetchCompanionText('/kernel/commands'));
        }
        if (subcommand === 'flight-log') {
          return createToolResult(await fetchCompanionText('/kernel/flight-log'));
        }

        const [daemons, plugins] = await Promise.all([
          fetchCompanionText('/kernel/daemons'),
          fetchCompanionText('/kernel/plugins'),
        ]);
        return createToolResult(
          `## Kernel Status\n\n### Daemons\n\`\`\`json\n${daemons}\n\`\`\`\n\n### Plugins\n\`\`\`json\n${plugins}\n\`\`\``
        );
      }
      case 'zedge-scaffold': {
        if (!argsText && !optionalString(args.template)) {
          return createToolResult(await fetchCompanionText('/scaffold/templates'));
        }

        const template = optionalString(args.template) ?? optionalString(parts[0]);
        const projectName =
          optionalString(args.projectName) ?? optionalString(parts[1]);
        const targetDir = optionalString(args.targetDir);
        if (!template || !projectName) {
          return createToolResult(
            'Usage: /zedge-scaffold <template> <project-name>',
            true
          );
        }
        const body: Record<string, unknown> = {
          template,
          name: projectName,
        };
        if (targetDir) {
          body.targetDir = targetDir;
        }
        return createToolResult(
          await postCompanionJson('/scaffold/create', body, 60_000)
        );
      }
      case 'zedge-gnosis': {
        const code = optionalString(args.code) ?? argsText;
        if (!code) {
          return createToolResult(
            'Usage: /zedge-gnosis <topological-graph-string>',
            true
          );
        }
        return createToolResult(
          await postCompanionJson('/gnosis/eval', { code }, 30_000)
        );
      }
      case 'zedge-gnosis-run': {
        const requestedFilePath = optionalString(args.filePath) ?? argsText;
        const source = requestedFilePath
          ? {
              filePath: requestedFilePath,
              sourceText: readWorkspaceFile(requestedFilePath),
            }
          : readFirstWorkspaceFile(['main.gg', 'example.gg']);
        const result = await postCompanionJson(
          '/gnosis/eval',
          { code: source.sourceText },
          30_000
        );
        return createToolResult(`Ran ${source.filePath}\n\n${result}`);
      }
      case 'zedge-gnosis-viz': {
        const filePath = optionalString(args.filePath) ?? argsText;
        const query = filePath ? `?file=${encodeURIComponent(filePath)}` : '';
        return createToolResult(`${getCompanionBase()}/gnosis/viz${query}`);
      }
      case 'zedge-test': {
        const filePath =
          optionalString(args.filePath) ??
          argsText ??
          'open-source/gnosis/topologies/services/isolation-tests.gg';
        const code = readWorkspaceFile(filePath);
        const result = await postCompanionJson('/gnosis/eval', { code }, 30_000);
        return createToolResult(`Ran ${filePath}\n\n${result}`);
      }
      case 'zedge-feedback':
        if (args.rating !== undefined || argsText) {
          const rating =
            optionalNumber(args.rating) ?? optionalNumber(parts[0]);
          if (rating === null || rating < 1 || rating > 5) {
            return createToolResult(
              'Usage: /zedge-feedback <rating 1-5> [comment]',
              true
            );
          }

          const comment =
            optionalString(args.comment) ?? optionalString(parts.slice(1).join(' '));
          const model = optionalString(args.model);
          return createToolResult(
            await postCompanionJson(
              '/feedback',
              {
                rating,
                model: model ?? undefined,
                comment: comment ?? undefined,
                source: 'zed-agent',
              },
              10_000
            )
          );
        }

        return createToolResult(await fetchCompanionText('/feedback?n=10'));
      case 'zedge-babelfish':
        return createToolResult(await handleBabelfishSlashCommand(argsText));
      default:
        return createToolResult(`Unknown Zedge command: ${command}`, true);
    }
  } catch (error) {
    return createToolResult(
      error instanceof Error ? error.message : String(error),
      true
    );
  }
}

export function handleInitialize(
  params: Record<string, unknown>
): Record<string, unknown> {
  return {
    protocolVersion: '2024-11-05',
    capabilities: {
      tools: { listChanged: false },
      prompts: { listChanged: false },
      resources: { subscribe: false, listChanged: false },
    },
    serverInfo: {
      name: 'zedge-companion',
      version: '2.0.0',
    },
  };
}

export async function handleToolsList(): Promise<Record<string, unknown>> {
  return {
    tools: [
      {
        name: 'zedge_infer',
        description:
          'Send a chat completion request through the Zedge inference chain (mesh → edge → cloud → WASM)',
        inputSchema: {
          type: 'object',
          properties: {
            prompt: {
              type: 'string',
              description: 'The user prompt to send',
            },
            model: {
              type: 'string',
              description:
                'Model ID (e.g. tinyllama-1.1b, mistral-7b, qwen-2.5-coder-7b)',
            },
            system: {
              type: 'string',
              description: 'Optional system prompt',
            },
          },
          required: ['prompt'],
        },
      },
      {
        name: 'zedge_models',
        description: 'List available models and their readiness status',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'zedge_status',
        description:
          'Get companion status including mesh peers, compute pool, and tier health',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'zedge_workspace',
        description:
          'Get workspace file tree and git changes from the VFS bridge',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'zedge_command',
        description:
          'Invoke the Zedge slash-command surface through the companion so Zed Agent and the extension expose the same commands',
        inputSchema: {
          type: 'object',
          properties: {
            command: {
              type: 'string',
              enum: ZEDGE_PROMPTS.map((prompt) => prompt.name),
              description: 'The Zedge slash command to run',
            },
            args: {
              type: 'string',
              description:
                'The raw argument text after the slash command, matching the extension surface',
            },
            limit: {
              type: 'integer',
              description:
                'Optional log line count for zedge-logs or other commands that accept a numeric limit',
            },
            model: {
              type: 'string',
              description:
                'Optional explicit model ID for zedge-selftest when you do not want to pass it through args',
            },
            code: {
              type: 'string',
              description:
                'Optional explicit Gnosis source text for zedge-gnosis',
            },
            filePath: {
              type: 'string',
              description:
                'Optional workspace-relative file path for file-backed commands',
            },
            template: {
              type: 'string',
              description:
                'Optional explicit scaffold template name for zedge-scaffold',
            },
            projectName: {
              type: 'string',
              description:
                'Optional explicit project name for zedge-scaffold or zedge-forge deploy',
            },
            rating: {
              type: 'integer',
              description:
                'Optional feedback rating for zedge-feedback when you do not want to pass it through args',
            },
            comment: {
              type: 'string',
              description:
                'Optional feedback comment for zedge-feedback or other commands that accept freeform text',
            },
            targetDir: {
              type: 'string',
              description:
                'Optional target directory override for zedge-scaffold',
            },
          },
          required: ['command'],
        },
      },
      {
        name: 'zedge_apply_code',
        description:
          'Apply a code change to a file. Uses CRDT-backed writes with full undo support. The search string must match exactly in the file.',
        inputSchema: {
          type: 'object',
          properties: {
            file_path: {
              type: 'string',
              description: 'Workspace-relative path to the file to modify',
            },
            search: {
              type: 'string',
              description: 'The exact text to find and replace in the file',
            },
            replace: {
              type: 'string',
              description: 'The replacement text',
            },
          },
          required: ['file_path', 'search', 'replace'],
        },
      },
      {
        name: 'zedge_search_codebase',
        description:
          'Semantic search across the workspace codebase. Returns the most relevant code blocks for a natural language query.',
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: 'Natural language query describing what you are looking for',
            },
            top_k: {
              type: 'integer',
              description: 'Number of results to return (default 5)',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'zedge_related_context',
        description:
          'Get code blocks from other files that are semantically related to a given file. Useful for understanding dependencies and related functionality.',
        inputSchema: {
          type: 'object',
          properties: {
            file_path: {
              type: 'string',
              description: 'Workspace-relative path to find related context for',
            },
          },
          required: ['file_path'],
        },
      },
      {
        name: 'zedge_daydream',
        description:
          'Get proactive code improvement suggestions from the CERA daydream engine. Trigger a dream cycle on a file, or list cached candidates.',
        inputSchema: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['status', 'candidates', 'dream', 'accept', 'reject'],
              description: 'Action to perform (default: candidates)',
            },
            file_path: {
              type: 'string',
              description: 'File path for dream action',
            },
            id: {
              type: 'string',
              description: 'Candidate ID for accept/reject actions',
            },
          },
        },
      },
      {
        name: 'zedge_multi_file_edit',
        description:
          'Apply a high-level code change across one or more files using the multi-file agent. Describe what you want changed in natural language.',
        inputSchema: {
          type: 'object',
          properties: {
            instruction: {
              type: 'string',
              description: 'Natural language description of the change to make',
            },
            target_files: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional list of file paths to limit the edit to',
            },
            model: {
              type: 'string',
              description: 'Optional model override',
            },
          },
          required: ['instruction'],
        },
      },
      ...getBabelfishMcpTools(),
    ],
  };
}

export async function handlePromptsList(): Promise<Record<string, unknown>> {
  return {
    prompts: ZEDGE_PROMPTS.map((prompt) => ({
      name: prompt.name,
      description: prompt.description,
      arguments: prompt.arguments ?? [],
    })),
  };
}

export async function handlePromptGet(
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const name = optionalString(params.name);
  if (!name) {
    throw new Error('Prompt name is required');
  }

  const prompt = ZEDGE_PROMPTS.find((candidate) => candidate.name === name);
  if (!prompt) {
    throw new Error(`Unknown prompt: ${name}`);
  }

  const providedArguments = asRecord(params.arguments);
  const argsText = optionalString(providedArguments.args);

  return {
    description: prompt.description,
    messages: [
      {
        role: 'user',
        content: {
          type: 'text',
          text: renderPromptText(prompt, argsText),
        },
      },
    ],
  };
}

export async function handleToolCall(
  params: Record<string, unknown>
): Promise<Record<string, unknown>> {
  const name = String(params.name ?? '');
  const args = asRecord(params.arguments);

  try {
    if (name.startsWith('zedge_babelfish_')) {
      const text = await callBabelfishMcpTool(getCompanionBase(), name, args);
      return {
        content: [{ type: 'text', text }],
      };
    }

    switch (name) {
      case 'zedge_command':
        return executeZedgeCommandTool(args);

      case 'zedge_infer': {
        const messages: Array<{ role: string; content: string }> = [];
        if (args.system) {
          messages.push({ role: 'system', content: String(args.system) });
        }
        messages.push({ role: 'user', content: String(args.prompt ?? '') });

        const resp = await fetch(`${getCompanionBase()}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: args.model ?? 'tinyllama-1.1b',
            messages,
            stream: false,
          }),
          signal: AbortSignal.timeout(120_000),
        });
        const data = await resp.json();
        const content =
          (data as any)?.choices?.[0]?.message?.content ?? JSON.stringify(data);
        return {
          content: [{ type: 'text', text: content }],
        };
      }

      case 'zedge_models': {
        const resp = await fetch(`${getCompanionBase()}/v1/models`, {
          signal: AbortSignal.timeout(10_000),
        });
        const data = await resp.json();
        return {
          content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
        };
      }

      case 'zedge_status': {
        const resp = await fetch(`${getCompanionBase()}/health`, {
          signal: AbortSignal.timeout(10_000),
        });
        const data = await resp.json();
        return {
          content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
        };
      }

      case 'zedge_apply_code': {
        const filePath = String(args.file_path ?? '');
        const search = String(args.search ?? '');
        const replace = String(args.replace ?? '');
        if (!filePath || !search) {
          return {
            content: [{ type: 'text', text: 'file_path and search are required' }],
            isError: true,
          };
        }

        // Read file, apply replacement, write back via companion VFS
        const fullPath = resolve(WORKSPACE_ROOT, filePath);
        let fileContent: string;
        try {
          fileContent = readFileSync(fullPath, 'utf-8');
        } catch {
          return {
            content: [{ type: 'text', text: `Cannot read file: ${filePath}` }],
            isError: true,
          };
        }

        if (!fileContent.includes(search)) {
          return {
            content: [{ type: 'text', text: `Search string not found in ${filePath}. The search must match exactly.` }],
            isError: true,
          };
        }

        const updated = fileContent.replace(search, replace);
        try {
          const { writeFileSync } = await import('fs');
          writeFileSync(fullPath, updated, 'utf-8');
          const lineCount = search.split('\n').length;
          return {
            content: [{ type: 'text', text: `Applied change to ${filePath} (replaced ${lineCount} line(s))` }],
          };
        } catch (writeErr) {
          return {
            content: [{ type: 'text', text: `Failed to write ${filePath}: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}` }],
            isError: true,
          };
        }
      }

      case 'zedge_search_codebase': {
        const query = String(args.query ?? '');
        const topK = typeof args.top_k === 'number' ? args.top_k : 5;
        const resp = await fetch(`${getCompanionBase()}/code-index/search`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query, topK }),
          signal: AbortSignal.timeout(30_000),
        });
        const data = await resp.json();
        return {
          content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
        };
      }

      case 'zedge_related_context': {
        const file = String(args.file_path ?? '');
        const fullFilePath = resolve(WORKSPACE_ROOT, file);
        const resp = await fetch(
          `${getCompanionBase()}/code-index/related?file=${encodeURIComponent(fullFilePath)}`,
          { signal: AbortSignal.timeout(10_000) }
        );
        const data = await resp.json();
        return {
          content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
        };
      }

      case 'zedge_workspace': {
        const [treeResp, changesResp] = await Promise.all([
          fetch(`${getCompanionBase()}/vfs/tree`, {
            signal: AbortSignal.timeout(10_000),
          }).catch(() => null),
          fetch(`${getCompanionBase()}/vfs/changes`, {
            signal: AbortSignal.timeout(10_000),
          }).catch(() => null),
        ]);
        const tree = treeResp ? await treeResp.text() : '(unavailable)';
        const changes = changesResp
          ? await changesResp.text()
          : '(unavailable)';
        return {
          content: [
            {
              type: 'text',
              text: `## File Tree\n${tree}\n\n## Git Changes\n${changes}`,
            },
          ],
        };
      }

      case 'zedge_multi_file_edit': {
        const instruction = String(args.instruction ?? '');
        if (!instruction) {
          return {
            content: [{ type: 'text', text: 'instruction is required' }],
            isError: true,
          };
        }
        const resp = await fetch(`${getCompanionBase()}/agent/multi-file`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            instruction,
            target_files: args.target_files,
            model: args.model,
          }),
          signal: AbortSignal.timeout(120_000),
        });
        const data = await resp.json();
        return {
          content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
        };
      }

      case 'zedge_daydream': {
        const action = String(args.action ?? 'candidates');
        const resp = await (async () => {
          switch (action) {
            case 'status':
              return fetch(`${getCompanionBase()}/cera/daydream/status`, {
                signal: AbortSignal.timeout(10_000),
              });
            case 'candidates':
              return fetch(`${getCompanionBase()}/cera/daydream/candidates`, {
                signal: AbortSignal.timeout(10_000),
              });
            case 'dream':
              return fetch(`${getCompanionBase()}/cera/daydream/dream`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ file_path: args.file_path }),
                signal: AbortSignal.timeout(120_000),
              });
            case 'accept':
              return fetch(`${getCompanionBase()}/cera/daydream/accept`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: args.id, apply: true }),
                signal: AbortSignal.timeout(120_000),
              });
            case 'reject':
              return fetch(`${getCompanionBase()}/cera/daydream/reject`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: args.id }),
                signal: AbortSignal.timeout(10_000),
              });
            default:
              return new Response(JSON.stringify({ error: `Unknown action: ${action}` }), { status: 400 });
          }
        })();
        const data = await resp.json();
        return {
          content: [{ type: 'text', text: JSON.stringify(data, null, 2) }],
        };
      }

      default:
        return {
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (err) {
    return {
      content: [
        {
          type: 'text',
          text: `Error calling ${name}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        },
      ],
      isError: true,
    };
  }
}

async function handleResourcesList(): Promise<Record<string, unknown>> {
  return { resources: [] };
}

// ---------- MCP message dispatch ----------

export async function dispatch(
  msg: JsonRpcRequest
): Promise<JsonRpcResponse | null> {
  const { id, method, params } = msg;

  // Notifications (no id) — just acknowledge
  if (id === undefined) {
    // notifications/initialized, etc. — no response needed
    return null;
  }

  try {
    let result: unknown;

    switch (method) {
      case 'initialize':
        result = handleInitialize(params ?? {});
        break;
      case 'tools/list':
        result = await handleToolsList();
        break;
      case 'prompts/list':
        result = await handlePromptsList();
        break;
      case 'prompts/get':
        result = await handlePromptGet(params ?? {});
        break;
      case 'tools/call':
        result = await handleToolCall(params ?? {});
        break;
      case 'resources/list':
        result = await handleResourcesList();
        break;
      case 'ping':
        result = {};
        break;
      default:
        return {
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        };
    }

    return { jsonrpc: '2.0', id, result };
  } catch (err) {
    return {
      jsonrpc: '2.0',
      id,
      error: {
        code: -32603,
        message: err instanceof Error ? err.message : String(err),
      },
    };
  }
}

// ---------- Stdio transport ----------

function send(response: JsonRpcResponse): void {
  const json = JSON.stringify(response);
  const header = `Content-Length: ${Buffer.byteLength(json)}\r\n\r\n`;
  process.stdout.write(header + json);
}

export async function main(): Promise<void> {
  configureStdioLogging();
  console.log('Starting MCP stdio bridge...');

  // Check if companion is already running; if not, spawn it
  const alreadyRunning = await isCompanionAlive();
  if (!alreadyRunning) {
    console.log('Companion not running, spawning it...');
    spawnCompanion();
  }

  // Wait for companion sidecar to become ready
  const alive = await waitForCompanion();
  if (!alive) {
    console.warn(
      'Companion sidecar not reachable at ' +
        getCompanionBase() +
        ' after spawn. Tools will fail until it starts.'
    );
  } else {
    console.log('Companion sidecar is ready');
  }

  // Start babysitter loop to keep companion alive
  startBabysitter();

  // Read stdin line-by-line (MCP uses Content-Length headers)
  let buffer = '';

  process.stdin.setEncoding('utf-8');
  process.stdin.on('data', async (chunk: string) => {
    buffer += chunk;

    // Parse Content-Length framed messages
    while (true) {
      const headerEnd = buffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;

      const headerBlock = buffer.slice(0, headerEnd);
      const match = headerBlock.match(/Content-Length:\s*(\d+)/i);
      if (!match) {
        // Skip malformed header
        buffer = buffer.slice(headerEnd + 4);
        continue;
      }

      const contentLength = parseInt(match[1], 10);
      const bodyStart = headerEnd + 4;

      if (buffer.length < bodyStart + contentLength) {
        // Incomplete body — wait for more data
        break;
      }

      const body = buffer.slice(bodyStart, bodyStart + contentLength);
      buffer = buffer.slice(bodyStart + contentLength);

      try {
        const msg = JSON.parse(body) as JsonRpcRequest;
        const response = await dispatch(msg);
        if (response) {
          send(response);
        }
      } catch (err) {
        console.warn('Failed to parse MCP message:', err);
        // Send parse error if we had an id somehow
        send({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error' },
        });
      }
    }
  });

  process.stdin.on('end', () => {
    console.log('stdin closed, exiting');
    process.exit(0);
  });
}

function isExecutedDirectly(importMetaUrl: string): boolean {
  const entryPath = process.argv[1];
  if (!entryPath) {
    return false;
  }

  return resolve(fileURLToPath(importMetaUrl)) === resolve(entryPath);
}

if (isExecutedDirectly(import.meta.url)) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
