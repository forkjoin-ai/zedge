import { afterAll, beforeAll, describe, expect, test } from '@a0n/gnosis/test';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { get } from 'http';
import { createServer } from 'net';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { resolveTypeScriptEntrypointCommand } from '../runtime-command';

interface ToolCallResult {
  content: Array<{ text?: string }>;
  isError?: boolean;
}

interface InferenceSelfTestPayload {
  model: string;
  companionStream: {
    url: string;
    status: number;
    ok: boolean;
    contentType: string | null;
    sawPrefill: boolean;
    sawHeartbeat: boolean;
    sawData: boolean;
    sawDone: boolean;
  };
  directCloudRunStream: unknown;
  cloudRunHealth: unknown;
}

interface CompanionHealthPayload {
  preferredModel: string;
  runtime: {
    hostRuntime: string;
  };
  inference: {
    localRuntime: {
      pid: number;
    };
  };
}

interface MoonshineAgentExecPayload {
  ok: boolean;
  events: Array<Record<string, unknown>>;
  metacog: Array<Record<string, unknown>>;
  final?: Record<string, unknown>;
  error?: string;
}

interface MoonshinePermissionsPayload {
  workspace_path: string;
  pending: Array<{
    run_id: string;
    status: string;
    risk: string;
    requested_action: string;
  }>;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../../../../');
const COMPANION_ENTRY = fileURLToPath(new URL('../index.ts', import.meta.url));
const MCP_STDIO_ENTRY = fileURLToPath(
  new URL('../mcp-stdio.ts', import.meta.url)
);

let companionProcess: ChildProcess | null = null;
let companionPort = 0;
let companionLogs = '';
let testHome = '';
let testWorkspace = '';
let fakeMoonshineBin = '';
let skipReason: string | null = null;

function isLoopbackListenDenied(error: unknown): boolean {
  return (
    error instanceof Error &&
    /listen EPERM|operation not permitted/i.test(error.message)
  );
}

function appendLogChunk(chunk: Buffer | string): void {
  companionLogs = `${companionLogs}${chunk.toString()}`;
  if (companionLogs.length > 16_000) {
    companionLogs = companionLogs.slice(-16_000);
  }
}

function getLogTail(): string {
  return companionLogs.trim().slice(-4_000);
}

async function getJson<T>(url: string, timeoutMs = 5_000): Promise<T> {
  return await new Promise<T>((resolveJson, reject) => {
    const request = get(
      url,
      {
        timeout: timeoutMs,
      },
      (response) => {
        if (
          (response.statusCode ?? 500) < 200 ||
          (response.statusCode ?? 500) >= 300
        ) {
          response.resume();
          reject(new Error(`Unexpected status ${response.statusCode ?? 500}`));
          return;
        }

        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          body += chunk;
        });
        response.once('end', () => {
          try {
            resolveJson(JSON.parse(body) as T);
          } catch (error) {
            reject(error);
          }
        });
      }
    );
    request.once('timeout', () => {
      request.destroy(new Error(`Timed out waiting for ${url}`));
    });
    request.once('error', reject);
  });
}

async function postJson<T>(
  url: string,
  body: Record<string, unknown>,
  timeoutMs = 10_000
): Promise<{ status: number; payload: T }> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return {
    status: response.status,
    payload: (await response.json()) as T,
  };
}

function writeFakeMoonshineProvider(path: string): void {
  writeFileSync(
    path,
    [
      '#!/usr/bin/env node',
      'const cIndex = process.argv.indexOf("-c");',
      'const command = cIndex >= 0 ? process.argv[cIndex + 1] ?? "" : "";',
      'const runId = "pact-smoke-run";',
      'const provider = command.includes("--provider codex") ? "codex" : command.includes("--provider claude") ? "claude" : "sovereign";',
      'const emit = (event) => console.log(JSON.stringify({ schemaVersion: 1, timestamp: new Date(0).toISOString(), run_id: runId, provider, ...event }));',
      'if (command.includes("agent resume --json")) {',
      '  if (command.includes("--decision approve")) {',
      '    emit({ type: "permission_decision", verdict: "escalate", status: "approve", reason: "human approved once", risk: "network", requested_action: "network access" });',
      '    emit({ type: "final", content: "pact-provider resumed ok" });',
      '    process.exit(0);',
      '  }',
      '  emit({ type: "permission_decision", verdict: "escalate", status: "deny", reason: "human denied", risk: "network", requested_action: "network access" });',
      '  emit({ type: "error", verdict: "veto", error: "human denied permission request" });',
      '  process.exit(12);',
      '}',
      'if (command.includes("agent providers --json")) {',
      '  emit({ type: "provider_status", provider: "sovereign", status: "available", content: "built-in Moonshine provider" });',
      '  emit({ type: "provider_status", provider: "codex", status: "available", content: "codex-cli fake" });',
      '  emit({ type: "provider_status", provider: "claude", status: "unavailable", content: "claude not installed in fake" });',
      '  emit({ type: "final", content: "available providers: sovereign, codex" });',
      '  process.exit(0);',
      '}',
      'if (command.includes("agent verify --json")) {',
      '  emit({ type: "run_start", workspace_path: process.cwd(), prompt: command, risk: "formal_claim", requested_action: "Lean formal admission", formal_target: "Gnosis.MoonshineMetacogProcess", verification_command: "lake build Gnosis.MoonshineMetacogProcess" });',
      '  emit({ type: "tool_request", workspace_path: process.cwd(), tool_name: "lean_build", command: "lake build Gnosis.MoonshineMetacogProcess", path: process.cwd(), risk: "formal_claim", requested_action: "Lean formal admission", formal_target: "Gnosis.MoonshineMetacogProcess", verification_command: "lake build Gnosis.MoonshineMetacogProcess" });',
      '  emit({ type: "tool_result", workspace_path: process.cwd(), tool_name: "lean_build", command: "lake build Gnosis.MoonshineMetacogProcess", path: process.cwd(), status: "passed", exit_code: 0, duration_ms: 1, risk: "formal_claim", requested_action: "Lean formal admission", formal_target: "Gnosis.MoonshineMetacogProcess", verification_command: "lake build Gnosis.MoonshineMetacogProcess", content: "Build completed successfully." });',
      '  emit({ type: "final", content: "Lean verification passed for Gnosis.MoonshineMetacogProcess", formal_target: "Gnosis.MoonshineMetacogProcess", verification_command: "lake build Gnosis.MoonshineMetacogProcess" });',
      '  process.exit(0);',
      '}',
      'if (!command.includes("agent exec --json")) {',
      '  console.error(`unexpected moonshine command: ${command}`);',
      '  process.exit(64);',
      '}',
      'if (!command.includes("--permission-mode ask")) {',
      '  console.error(`permission mode was not forwarded: ${command}`);',
      '  process.exit(65);',
      '}',
      'if (!command.includes("--provider ")) {',
      '  console.error(`provider was not forwarded: ${command}`);',
      '  process.exit(67);',
      '}',
      'if (!command.includes("--cwd ")) {',
      '  console.error(`cwd was not forwarded: ${command}`);',
      '  process.exit(66);',
      '}',
      'if (command.includes("malformed_provider")) {',
      '  console.log("not json");',
      '  process.exit(0);',
      '}',
      'emit({ type: "run_start", workspace_path: process.cwd(), prompt: command, risk: "read_only", requested_action: "read-only analysis" });',
      'if (command.includes("human_required")) {',
      '  emit({ type: "metacog_verdict", verdict: "escalate", reason: "secondary metacog chain requests human permission", risk: "network", requested_action: "network access" });',
      '  emit({ type: "permission_request", verdict: "escalate", reason: "secondary metacog chain requests human permission", risk: "network", requested_action: "network access", status: "pending", choices: ["approve_once", "deny"] });',
      '  emit({ type: "error", verdict: "escalate", error: "metacog escalate: secondary metacog chain requests human permission" });',
      '  process.exit(11);',
      '}',
      'if (command.includes(".lean")) {',
      '  emit({ type: "metacog_verdict", verdict: "reflect", reason: "Lean formal work requires an explicit verification target before finalizing", risk: "formal_claim", requested_action: "Lean formal admission", formal_target: "Gnosis/MoonshineMetacogProcess.lean", verification_command: "lake build Gnosis.MoonshineMetacogProcess" });',
      '  emit({ type: "assistant_delta", content: "lean pact reflection ok" });',
      '  emit({ type: "tool_request", workspace_path: process.cwd(), tool_name: "lean_build", command: "lake build Gnosis.MoonshineMetacogProcess", path: process.cwd(), risk: "formal_claim", requested_action: "Lean formal admission", formal_target: "Gnosis/MoonshineMetacogProcess.lean", verification_command: "lake build Gnosis.MoonshineMetacogProcess" });',
      '  emit({ type: "tool_result", workspace_path: process.cwd(), tool_name: "lean_build", command: "lake build Gnosis.MoonshineMetacogProcess", path: process.cwd(), status: "passed", exit_code: 0, duration_ms: 1, risk: "formal_claim", requested_action: "Lean formal admission", formal_target: "Gnosis/MoonshineMetacogProcess.lean", verification_command: "lake build Gnosis.MoonshineMetacogProcess", content: "Build completed successfully." });',
      '  emit({ type: "final", content: "lean pact reflection ok", formal_target: "Gnosis/MoonshineMetacogProcess.lean", verification_command: "lake build Gnosis.MoonshineMetacogProcess" });',
      '  process.exit(0);',
      '}',
      'emit({ type: "metacog_verdict", verdict: "proceed", reason: "pact provider accepted bounded event log", risk: "read_only", requested_action: "read-only analysis" });',
      'emit({ type: "assistant_delta", content: "pact-provider smoke ok" });',
      'emit({ type: "final", content: "pact-provider smoke ok" });',
    ].join('\n'),
    'utf8'
  );
  chmodSync(path, 0o755);
}

async function reservePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('Could not determine reserved port'));
        return;
      }

      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolvePort(port);
      });
    });
  });
}

async function waitForCompanionHealth(
  port: number,
  timeoutMs = 45_000
): Promise<void> {
  const url = `http://127.0.0.1:${port}/health`;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (
      companionProcess?.exitCode !== null &&
      companionProcess?.exitCode !== undefined
    ) {
      throw new Error(
        `Companion exited early with code ${
          companionProcess.exitCode
        }\n${getLogTail()}`
      );
    }

    try {
      await getJson<CompanionHealthPayload>(url, 1_000);
      return;
    } catch {
      // Still booting.
    }

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }

  throw new Error(
    `Timed out waiting for companion health on ${url}\n${getLogTail()}`
  );
}

async function fetchCompanionHealth(
  port: number
): Promise<CompanionHealthPayload> {
  const payload = (await getJson<Partial<CompanionHealthPayload>>(
    `http://127.0.0.1:${port}/health`
  )) as Partial<CompanionHealthPayload>;
  if (
    typeof payload.preferredModel !== 'string' ||
    typeof payload.runtime?.hostRuntime !== 'string' ||
    typeof payload.inference?.localRuntime?.pid !== 'number'
  ) {
    throw new Error(
      `Companion health payload missing runtime data\n${JSON.stringify(
        payload,
        null,
        2
      )}\n${getLogTail()}`
    );
  }
  return payload as CompanionHealthPayload;
}

async function stopCompanion(): Promise<void> {
  const child = companionProcess;
  companionProcess = null;

  if (!child || child.exitCode !== null || child.killed) {
    return;
  }

  await new Promise<void>((resolveStop) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(forceKillTimer);
      clearTimeout(resolveTimer);
      resolveStop();
    };
    const sendSignal = (signal: NodeJS.Signals) => {
      try {
        if (child.pid !== undefined) {
          process.kill(-child.pid, signal);
          return;
        }
      } catch {
        // Fall through to direct child kill.
      }
      try {
        child.kill(signal);
      } catch {
        // Best-effort cleanup only.
      }
    };
    const forceKillTimer = setTimeout(() => {
      sendSignal('SIGKILL');
    }, 2_000);
    const resolveTimer = setTimeout(() => {
      finish();
    }, 7_000);

    child.once('exit', finish);
    child.once('close', finish);

    try {
      sendSignal('SIGTERM');
    } catch {
      finish();
    }
  });
}

async function runMcpToolInSubprocess(
  command: string,
  args?: string
): Promise<ToolCallResult> {
  const request = {
    jsonrpc: '2.0' as const,
    id: `e2e-${command}`,
    method: 'tools/call',
    params: {
      name: 'zedge_command',
      arguments: {
        command,
        ...(args ? { args } : {}),
      },
    },
  };
  const runtimeCommand = resolveTypeScriptEntrypointCommand(MCP_STDIO_ENTRY);
  const payload = JSON.stringify(request);
  const framedPayload = `Content-Length: ${Buffer.byteLength(
    payload
  )}\r\n\r\n${payload}`;
  const runnerOutputPath = join(
    testWorkspace || REPO_ROOT,
    `.zedge-mcp-${command}.runner.json`
  );
  const nodeRunner = [
    "const { writeFileSync } = require('node:fs');",
    "const { spawnSync } = require('node:child_process');",
    'const [command, argsJson, cwd, homeDir, repoRoot, port, framedPayload, outputPath] = process.argv.slice(1);',
    'const result = spawnSync(command, JSON.parse(argsJson), {',
    '  cwd,',
    '  env: { ...process.env, HOME: homeDir, AEON_ROOT: repoRoot, ZEDGE_COMPANION_PORT: port },',
    '  input: framedPayload,',
    "  encoding: 'utf8',",
    '  timeout: 15000,',
    '});',
    'writeFileSync(outputPath, JSON.stringify({',
    '  status: result.status,',
    '  stdout: result.stdout ?? "",',
    '  stderr: result.stderr ?? "",',
    '  error: result.error ? { message: result.error.message } : null,',
    '}), "utf8");',
  ].join('\n');
  const result = spawnSync(
    'node',
    [
      '-e',
      nodeRunner,
      runtimeCommand.command,
      JSON.stringify(runtimeCommand.args),
      testWorkspace || REPO_ROOT,
      testHome,
      REPO_ROOT,
      String(companionPort),
      framedPayload,
      runnerOutputPath,
    ],
    {
      encoding: 'utf8',
      timeout: 15_000,
    }
  );
  if (result.status !== 0) {
    throw new Error(
      `Node runner failed for ${command} with code ${result.status}\nstdout=${
        result.stdout ?? ''
      }\nstderr=${result.stderr ?? ''}\n${getLogTail()}`
    );
  }

  const runnerResult = JSON.parse(readFileSync(runnerOutputPath, 'utf8')) as {
    status: number | null;
    stdout: string;
    stderr: string;
    error: { message: string } | null;
  };
  const stdout = runnerResult.stdout;
  const stderr = runnerResult.stderr;
  const exitCode = runnerResult.status;
  if (exitCode !== 0) {
    throw new Error(
      `MCP subprocess failed for ${command} with code ${exitCode}\nstdout=${stdout}\nstderr=${stderr}\n${getLogTail()}`
    );
  }

  const headerEnd = stdout.indexOf('\r\n\r\n');
  if (headerEnd === -1) {
    throw new Error(
      `MCP subprocess produced no framed response for ${command}\nstdout=${stdout}\nstderr=${stderr}\n${getLogTail()}`
    );
  }
  const headerBlock = stdout.slice(0, headerEnd);
  const lengthMatch = headerBlock.match(/Content-Length:\s*(\d+)/i);
  if (!lengthMatch) {
    throw new Error(
      `MCP subprocess response missing Content-Length for ${command}\nstdout=${stdout}\nstderr=${stderr}\n${getLogTail()}`
    );
  }
  const contentLength = Number.parseInt(lengthMatch[1], 10);
  const responseBody = stdout.slice(
    headerEnd + 4,
    headerEnd + 4 + contentLength
  );

  const response = JSON.parse(responseBody) as {
    result?: ToolCallResult;
    error?: { message?: string };
  };

  if (response.error) {
    throw new Error(
      `MCP tool call failed for ${command}: ${
        response.error.message ?? 'unknown error'
      }\n${getLogTail()}`
    );
  }

  return response.result as ToolCallResult;
}

async function callZedgeCommand(
  command: string,
  args?: string
): Promise<string> {
  const result = await runMcpToolInSubprocess(command, args);
  const text = result.content[0]?.text;
  if (result.isError || typeof text !== 'string') {
    throw new Error(
      `Slash command ${command} returned an error result\n${JSON.stringify(
        result,
        null,
        2
      )}\n${getLogTail()}`
    );
  }

  return text;
}

describe('Zedge slash commands end to end', () => {
  beforeAll(async () => {
    try {
      companionPort = await reservePort();

      testHome = mkdtempSync(join(tmpdir(), 'zedge-slash-e2e-'));
      testWorkspace = mkdtempSync(join(tmpdir(), 'zedge-workspace-e2e-'));
      mkdirSync(join(testHome, '.edgework'), { recursive: true });
      fakeMoonshineBin = join(testWorkspace, 'fake-moonshine-provider.mjs');
      writeFakeMoonshineProvider(fakeMoonshineBin);

      const runtimeCommand = resolveTypeScriptEntrypointCommand(COMPANION_ENTRY);
      companionProcess = spawn(runtimeCommand.command, [...runtimeCommand.args], {
        // Keep the companion on a tiny workspace so startup does not spend the
        // health-check budget traversing the full monorepo before the live MCP
        // slash-command path is ready.
        cwd: testWorkspace,
        env: {
          ...process.env,
          HOME: testHome,
          AEON_ROOT: REPO_ROOT,
          ZEDGE_MOONSHINE_BIN: fakeMoonshineBin,
          ZEDGE_COMPANION_PORT: String(companionPort),
          ZEDGE_LISTENER_MODE: 'bun',
        },
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      companionProcess.stdout?.on('data', appendLogChunk);
      companionProcess.stderr?.on('data', appendLogChunk);

      await waitForCompanionHealth(companionPort);
    } catch (error) {
      if (isLoopbackListenDenied(error)) {
        skipReason = error.message;
        return;
      }
      throw error;
    }
  }, 45_000);

  afterAll(async () => {
    await stopCompanion();
  });

  test('companion launches through gnode', async () => {
    if (skipReason !== null) {
      return;
    }

    const health = await fetchCompanionHealth(companionPort);
    expect(health.runtime.hostRuntime).toBe('gnode');
    expect(health.preferredModel).toBe('wasm-local');
    expect(health.inference.localRuntime.pid).toBeGreaterThan(0);
  }, 20_000);

  test('moonshine agent exec route satisfies the provider pact smoke', async () => {
    if (skipReason !== null) {
      return;
    }

    const { status, payload } = await postJson<MoonshineAgentExecPayload>(
      `http://127.0.0.1:${companionPort}/moonshine/agent/exec`,
      {
        prompt: 'write a pact smoke response',
        permission_mode: 'ask',
        workspace_path: testWorkspace,
      }
    );

    expect(status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.events.map((event) => event.type)).toEqual([
      'run_start',
      'metacog_verdict',
      'assistant_delta',
      'final',
    ]);
    expect(payload.metacog).toHaveLength(1);
    expect(payload.metacog[0]?.verdict).toBe('proceed');
    expect(payload.final?.content).toBe('pact-provider smoke ok');
  }, 20_000);

  test('moonshine agent exec route forwards account-backed provider selection', async () => {
    if (skipReason !== null) {
      return;
    }

    const { status, payload } = await postJson<MoonshineAgentExecPayload>(
      `http://127.0.0.1:${companionPort}/moonshine/agent/exec`,
      {
        prompt: 'write a codex-backed pact smoke response',
        permission_mode: 'ask',
        provider: 'codex',
        workspace_path: testWorkspace,
      }
    );

    expect(status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.events[0]?.provider).toBe('codex');
    expect(payload.final?.provider).toBe('codex');
  }, 20_000);

  test('moonshine agent exec route preserves Lean formal metadata', async () => {
    if (skipReason !== null) {
      return;
    }

    const { status, payload } = await postJson<MoonshineAgentExecPayload>(
      `http://127.0.0.1:${companionPort}/moonshine/agent/exec`,
      {
        prompt: 'edit Gnosis/MoonshineMetacogProcess.lean',
        permission_mode: 'ask',
        workspace_path: testWorkspace,
      }
    );

    expect(status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.metacog[0]?.risk).toBe('formal_claim');
    expect(payload.metacog[0]?.formal_target).toBe(
      'Gnosis/MoonshineMetacogProcess.lean'
    );
    expect(payload.metacog[0]?.verification_command).toBe(
      'lake build Gnosis.MoonshineMetacogProcess'
    );
    expect(
      payload.events.some(
        (event) =>
          event.type === 'tool_result' &&
          event.tool_name === 'lean_build' &&
          event.status === 'passed'
      )
    ).toBe(true);
    const finalIndex = payload.events.findIndex((event) => event.type === 'final');
    const verifierIndex = payload.events.findIndex(
      (event) => event.type === 'tool_result'
    );
    expect(verifierIndex).toBeGreaterThanOrEqual(0);
    expect(finalIndex).toBeGreaterThan(verifierIndex);
  }, 20_000);

  test('moonshine agent verify route emits Lean verifier tool events', async () => {
    if (skipReason !== null) {
      return;
    }

    const { status, payload } = await postJson<MoonshineAgentExecPayload>(
      `http://127.0.0.1:${companionPort}/moonshine/agent/verify`,
      {
        formal_target: 'Gnosis.MoonshineMetacogProcess',
        workspace_path: testWorkspace,
      }
    );

    expect(status).toBe(200);
    expect(payload.ok).toBe(true);
    expect(payload.events.some((event) => event.type === 'tool_request')).toBe(
      true
    );
    expect(
      payload.events.some(
        (event) =>
          event.type === 'tool_result' &&
          event.tool_name === 'lean_build' &&
          event.status === 'passed'
      )
    ).toBe(true);
    expect(payload.final?.content).toContain('Lean verification passed');
  }, 20_000);

  test('moonshine agent providers route reports account-backed providers', async () => {
    if (skipReason !== null) {
      return;
    }

    const payload = await getJson<MoonshineAgentExecPayload>(
      `http://127.0.0.1:${companionPort}/moonshine/agent/providers?workspace_path=${encodeURIComponent(
        testWorkspace
      )}`
    );

    expect(payload.ok).toBe(true);
    expect(
      payload.events.some(
        (event) =>
          event.type === 'provider_status' &&
          event.provider === 'sovereign' &&
          event.status === 'available'
      )
    ).toBe(true);
    expect(payload.final?.content).toContain('available providers');
  }, 20_000);

  test('moonshine agent exec route returns permission requests for human escalation', async () => {
    if (skipReason !== null) {
      return;
    }

    const { status, payload } = await postJson<MoonshineAgentExecPayload>(
      `http://127.0.0.1:${companionPort}/moonshine/agent/exec`,
      {
        prompt: 'human_required before mutating files',
        permission_mode: 'ask',
        workspace_path: testWorkspace,
      }
    );

    expect(status).toBe(400);
    expect(payload.ok).toBe(false);
    expect(payload.metacog[0]?.verdict).toBe('escalate');
    expect(payload.events.some((event) => event.type === 'permission_request')).toBe(
      true
    );
    expect(payload.error).toContain('human permission');
  }, 20_000);

  test('moonshine agent exec route fails closed on malformed provider output', async () => {
    if (skipReason !== null) {
      return;
    }

    const { status, payload } = await postJson<MoonshineAgentExecPayload>(
      `http://127.0.0.1:${companionPort}/moonshine/agent/exec`,
      {
        prompt: 'malformed_provider',
        permission_mode: 'ask',
        workspace_path: testWorkspace,
      }
    );

    expect(status).toBe(400);
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain('malformed JSONL');
  }, 20_000);

  test('moonshine permission routes list and resume pending requests', async () => {
    if (skipReason !== null) {
      return;
    }

    const permissionDir = join(testWorkspace, '.moonshine', 'agent-permissions');
    mkdirSync(permissionDir, { recursive: true });
    writeFileSync(
      join(permissionDir, 'pact-smoke-run.json'),
      JSON.stringify({
        schema_version: 1,
        run_id: 'pact-smoke-run',
        workspace_path: testWorkspace,
        permission_mode: 'ask',
        prompt: 'network smoke',
        verdict: 'escalate',
        reason: 'secondary metacog chain requests human permission',
        requested_action: 'network access',
        risk: 'network',
        status: 'pending',
        created_at: new Date(0).toISOString(),
      }),
      'utf8'
    );

    const permissions = await getJson<MoonshinePermissionsPayload>(
      `http://127.0.0.1:${companionPort}/moonshine/agent/permissions?workspace_path=${encodeURIComponent(
        testWorkspace
      )}`
    );
    expect(permissions.pending.map((record) => record.run_id)).toContain(
      'pact-smoke-run'
    );
    expect(permissions.pending[0]?.risk).toBe('network');

    const approved = await postJson<MoonshineAgentExecPayload>(
      `http://127.0.0.1:${companionPort}/moonshine/agent/permissions/pact-smoke-run/approve`,
      { workspace_path: testWorkspace }
    );
    expect(approved.status).toBe(200);
    expect(approved.payload.ok).toBe(true);
    expect(approved.payload.final?.content).toBe('pact-provider resumed ok');

    const denied = await postJson<MoonshineAgentExecPayload>(
      `http://127.0.0.1:${companionPort}/moonshine/agent/permissions/pact-smoke-run/deny`,
      { workspace_path: testWorkspace }
    );
    expect(denied.status).toBe(400);
    expect(denied.payload.ok).toBe(false);
    expect(denied.payload.error).toContain('human denied');
  }, 20_000);

  test('zedge-models returns the local wasm model through the live companion', async () => {
    if (skipReason !== null) {
      return;
    }

    const text = await callZedgeCommand('zedge-models');
    expect(text).toContain('"id": "wasm-local"');
    expect(text).toContain('"owned_by": "edgework-wasm"');
  }, 20_000);

  test('zedge-selftest reaches the local inference path through the live command surface', async () => {
    if (skipReason !== null) {
      return;
    }

    const text = await callZedgeCommand(
      'zedge-selftest',
      'wasm-local-only-test'
    );
    const payload = JSON.parse(text) as InferenceSelfTestPayload;

    expect(payload.model).toBe('wasm-local-only-test');
    expect(payload.cloudRunHealth).toBeNull();
    expect(payload.directCloudRunStream).toBeNull();
    expect(payload.companionStream.url).toBe(
      `http://127.0.0.1:${companionPort}/v1/chat/completions`
    );
    expect(payload.companionStream.status).toBe(200);
    expect(payload.companionStream.ok).toBe(true);
    expect(payload.companionStream.contentType).toContain('text/event-stream');
    expect(payload.companionStream.sawData).toBe(true);
    expect(payload.companionStream.sawDone).toBe(true);
  }, 120_000);

  test('zedge-agent run reaches Moonshine through the live slash command surface', async () => {
    if (skipReason !== null) {
      return;
    }

    const text = await callZedgeCommand(
      'zedge-agent',
      'run write a pact smoke response'
    );
    expect(text).toContain('## Moonshine Agent');
    expect(text).toContain('"type": "metacog_verdict"');
    expect(text).toContain('"verdict": "proceed"');
    expect(text).toContain('pact-provider smoke ok');
  }, 20_000);

  test('zedge-agent run forwards Claude provider selection', async () => {
    if (skipReason !== null) {
      return;
    }

    const text = await callZedgeCommand(
      'zedge-agent',
      'run --provider claude write a pact smoke response'
    );
    expect(text).toContain('## Moonshine Agent');
    expect(text).toContain('"provider": "claude"');
    expect(text).toContain('pact-provider smoke ok');
  }, 20_000);

  test('zedge-agent permissions reaches the Moonshine permission surface', async () => {
    if (skipReason !== null) {
      return;
    }

    const text = await callZedgeCommand('zedge-agent', 'permissions');
    expect(text).toContain('## Moonshine Agent');
    expect(text).toContain('"pending"');
  }, 20_000);

  test('zedge-agent providers reaches the Moonshine provider surface', async () => {
    if (skipReason !== null) {
      return;
    }

    const text = await callZedgeCommand('zedge-agent', 'providers');
    expect(text).toContain('## Moonshine Agent');
    expect(text).toContain('"type": "provider_status"');
    expect(text).toContain('"provider": "sovereign"');
  }, 20_000);

  test('zedge-agent verify reaches the Lean verifier surface', async () => {
    if (skipReason !== null) {
      return;
    }

    const text = await callZedgeCommand(
      'zedge-agent',
      'verify Gnosis.MoonshineMetacogProcess'
    );
    expect(text).toContain('## Moonshine Agent');
    expect(text).toContain('"type": "tool_result"');
    expect(text).toContain('"tool_name": "lean_build"');
    expect(text).toContain('Lean verification passed');
  }, 20_000);
});
