/**
 * Zedge Companion HTTP Server (v2.0)
 *
 * localhost:7331 — OpenAI-compatible proxy + compute pool + mesh + superinference + ACP agent + forge
 */

import { spawn as nodeSpawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join as pathJoin, dirname as pathDirname } from 'path';
import { fileURLToPath } from 'url';
import {
  XGnosisServer,
  resolveGnosisUringCommand,
  type RequestPayload,
  type ResponsePayload,
  type XGnosisControlSurface,
} from '@a0n/x-gnosis';

import {
  infer,
  inferFim,
  buildFimPrompt,
  getModels,
  embed,
  createSSEProxyStream,
  getRecentLogs,
  clearLogs,
} from './inference-bridge';
import type { TierAttempt } from './inference-bridge';
import { fimCache, fimCacheKey, speculativePrefetch } from './fim-cache';
import { joinPool, leavePool, getPoolStatus } from './compute-node';
import { getRecentFeedback, recordFeedback } from './feedback-log';
import { getCompanionPort, getZedgeConfig } from './config';
import { handleBabelfishRequest } from './babelfish-routes';
import {
  startMesh,
  stopMesh,
  getMeshStatus,
  handlePeerRequest,
} from './p2p-mesh';
import { login, logout, whoami } from './auth';
import {
  getTierHealth,
  getProbeResults,
  getFastestTier,
} from './latency-probe';
import { runInferenceSelfTest } from './selftest';
import { createResilientStream, getActiveSessions } from './stream-reconnect';
import { superinfer, recursiveSuperinfer } from './superinference';
import type { CollapseStrategy, RecursiveRequest } from './superinference';
import {
  createSession,
  getSession,
  deleteSession,
  agentTurn,
} from './acp-agent';
import type { AgentCapabilities } from './acp-agent';
import {
  encode as binaryEncode,
  decode as binaryDecode,
  isValidFrame,
  CONTENT_TYPE as BINARY_CONTENT_TYPE,
} from './binary-protocol';
import type { ChatCompletionRequest } from './inference-bridge';
import type { ForgeBridge } from './forge-bridge';
import type { CeraBridge } from './cera-bridge';
import {
  superinferWithPreset,
  getCompositionPreset,
  COMPOSITION_PRESETS,
} from './superinference';
// Gnosis modules -- lazy-loaded to avoid blocking the event loop at startup.
// The file watcher, incremental checker, and betty compiler are CPU-heavy and
// scanning the entire workspace directory on import would prevent Bun.serve
// from ever processing HTTP requests.
let _gnosisWatcher: any = null;
let _gnosisIncrementalChecker: any = null;
let _gnosisModules: {
  BettyCompiler: any;
  checkTypeScriptWithGnosis: any;
  generateAutofixSuggestions: any;
} | null = null;
const gnosisSseClients = new Set<ReadableStreamDefaultController>();
let _gnosisInitStarted = false;

async function ensureGnosisModules() {
  if (_gnosisModules) return _gnosisModules;
  const [betty, tsCheck, tsAutofix] = await Promise.all([
    import('../../../gnosis/src/betty/compiler'),
    import('../../../gnosis/src/ts-check'),
    import('../../../gnosis/src/ts-check-autofix'),
  ]);
  _gnosisModules = {
    BettyCompiler: betty.BettyCompiler,
    checkTypeScriptWithGnosis: tsCheck.checkTypeScriptWithGnosis,
    generateAutofixSuggestions: tsAutofix.generateAutofixSuggestions,
  };
  return _gnosisModules;
}

function getGnosisIncrementalChecker() {
  if (!_gnosisIncrementalChecker) {
    // Lazy-create on first use
    const { GnosisIncrementalChecker } = require('../../../gnosis/src/ts-check-incremental');
    _gnosisIncrementalChecker = new GnosisIncrementalChecker();
  }
  return _gnosisIncrementalChecker;
}

/** Start gnosis file watcher -- called after server is listening. */
export function startGnosisWatcher(): void {
  if (_gnosisInitStarted) return;
  _gnosisInitStarted = true;

  import('../../../gnosis/src/ts-check-watcher').then(({ GnosisFileWatcher }) => {
    _gnosisWatcher = new GnosisFileWatcher({
      debounceMs: 500,
      enableAutofix: true,
    });
    _gnosisWatcher.addListener((event: any) => {
      if (event.type === 'check-complete' && event.result) {
        const payload = JSON.stringify({
          type: 'topology-update',
          filePath: event.filePath,
          timestamp: event.timestamp,
          nodes: event.result.topology.nodes,
          edges: event.result.topology.edges,
          metrics: event.result.metrics,
          diagnostics: event.result.diagnostics,
          autofixes: event.autofixes ?? [],
        });
        const encoder = new TextEncoder();
        for (const controller of gnosisSseClients) {
          try {
            controller.enqueue(encoder.encode(`data: ${payload}\n\n`));
          } catch {
            gnosisSseClients.delete(controller);
          }
        }

        // Auto-refresh code index on file change
        if (event.filePath) {
          import('./code-index').then(({ codeIndex }) => {
            void codeIndex.reindexFile(event.filePath);
          }).catch(() => {});
        }
      }
    });
    const workspaceRoot = process.env.AEON_ROOT || process.cwd();
    void _gnosisWatcher.watchDirectory(workspaceRoot);
    console.log(`[zedge] Gnosis file watcher started for ${workspaceRoot}`);
  }).catch((err) => {
    console.warn(`[zedge] Gnosis file watcher failed to start: ${err}`);
  });
}
import type { VfsBridge } from './vfs-bridge';
import type { CollabBridge, CollabPresenceUpdate } from './collab-bridge';
import type { KernelBridge } from './kernel-bridge';
import type {
  CapacitorBridge,
  ProjectionType,
  CodeBlock,
} from './capacitor-bridge';
import type { CrdtBridge } from './crdt-bridge';
import { generateInvite, parseRoomUcan, isRoomUcanExpired } from './ucan-scope';
import type { ZedgeAccessMode } from './ucan-scope';
import type { UcanBridge, AgentMode } from './ucan-bridge';
import type { UcanCapability } from '@affectively/auth';
import { AgentParticipant } from './agent-participant';
import type { AgentEdit, AgentReplacement } from './agent-participant';
import { getMarketStatus } from './compute-node';

// --- Shell exec helper (replaces Bun.spawn) ---

/** Characters that could escape a shell argument and cause injection */
const SHELL_METACHAR_RE = /[;&|`$(){}[\]!#~<>\\'"]/;

function execShell(
  command: string,
  options: { cwd?: string; timeout?: number } = {}
): Promise<{ output: string; exitCode: number }> {
  // Reject commands containing shell metacharacters beyond the allowed prefix.
  // The caller is responsible for verifying the prefix (e.g. "edgework " or "aeon ").
  // This is a defense-in-depth measure against injection via the argument portion.
  const spaceIdx = command.indexOf(' ');
  const argsPortion = spaceIdx >= 0 ? command.slice(spaceIdx + 1) : '';
  if (SHELL_METACHAR_RE.test(argsPortion)) {
    return Promise.resolve({
      output: 'Rejected: command arguments contain disallowed shell metacharacters',
      exitCode: 1,
    });
  }

  return new Promise((resolve) => {
    const proc = nodeSpawn('bash', ['-c', command], {
      cwd: options.cwd ?? process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Buffer[] = [];
    proc.stdout?.on('data', (chunk: Buffer) => chunks.push(chunk));
    proc.stderr?.on('data', (chunk: Buffer) => chunks.push(chunk));

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (options.timeout) {
      timer = setTimeout(() => {
        proc.kill('SIGTERM');
      }, options.timeout);
    }

    proc.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ output: Buffer.concat(chunks).toString('utf-8'), exitCode: code ?? 1 });
    });
    proc.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({ output: err.message, exitCode: 1 });
    });
  });
}

// --- Request body types ---

interface ChatRequestBody {
  model?: string;
  messages?: Array<{ role: string; content: string }>;
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
}

interface CompletionRequestBody extends ChatRequestBody {
  prompt?: string;
}

interface EmbeddingRequestBody {
  input?: string | string[];
  model?: string;
}

interface SuperinferenceRequestBody {
  model?: string;
  messages?: Array<{ role: string; content: string }>;
  models?: string[];
  strategy?: CollapseStrategy;
  timeout_ms?: number;
  temperature?: number;
  max_tokens?: number;
}

interface RecursiveRequestBody {
  prompt?: string;
  models?: string[];
  strategy?: CollapseStrategy;
  max_depth?: number;
  max_token_budget?: number;
}

interface AgentSessionRequestBody {
  workspace_path?: string;
  capabilities?: Partial<AgentCapabilities>;
}

interface AgentTurnRequestBody {
  session_id?: string;
  message?: string;
}

interface ForgeDeployRequestBody {
  project?: string;
}

// --- System prompt compaction for small models ---

/**
 * Detect and replace bloated system prompts (CLAUDE.md, etc.) that overwhelm
 * small-context models. Zed injects project rules into system messages —
 * a 20K-token CLAUDE.md leaves almost nothing for a 7B model's context window.
 *
 * Strategy: if any system message exceeds the threshold, replace it with the
 * lean EDGEWORK.md content (cached on first use).
 */
const SYSTEM_PROMPT_THRESHOLD = 2000; // chars — CLAUDE.md is ~15K+

let _edgeworkPrompt: string | null = null;

const _serverDirname = pathDirname(fileURLToPath(import.meta.url));

function getEdgeworkPrompt(): string {
  if (_edgeworkPrompt !== null) return _edgeworkPrompt;
  try {
    // Walk up from companion/src to find EDGEWORK.md at repo root
    let dir = _serverDirname;
    for (let i = 0; i < 10; i++) {
      const candidate = pathJoin(dir, 'EDGEWORK.md');
      if (existsSync(candidate)) {
        _edgeworkPrompt = readFileSync(candidate, 'utf-8');
        return _edgeworkPrompt!;
      }
      dir = pathDirname(dir);
    }
  } catch {
    // Fall through to default
  }
  _edgeworkPrompt =
    'You are a coding assistant for an Nx/TypeScript monorepo. Be concise and code-focused.';
  return _edgeworkPrompt;
}

function compactSystemPrompts(
  messages: Array<{ role: string; content: string }>
): Array<{ role: string; content: string }> {
  return messages.map((msg) => {
    if (msg.role === 'system' && msg.content.length > SYSTEM_PROMPT_THRESHOLD) {
      return { role: 'system', content: getEdgeworkPrompt() };
    }
    return msg;
  });
}

// --- Helpers ---

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function deprecatedJsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'X-Deprecated': 'Use /crdt/* endpoints instead',
    },
  });
}

/**
 * Build diagnostic headers from tier attempts.
 * X-Zedge-Chain: mesh:skipped(2ms);edge:timeout(15003ms);cloudrun:ok(1200ms)
 * X-Zedge-Attempts: JSON array of all attempts for detailed debugging
 */
function buildAttemptHeaders(attempts: TierAttempt[]): Record<string, string> {
  const chain = attempts
    .map((a) => {
      const detail = a.detail ? `[${a.detail.slice(0, 60)}]` : '';
      return `${a.tier}:${a.status}(${a.ms}ms)${detail}`;
    })
    .join('; ');
  return {
    'X-Zedge-Chain': chain,
    'X-Zedge-Attempts': JSON.stringify(attempts),
  };
}

function corsHeaders(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers':
        'Content-Type, Authorization, X-Zedge-Session',
      'Access-Control-Expose-Headers': '*',
    },
  });
}

// --- Bridges (set during server start) ---

let forgeBridge: ForgeBridge | null = null;
let ceraBridge: CeraBridge | null = null;
let vfsBridge: VfsBridge | null = null;
let collabBridge: CollabBridge | null = null;
let kernelBridge: KernelBridge | null = null;
let capacitorBridge: CapacitorBridge | null = null;
let crdtBridge: CrdtBridge | null = null;
let ucanBridge: UcanBridge | null = null;
const agentParticipants = new Map<string, AgentParticipant>();

export function setForgeBridge(bridge: ForgeBridge): void {
  forgeBridge = bridge;
}

export function setCeraBridge(bridge: CeraBridge): void {
  ceraBridge = bridge;
}

export function setVfsBridge(bridge: VfsBridge): void {
  vfsBridge = bridge;
}

export function setCollabBridge(bridge: CollabBridge): void {
  collabBridge = bridge;
}

export function setKernelBridge(bridge: KernelBridge): void {
  kernelBridge = bridge;
}

export function setCapacitorBridge(bridge: CapacitorBridge): void {
  capacitorBridge = bridge;
}

export function setCrdtBridge(bridge: CrdtBridge): void {
  crdtBridge = bridge;
}

export function setUcanBridge(bridge: UcanBridge): void {
  ucanBridge = bridge;
}

/**
 * Safely extract JSON from a Response, handling SSE responses that
 * upstream coordinators return even when stream:false was requested.
 */
async function extractResponseData(
  resp: Response,
  fallbackModel = 'unknown'
): Promise<Record<string, unknown>> {
  const ct = resp.headers.get('content-type') ?? '';
  if (ct.includes('text/event-stream') || ct.includes('text/plain')) {
    const text = await resp.text();
    let content = '';
    let model = fallbackModel;
    let id = `chatcmpl-${Date.now()}`;
    for (const line of text.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      const payload = line.slice(6).trim();
      if (payload === '[DONE]') break;
      try {
        const chunk = JSON.parse(payload);
        if (chunk.choices?.[0]?.delta?.content) {
          content += chunk.choices[0].delta.content;
        } else if (chunk.choices?.[0]?.message?.content) {
          content += chunk.choices[0].message.content;
        }
        if (chunk.model) model = chunk.model;
        if (chunk.id) id = chunk.id;
      } catch {
        // Skip non-JSON payloads like {"status":"ready"}
      }
    }
    return {
      id,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
  }
  return await resp.json();
}

// --- Request Handler ---

export async function handleWebRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  // Request logging
  if (path !== '/health') {
    console.log(`[zedge:http] ${req.method} ${path}`);
  }

  // CORS preflight
  if (req.method === 'OPTIONS') {
    return corsHeaders();
  }

  // ==================== Health ====================

  if (path === '/health' && req.method === 'GET') {
    const config = getZedgeConfig();
    const pool = getPoolStatus();
    const mesh = getMeshStatus();
    return jsonResponse({
      status: 'ok',
      version: '2.0.0',
      port: config.port,
      preferredModel: config.preferredModel,
      computePool: {
        joined: pool.joined,
        tokensEarned: pool.tokensEarned,
        requestsServed: pool.requestsServed,
      },
      mesh: {
        running: mesh.running,
        nodeId: mesh.nodeId,
        peerCount: mesh.peers.length,
        totalModels: mesh.totalCapacity.models.length,
        totalCores: mesh.totalCapacity.totalCores,
        totalMemoryMb: mesh.totalCapacity.totalMemoryMb,
      },
      inference: {
        tiers: ['mesh', 'edge', 'cloudrun', 'wasm', 'echo'],
        meshAvailable: mesh.running && mesh.peers.length > 0,
        edgeAvailable: true,
        cloudRunDirect: config.cloudRunDirect,
        wasmLocal: true,
      },
      babelfish: {
        enabled: config.babelfish.enabled,
        ambientSuggestions: config.babelfish.ambientSuggestions,
        defaultHumanLanguage: config.babelfish.defaultHumanLanguage,
        requirePreviewForInPlaceRewrite:
          config.babelfish.requirePreviewForInPlaceRewrite,
      },
      ghostwriter: {
        crdt: crdtBridge?.getStatus() ?? null,
        ucan: ucanBridge?.getStatus() ?? null,
      },
    });
  }

  // ==================== Logs & Lifecycle ====================

  if (path === '/logs' && req.method === 'GET') {
    const count = parseInt(url.searchParams.get('n') ?? '100', 10);
    const lines = getRecentLogs(count);
    return jsonResponse({ lines, count: lines.length });
  }

  if (path === '/logs' && req.method === 'DELETE') {
    clearLogs();
    return jsonResponse({ status: 'cleared' });
  }

  if (path === '/fim/stats' && req.method === 'GET') {
    return jsonResponse(fimCache.getStats());
  }

  if (path === '/feedback' && req.method === 'GET') {
    const count = parseInt(url.searchParams.get('n') ?? '20', 10);
    const entries = getRecentFeedback(count);
    return jsonResponse({ entries, count: entries.length });
  }

  if (path === '/feedback' && req.method === 'POST') {
    const body = (await req.json()) as {
      rating?: number;
      model?: string;
      comment?: string;
      source?: string;
    };
    const rating = body.rating;

    if (typeof rating !== 'number' || !Number.isInteger(rating) || rating < 1 || rating > 5) {
      return jsonResponse(
        { error: 'rating must be an integer between 1 and 5' },
        400
      );
    }

    if (
      body.comment !== undefined &&
      (typeof body.comment !== 'string' || body.comment.trim().length === 0)
    ) {
      return jsonResponse({ error: 'comment must be a non-empty string' }, 400);
    }

    const entry = recordFeedback({
      rating,
      model:
        typeof body.model === 'string' && body.model.trim().length > 0
          ? body.model.trim()
          : undefined,
      comment:
        typeof body.comment === 'string' && body.comment.trim().length > 0
          ? body.comment.trim()
          : undefined,
      source:
        typeof body.source === 'string' && body.source.trim().length > 0
          ? body.source.trim()
          : 'zedge-companion',
    });

    return jsonResponse({ status: 'recorded', entry });
  }

  if (path === '/restart' && req.method === 'POST') {
    // Respond first, then exit — the context server runner will restart us
    setTimeout(() => process.exit(0), 100);
    return jsonResponse({ status: 'restarting' });
  }

  // ==================== Admin (aeon-cli proxy) ====================

  if (path === '/edgework/commands' && req.method === 'GET') {
    return jsonResponse({
      commands: [
        {
          name: 'emotions',
          description: 'Analyze emotions in text',
          args: '[text]',
        },
        {
          name: 'sentiment',
          description: 'Analyze sentiment in text',
          args: '[text]',
        },
        {
          name: 'entities',
          description: 'Extract entities from text',
          args: '[text]',
        },
        {
          name: 'embed',
          description: 'Generate embeddings',
          args: '[text]',
          options: '--model small|base|large',
        },
        {
          name: 'language',
          description: 'Detect language of text',
          args: '[text]',
        },
        {
          name: 'summarize',
          description: 'Summarize text',
          args: '[text]',
          options: '--style concise|detailed|bullets',
        },
        { name: 'health', description: 'Check API health' },
        { name: 'status', description: 'Auth and API status' },
        { name: 'whoami', description: 'Show current identity' },
        { name: 'dashboard', description: 'Account overview' },
        { name: 'usage', description: 'Usage stats' },
        { name: 'limits', description: 'Rate limits' },
        { name: 'pricing', description: 'View pricing' },
        { name: 'keys list', description: 'List API keys' },
        {
          name: 'workflows --list',
          description: 'List available AI workflows',
        },
        {
          name: 'workflows',
          description: 'Install AI workflow templates',
          args: '[names...]',
        },
        { name: 'setup', description: 'Configure MCP server and AI files' },
        { name: 'test', description: 'Test integration' },
      ],
    });
  }

  if (path === '/scaffold/templates' && req.method === 'GET') {
    return jsonResponse({
      templates: [
        {
          name: 'site',
          description: 'Aeon Foundation site (SSR, routing, design tokens)',
          cmd: 'edgework-node deploy scaffold site',
        },
        {
          name: 'app',
          description: 'Full-stack Aeon app (site + API + auth)',
          cmd: 'edgework-node deploy scaffold app',
        },
        {
          name: 'worker',
          description: 'Edge worker (CF Workers / Bun)',
          cmd: 'edgework-node deploy scaffold worker',
        },
        {
          name: 'mcp',
          description: 'MCP server (Model Context Protocol)',
          cmd: 'edgework-node deploy scaffold mcp',
        },
        {
          name: 'agent',
          description: 'AI agent template (tool use + memory)',
          cmd: 'edgework-node deploy scaffold agent',
        },
        {
          name: 'extension',
          description: 'Zed editor extension',
          cmd: 'edgework-node deploy scaffold extension',
        },
        {
          name: 'gnosis',
          description: 'Gnosis topological graph project',
          cmd: 'edgework-node deploy scaffold gnosis',
        },
      ],
    });
  }

  if (path === '/scaffold/create' && req.method === 'POST') {
    const body = (await req.json()) as {
      template?: string;
      name?: string;
      targetDir?: string;
    };
    if (!body.template)
      return jsonResponse({ error: 'template is required' }, 400);
    if (!body.name) return jsonResponse({ error: 'name is required' }, 400);

    const targetDir = body.targetDir || body.name;
    try {
      const { output, exitCode } = await execShell(
        `pnpm exec edgework-node deploy scaffold ${body.template} ${targetDir} --preset all --install 2>&1`,
        { cwd: process.env.AEON_ROOT || process.cwd(), timeout: 60_000 }
      );
      return jsonResponse({
        template: body.template,
        name: body.name,
        targetDir,
        exitCode,
        output,
      });
    } catch (err) {
      return jsonResponse(
        {
          template: body.template,
          exitCode: 1,
          output: err instanceof Error ? err.message : 'scaffold failed',
        },
        500
      );
    }
  }

  // ==================== Code Index ====================

  if (path === '/code-index/search' && req.method === 'POST') {
    const { codeIndex } = await import('./code-index');
    const body = (await req.json()) as { query?: string; topK?: number };
    if (!body.query) return jsonResponse({ error: 'query is required' }, 400);
    const results = await codeIndex.search(body.query, body.topK ?? 5);
    return jsonResponse({
      results: results.map((r) => ({
        filePath: r.block.relativePath,
        startLine: r.block.startLine,
        endLine: r.block.endLine,
        content: r.block.content,
        language: r.block.language,
        kind: r.block.kind,
        score: r.score,
      })),
    });
  }

  if (path === '/code-index/related' && req.method === 'GET') {
    const { codeIndex } = await import('./code-index');
    const filePath = url.searchParams.get('file');
    if (!filePath) return jsonResponse({ error: 'file query param is required' }, 400);
    const results = await codeIndex.getRelatedContext(filePath, 5);
    return jsonResponse({
      results: results.map((r) => ({
        filePath: r.block.relativePath,
        startLine: r.block.startLine,
        endLine: r.block.endLine,
        content: r.block.content,
        language: r.block.language,
        kind: r.block.kind,
        score: r.score,
      })),
    });
  }

  if (path === '/code-index/stats' && req.method === 'GET') {
    const { codeIndex } = await import('./code-index');
    return jsonResponse(codeIndex.getStats());
  }

  // ==================== Gnosis ====================

  const babelfishResponse = await handleBabelfishRequest(req);
  if (babelfishResponse) {
    return babelfishResponse;
  }

  if (path === '/gnosis/eval' && req.method === 'POST') {
    try {
      const body = (await req.json()) as { code?: string };
      if (!body.code) return jsonResponse({ error: 'code is required' }, 400);

      const { BettyCompiler } = await ensureGnosisModules();
      const compiler = new BettyCompiler();
      const result = compiler.parse(body.code);

      return jsonResponse({
        output: result.output,
        b1: result.b1,
        buleyMeasure: result.buleyMeasure,
        diagnostics: result.diagnostics,
        logs: compiler.getLogs(),
      });
    } catch (err) {
      return jsonResponse(
        {
          error:
            err instanceof Error ? err.message : 'Gnosis evaluation failed',
        },
        500
      );
    }
  }

  // ==================== Gnosis TS Check ====================

  if (path === '/gnosis/ts-check' && req.method === 'POST') {
    try {
      const body = (await req.json()) as {
        sourceText?: string;
        filePath?: string;
        maxBuley?: number;
        target?: string;
        exportName?: string;
      };
      if (!body.sourceText)
        return jsonResponse({ error: 'sourceText is required' }, 400);
      const filePath = body.filePath ?? 'inline.ts';
      const { checkTypeScriptWithGnosis } = await ensureGnosisModules();
      const result = await checkTypeScriptWithGnosis(
        body.sourceText,
        filePath,
        {
          maxBuley: body.maxBuley,
          target: body.target as any,
          exportName: body.exportName,
        }
      );
      return jsonResponse(result);
    } catch (err) {
      return jsonResponse(
        {
          error: err instanceof Error ? err.message : 'TS check failed',
          ok: false,
          diagnostics: [],
          skipped: true,
        },
        200
      );
    }
  }

  if (path === '/gnosis/topology-graph' && req.method === 'POST') {
    try {
      const body = (await req.json()) as {
        sourceText?: string;
        filePath?: string;
        exportName?: string;
      };
      if (!body.sourceText)
        return jsonResponse({ error: 'sourceText is required' }, 400);
      const filePath2 = body.filePath ?? 'inline.ts';
      const gnosis2 = await ensureGnosisModules();
      const result = await gnosis2.checkTypeScriptWithGnosis(
        body.sourceText,
        filePath2,
        {
          exportName: body.exportName,
        }
      );
      return jsonResponse({
        nodes: result.topology.nodes,
        edges: result.topology.edges,
        metrics: result.metrics,
      });
    } catch (err) {
      return jsonResponse(
        {
          error: err instanceof Error ? err.message : 'Topology graph failed',
          nodes: [],
          edges: [],
          metrics: null,
        },
        200
      );
    }
  }

  if (path === '/gnosis/autofix' && req.method === 'POST') {
    try {
      const body = (await req.json()) as {
        sourceText?: string;
        filePath?: string;
      };
      if (!body.sourceText)
        return jsonResponse({ error: 'sourceText is required' }, 400);
      const filePath3 = body.filePath ?? 'inline.ts';
      const gnosis3 = await ensureGnosisModules();
      const result = await gnosis3.checkTypeScriptWithGnosis(body.sourceText, filePath3);
      const suggestions = gnosis3.generateAutofixSuggestions(result, body.sourceText);
      return jsonResponse({
        diagnostics: result.diagnostics,
        suggestions,
        metrics: result.metrics,
      });
    } catch (err) {
      return jsonResponse(
        {
          error: err instanceof Error ? err.message : 'Autofix failed',
          suggestions: [],
        },
        200
      );
    }
  }

  if (path === '/gnosis/viz' && req.method === 'GET') {
    const { default: serveGnosisViz } = await import('./gnosis-viz');
    return serveGnosisViz(url);
  }

  if (path === '/gnosis/viz/events' && req.method === 'GET') {
    // SSE endpoint for live topology updates via file watcher
    let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        controller.enqueue(encoder.encode('data: {"type":"connected"}\n\n'));
        gnosisSseClients.add(controller);

        heartbeatInterval = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(': heartbeat\n\n'));
          } catch {
            if (heartbeatInterval) clearInterval(heartbeatInterval);
            gnosisSseClients.delete(controller);
          }
        }, 15_000);
      },
      cancel(controller) {
        if (heartbeatInterval) clearInterval(heartbeatInterval);
        gnosisSseClients.delete(controller as unknown as ReadableStreamDefaultController);
      },
    });
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  if (path === '/gnosis/watcher/stats' && req.method === 'GET') {
    return jsonResponse({
      watcher: _gnosisWatcher?.getStats?.() ?? { status: 'not-initialized' },
      checker: _gnosisIncrementalChecker?.getStats?.() ?? { status: 'not-initialized' },
      sseClients: gnosisSseClients.size,
    });
  }

  if (path === '/edgework/exec' && req.method === 'POST') {
    const body = (await req.json()) as { command?: string };
    if (!body.command)
      return jsonResponse({ error: 'command is required' }, 400);

    const cmd = body.command.trim();
    // Only allow edgework CLI commands
    if (!cmd.startsWith('edgework ')) {
      return jsonResponse(
        { error: 'Only edgework CLI commands are allowed' },
        403
      );
    }

    try {
      const { output, exitCode } = await execShell(
        `pnpm exec ${cmd} --json 2>&1`,
        { cwd: process.env.AEON_ROOT || process.cwd(), timeout: 30_000 }
      );
      return jsonResponse({ command: cmd, exitCode, output });
    } catch (err) {
      return jsonResponse(
        {
          command: cmd,
          exitCode: 1,
          output: err instanceof Error ? err.message : 'exec failed',
        },
        500
      );
    }
  }

  if (path === '/admin/commands' && req.method === 'GET') {
    return jsonResponse({
      commands: [
        {
          name: 'doctor',
          description: 'Runtime, scripts, and MCP health diagnostics',
          risk: 'read',
        },
        {
          name: 'ops status',
          description: 'Operator health snapshot',
          risk: 'read',
        },
        {
          name: 'ops logs',
          description: 'Monitor and log scripts',
          risk: 'read',
        },
        {
          name: 'ops costs',
          description: 'Cost and spend surface summary',
          risk: 'read',
        },
        {
          name: 'ops services',
          description: 'Service inventory',
          risk: 'read',
        },
        {
          name: 'ops cloudrun status',
          description: 'Cloud Run service status',
          risk: 'read',
        },
        {
          name: 'ops cloudrun logs',
          description: 'Cloud Run service logs',
          risk: 'read',
        },
        {
          name: 'ops edge health',
          description: 'Edge health check',
          risk: 'read',
        },
        {
          name: 'fleet status',
          description: 'Fleet status snapshot',
          risk: 'read',
        },
        {
          name: 'fleet health',
          description: 'Fleet health checks',
          risk: 'read',
        },
        {
          name: 'fleet sessions',
          description: 'Fleet session capacity and usage',
          risk: 'read',
        },
        { name: 'fleet logs', description: 'Tail fleet logs', risk: 'read' },
        {
          name: 'mcp list',
          description: 'List MCP catalog entries',
          risk: 'read',
        },
        {
          name: 'mcp doctor',
          description: 'Inspect MCP catalog health',
          risk: 'read',
        },
        {
          name: 'ai diagnose',
          description: 'Scripts, targets, and MCP context diagnostics',
          risk: 'read',
        },
        {
          name: 'ai runbook',
          description: 'Curated runbook command sequences',
          risk: 'read',
        },
        {
          name: 'workflow list',
          description: 'List available workflows',
          risk: 'read',
        },
      ],
    });
  }

  if (path === '/admin/exec' && req.method === 'POST') {
    const body = (await req.json()) as { command?: string };
    if (!body.command)
      return jsonResponse({ error: 'command is required' }, 400);

    // Only allow aeon CLI commands
    const cmd = body.command.trim();
    if (!cmd.startsWith('aeon ')) {
      return jsonResponse({ error: 'Only aeon CLI commands are allowed' }, 403);
    }

    try {
      const { output, exitCode } = await execShell(
        `pnpm exec ${cmd} --json 2>&1`,
        { cwd: process.env.AEON_ROOT || process.cwd(), timeout: 30_000 }
      );
      return jsonResponse({ command: cmd, exitCode, output });
    } catch (err) {
      return jsonResponse(
        {
          command: cmd,
          exitCode: 1,
          output: err instanceof Error ? err.message : 'exec failed',
        },
        500
      );
    }
  }

  // ==================== OpenAI-Compatible API ====================

  // Chat completions
  if (path === '/v1/chat/completions' && req.method === 'POST') {
    const body = (await req.json()) as ChatRequestBody;
    const rawMessages = (body.messages ?? []) as Array<{
      role: string;
      content: unknown;
    }>;

    // Zed's OpenAI-compatible provider sends content as an array of
    // content parts: [{type:"text", text:"..."}]. Normalize to plain
    // strings so coordinators (which expect OpenAI string format) don't choke.
    const normalizedMessages = rawMessages.map((msg) => {
      if (Array.isArray(msg.content)) {
        const text = msg.content
          .filter((p: { type?: string }) => p.type === 'text')
          .map((p: { text?: string }) => p.text ?? '')
          .join('\n\n');
        return { role: msg.role, content: text };
      }
      return { role: msg.role, content: String(msg.content ?? '') };
    }) as ChatCompletionRequest['messages'];
    const messages = compactSystemPrompts(
      normalizedMessages
    ) as ChatCompletionRequest['messages'];

    // --- Auto-attach codebase context ---
    // Extract the last user message, search the semantic code index, and
    // inject the top relevant blocks as additional context. This makes every
    // chat message codebase-aware without requiring explicit @-references.
    try {
      const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
      if (lastUserMsg && lastUserMsg.content.length > 10) {
        const { codeIndex } = await import('./code-index');
        const stats = codeIndex.getStats();
        if (stats.indexedBlocks > 0) {
          const results = await codeIndex.search(lastUserMsg.content, 5);
          if (results.length > 0) {
            const contextBlocks = results
              .filter((r) => r.score > 0.3)
              .map(
                (r) =>
                  `--- ${r.block.relativePath}:${r.block.startLine}-${r.block.endLine} (${r.block.kind}) ---\n${r.block.content}`
              )
              .join('\n\n');
            if (contextBlocks.length > 0) {
              // Append context to the system message, or create one
              const systemIdx = messages.findIndex((m) => m.role === 'system');
              const contextSuffix = `\n\n<codebase_context>\n${contextBlocks}\n</codebase_context>`;
              if (systemIdx >= 0) {
                messages[systemIdx] = {
                  ...messages[systemIdx],
                  content: messages[systemIdx].content + contextSuffix,
                };
              } else {
                messages.unshift({
                  role: 'system',
                  content: `You are a coding assistant with access to the user's codebase.${contextSuffix}`,
                });
              }
            }
          }
        }
      }
    } catch {
      // Code index may not be initialized yet -- proceed without context
    }

    const request: ChatCompletionRequest = {
      model: body.model ?? getZedgeConfig().preferredModel,
      messages,
      stream: body.stream ?? false,
      temperature: body.temperature,
      max_tokens: body.max_tokens,
      top_p: body.top_p,
    };

    if (request.stream) {
      const result = await infer(request);
      const attemptHeaders = buildAttemptHeaders(result.attempts);
      const contentType = result.response.headers.get('content-type') ?? '';

      if (contentType.includes('text/event-stream') && result.response.body) {
        const sseStream = createSSEProxyStream(
          result.response.body,
          result.tier,
          result.upstreamHeaders,
          result.attempts,
          request.model
        );

        return new Response(sseStream, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
            'Access-Control-Allow-Origin': '*',
            'X-Zedge-Tier': result.tier,
            ...result.upstreamHeaders,
            ...attemptHeaders,
          },
        });
      }

      // Fallback: when the winning tier returned JSON instead of SSE, convert
      // the completed response into OpenAI-style SSE chunks for Zed.
      const data = await extractResponseData(result.response, request.model);
      const content = (data as Record<string, unknown> & { choices?: Array<{ message?: { content?: string } }> })?.choices?.[0]?.message?.content ?? '';
      const id = data.id ?? `chatcmpl-${Date.now()}`;
      const created = data.created ?? Math.floor(Date.now() / 1000);
      const model = data.model ?? request.model;

      const encoder = new TextEncoder();
      // Split on word boundaries, preserving whitespace
      const tokens = content.match(/\S+\s*/g) ?? [content];

      const sseStream = new ReadableStream<Uint8Array>({
        async start(controller) {
          // Emit each token as a separate SSE delta chunk
          for (let i = 0; i < tokens.length; i++) {
            const chunk = {
              id,
              object: 'chat.completion.chunk',
              created,
              model,
              choices: [
                {
                  index: 0,
                  delta:
                    i === 0
                      ? { role: 'assistant', content: tokens[i] }
                      : { content: tokens[i] },
                  finish_reason: null,
                },
              ],
            };
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`)
            );
            // Small delay between tokens for streaming feel (~30 tokens/sec)
            if (i < tokens.length - 1) {
              await new Promise((r) => setTimeout(r, 30));
            }
          }

          // Finish chunk with usage stats
          const finishChunk = {
            id,
            object: 'chat.completion.chunk',
            created,
            model,
            choices: [
              {
                index: 0,
                delta: {},
                finish_reason: 'stop',
              },
            ],
            usage: data.usage ?? {
              prompt_tokens: 0,
              completion_tokens: tokens.length,
              total_tokens: tokens.length,
            },
          };
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(finishChunk)}\n\n`)
          );

          // Done sentinel
          controller.enqueue(encoder.encode('data: [DONE]\n\n'));
          controller.close();
        },
      });

      return new Response(sseStream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'Access-Control-Allow-Origin': '*',
          'X-Zedge-Tier': result.tier,
          ...result.upstreamHeaders,
          ...attemptHeaders,
        },
      });
    }

    const inferRequest = { ...request, stream: false };
    const result = await infer(inferRequest);
    const attemptHeaders = buildAttemptHeaders(result.attempts);
    const data = await extractResponseData(result.response);
    return new Response(
      JSON.stringify(data),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'X-Zedge-Tier': result.tier,
          ...result.upstreamHeaders,
          ...attemptHeaders,
        },
      }
    );
  }

  // Code completions (FIM — fill-in-middle)
  if (path === '/v1/completions' && req.method === 'POST') {
    const body = (await req.json()) as CompletionRequestBody;
    const prompt = body.prompt ?? '';
    const model = body.model ?? 'qwen-2.5-coder-7b';
    const maxTokens = body.max_tokens ?? 128;
    const temperature = body.temperature ?? 0.2;

    // Detect FIM markers — route to optimized fast path
    const hasFimMarkers =
      prompt.includes('<|fim_prefix|>') ||
      prompt.includes('<fim_prefix>') ||
      prompt.includes('<PRE>') ||
      prompt.includes('<｜fim▁begin｜>');

    if (hasFimMarkers) {
      // --- FIM Fast Path: cache check → race Cloud Run + WASM ---

      // Extract prefix/suffix from FIM-formatted prompt
      let prefix = prompt;
      let suffix = '';
      for (const [, tokens] of Object.entries({
        qwen: { p: '<|fim_prefix|>', s: '<|fim_suffix|>', m: '<|fim_middle|>' },
        star: { p: '<fim_prefix>', s: '<fim_suffix>', m: '<fim_middle>' },
        code: { p: '<PRE>', s: '<SUF>', m: '<MID>' },
        deep: { p: '<｜fim▁begin｜>', s: '<｜fim▁hole｜>', m: '<｜fim▁end｜>' },
      })) {
        if (prompt.includes(tokens.p)) {
          const afterPrefix = prompt.split(tokens.p)[1] ?? '';
          const parts = afterPrefix.split(tokens.s);
          prefix = parts[0] ?? '';
          suffix = (parts[1] ?? '').split(tokens.m)[0] ?? '';
          break;
        }
      }

      // Cache check (sub-1ms on hit)
      const filePath = url.searchParams.get('file') ?? 'unknown';
      const cursorLine = parseInt(url.searchParams.get('line') ?? '0', 10);
      const cacheKey = fimCacheKey(filePath, cursorLine, prefix);
      const cached = fimCache.get(cacheKey);

      if (cached) {
        return new Response(
          JSON.stringify({
            id: `cmpl-cache-${Date.now()}`,
            object: 'text_completion',
            created: Math.floor(Date.now() / 1000),
            model: cached.model,
            choices: [{ text: cached.completion, index: 0, finish_reason: 'stop' }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          }),
          {
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
              'X-Zedge-Tier': cached.tier,
              'X-Zedge-Cache': 'hit',
            },
          }
        );
      }

      // Cache miss — race Cloud Run + WASM
      const fimResult = await inferFim(prefix, suffix, model, maxTokens, temperature);

      // Populate cache
      fimCache.set(cacheKey, {
        completion: fimResult.completion,
        model: fimResult.model,
        tier: fimResult.tier,
        createdAt: Date.now(),
      });

      // Speculative pre-fetch for next line
      speculativePrefetch(
        filePath,
        cursorLine + 1,
        prefix + fimResult.completion,
        suffix,
        model,
        async (p, s, m) => {
          const r = await inferFim(p, s, m, maxTokens, temperature);
          return r.completion ? { completion: r.completion, tier: r.tier } : null;
        }
      );

      const attemptHeaders = buildAttemptHeaders(fimResult.attempts);
      return new Response(
        JSON.stringify({
          id: `cmpl-fim-${Date.now()}`,
          object: 'text_completion',
          created: Math.floor(Date.now() / 1000),
          model: fimResult.model,
          choices: [{ text: fimResult.completion, index: 0, finish_reason: 'stop' }],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        }),
        {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'X-Zedge-Tier': fimResult.tier,
            'X-Zedge-Cache': 'miss',
            'X-Zedge-FIM-Ms': String(fimResult.durationMs),
            ...attemptHeaders,
          },
        }
      );
    }

    // --- Standard completion (non-FIM): route through chat inference ---
    const messages: ChatCompletionRequest['messages'] = [
      {
        role: 'system',
        content:
          'You are a code completion assistant. Complete the code that follows. Output ONLY the completion, no explanation, no markdown fences.',
      },
      { role: 'user', content: prompt },
    ];

    const request: ChatCompletionRequest = {
      model,
      messages,
      temperature,
      max_tokens: maxTokens,
    };

    const result = await infer(request);
    const completionAttemptHeaders = buildAttemptHeaders(result.attempts);
    const data = await extractResponseData(result.response);
    return new Response(
      JSON.stringify(data),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
          'X-Zedge-Tier': result.tier,
          ...result.upstreamHeaders,
          ...completionAttemptHeaders,
        },
      }
    );
  }

  // Models list
  if (path === '/v1/models' && req.method === 'GET') {
    const models = await getModels();
    return jsonResponse({ object: 'list', data: models });
  }

  // Embeddings
  if (path === '/v1/embeddings' && req.method === 'POST') {
    const body = (await req.json()) as EmbeddingRequestBody;
    const resp = await embed(body.input ?? '', body.model);
    const data = await resp.json();
    return jsonResponse(data);
  }

  // ==================== Compute Pool ====================

  if (path === '/compute-pool/join' && req.method === 'POST') {
    const status = await joinPool();
    return jsonResponse(status);
  }

  if (path === '/compute-pool/leave' && req.method === 'POST') {
    const status = await leavePool();
    return jsonResponse(status);
  }

  if (path === '/compute-pool/status' && req.method === 'GET') {
    return jsonResponse(getPoolStatus());
  }

  // ==================== P2P Mesh ====================

  if (path === '/mesh/start' && req.method === 'POST') {
    const status = startMesh();
    return jsonResponse(status);
  }

  if (path === '/mesh/stop' && req.method === 'POST') {
    const status = stopMesh();
    return jsonResponse(status);
  }

  if (path === '/mesh/status' && req.method === 'GET') {
    return jsonResponse(getMeshStatus());
  }

  // Peer-to-peer inference endpoint (called by other mesh nodes)
  if (path === '/mesh/infer' && req.method === 'POST') {
    // Only accept mesh inference when the mesh is running
    const meshRunning = getMeshStatus();
    if (!meshRunning.running) {
      return jsonResponse({ error: 'Mesh is not running' }, 503);
    }
    const body = (await req.json()) as ChatRequestBody;
    const request: ChatCompletionRequest = {
      model: body.model ?? getZedgeConfig().preferredModel,
      messages: (body.messages ?? []) as ChatCompletionRequest['messages'],
      temperature: body.temperature,
      max_tokens: body.max_tokens,
    };
    const response = await handlePeerRequest(request);
    const data = await response.json();
    return jsonResponse(data);
  }

  // ==================== Superinference ====================

  if (path === '/v1/superinference' && req.method === 'POST') {
    const body = (await req.json()) as SuperinferenceRequestBody;
    const result = await superinfer({
      request: {
        model: body.model ?? getZedgeConfig().preferredModel,
        messages: (body.messages ?? []) as ChatCompletionRequest['messages'],
        temperature: body.temperature,
        max_tokens: body.max_tokens,
      },
      models: body.models,
      strategy: body.strategy ?? 'fastest',
      timeoutMs: body.timeout_ms,
    });
    return jsonResponse(result);
  }

  if (path === '/v1/superinference/recursive' && req.method === 'POST') {
    const body = (await req.json()) as RecursiveRequestBody;
    const result = await recursiveSuperinfer({
      prompt: body.prompt ?? '',
      models: body.models,
      strategy: body.strategy ?? 'consensus',
      maxDepth: body.max_depth,
      maxTokenBudget: body.max_token_budget,
    });
    return jsonResponse(result);
  }

  // ==================== ACP Agent ====================

  // Create agent session
  if (path === '/agent/session' && req.method === 'POST') {
    const body = (await req.json()) as AgentSessionRequestBody;
    if (!body.workspace_path) {
      return jsonResponse({ error: 'workspace_path is required' }, 400);
    }
    const capabilities: AgentCapabilities = {
      processExec: body.capabilities?.processExec ?? [],
      fileRead: body.capabilities?.fileRead ?? true,
      fileWrite: body.capabilities?.fileWrite ?? false,
      gitAccess: body.capabilities?.gitAccess ?? true,
    };
    const session = createSession(body.workspace_path, capabilities);
    return jsonResponse({
      session_id: session.id,
      workspace_path: session.workspacePath,
      capabilities: session.capabilities,
    });
  }

  // Agent turn (chat with tools)
  if (path === '/agent/turn' && req.method === 'POST') {
    const body = (await req.json()) as AgentTurnRequestBody;
    if (!body.session_id || !body.message) {
      return jsonResponse(
        { error: 'session_id and message are required' },
        400
      );
    }
    const session = getSession(body.session_id);
    if (!session) {
      return jsonResponse({ error: 'Session not found' }, 404);
    }
    const response = await agentTurn(body.session_id, body.message);
    return jsonResponse(response);
  }

  // Delete agent session
  if (path.startsWith('/agent/session/') && req.method === 'DELETE') {
    const sessionId = path.slice('/agent/session/'.length);
    deleteSession(sessionId);
    return jsonResponse({ deleted: true });
  }

  // ==================== Multi-File Agent ====================

  if (path === '/agent/multi-file' && req.method === 'POST') {
    const body = (await req.json()) as {
      instruction?: string;
      target_files?: string[];
      model?: string;
    };
    if (!body.instruction) {
      return jsonResponse({ error: 'instruction is required' }, 400);
    }
    const { executeMultiFileEdit } = await import('./multi-file-agent');
    const result = await executeMultiFileEdit({
      instruction: body.instruction,
      workspacePath: process.env.AEON_ROOT || process.cwd(),
      targetFiles: body.target_files,
      model: body.model,
    });
    return jsonResponse(result, result.failedCount > 0 && result.appliedCount === 0 ? 400 : 200);
  }

  // ==================== Binary Protocol v2 ====================

  if (path === '/v1/binary/infer' && req.method === 'POST') {
    const contentType = req.headers.get('content-type') ?? '';
    if (!contentType.includes(BINARY_CONTENT_TYPE)) {
      return jsonResponse(
        {
          error: `Expected Content-Type: ${BINARY_CONTENT_TYPE}`,
        },
        415
      );
    }

    const buffer = await req.arrayBuffer();
    if (!isValidFrame(buffer)) {
      return jsonResponse({ error: 'Invalid binary frame' }, 400);
    }

    // Decode, process (pass through for now — mesh nodes use this for tensor transfer)
    const frame = binaryDecode(buffer);
    // Re-encode and return (echo for tensor routing validation)
    const encoded = binaryEncode(frame);
    return new Response(encoded, {
      headers: {
        'Content-Type': BINARY_CONTENT_TYPE,
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  // ==================== Auth ====================

  if (path === '/auth/login' && req.method === 'POST') {
    const result = await login();
    return jsonResponse(result, result.success || result.pending ? 200 : 401);
  }

  if (path === '/auth/logout' && req.method === 'POST') {
    logout();
    return jsonResponse({ success: true });
  }

  if (path === '/auth/whoami' && req.method === 'GET') {
    return jsonResponse(whoami());
  }

  // ==================== Latency Probing ====================

  if (path === '/probe/health' && req.method === 'GET') {
    return jsonResponse(getTierHealth());
  }

  if (path === '/probe/results' && req.method === 'GET') {
    return jsonResponse(getProbeResults());
  }

  if (path === '/probe/fastest' && req.method === 'GET') {
    const model =
      url.searchParams.get('model') ?? getZedgeConfig().preferredModel;
    const tier = getFastestTier(model);
    return jsonResponse({ model, fastestTier: tier });
  }

  if (path === '/selftest/inference' && req.method === 'GET') {
    const model =
      url.searchParams.get('model') ??
      getZedgeConfig().preferredModel;
    return jsonResponse(await runInferenceSelfTest(model));
  }

  // ==================== Resilient Streaming ====================

  if (path === '/v1/chat/completions/resilient' && req.method === 'POST') {
    const body = (await req.json()) as ChatRequestBody;
    const request: ChatCompletionRequest = {
      model: body.model ?? getZedgeConfig().preferredModel,
      messages: (body.messages ?? []) as ChatCompletionRequest['messages'],
      stream: true,
      temperature: body.temperature,
      max_tokens: body.max_tokens,
      top_p: body.top_p,
    };

    const stream = createResilientStream(request);
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'X-Zedge-Resilient': 'true',
      },
    });
  }

  if (path === '/stream/sessions' && req.method === 'GET') {
    return jsonResponse(getActiveSessions());
  }

  // ==================== Forge (ForgoCD) ====================

  if (path === '/forge/deploy' && req.method === 'POST') {
    if (!forgeBridge) {
      return jsonResponse({ error: 'Forge bridge not initialized' }, 503);
    }
    const body = (await req.json()) as ForgeDeployRequestBody;
    const result = await forgeBridge.deploy(body.project);
    return jsonResponse(result, result.success ? 200 : 400);
  }

  if (path === '/forge/status' && req.method === 'GET') {
    if (!forgeBridge) {
      return jsonResponse({ error: 'Forge bridge not initialized' }, 503);
    }
    return jsonResponse(forgeBridge.getStatus());
  }

  if (path === '/forge/projects' && req.method === 'GET') {
    if (!forgeBridge) {
      return jsonResponse({ error: 'Forge bridge not initialized' }, 503);
    }
    const projects = await forgeBridge.discoverProjects();
    return jsonResponse({
      count: projects.length,
      projects: projects.map((p) => ({
        name: p.name,
        dir: p.dir,
        kind: p.config.kind,
        runtime: p.config.runtime,
        port: p.config.port,
        buildCommand: p.config.buildCommand,
        configSource: p.configSource,
      })),
    });
  }

  if (path.startsWith('/forge/logs/') && req.method === 'GET') {
    if (!forgeBridge) {
      return jsonResponse({ error: 'Forge bridge not initialized' }, 503);
    }
    const processId = path.slice('/forge/logs/'.length);
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        for await (const line of forgeBridge!.getLogs(processId)) {
          controller.enqueue(encoder.encode(`data: ${line}\n\n`));
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  if (path.startsWith('/forge/stop/') && req.method === 'POST') {
    if (!forgeBridge) {
      return jsonResponse({ error: 'Forge bridge not initialized' }, 503);
    }
    const processId = path.slice('/forge/stop/'.length);
    await forgeBridge.stop(processId);
    return jsonResponse({ stopped: true, processId });
  }

  // ==================== CERA (Perturbation Engine) ====================

  if (path === '/cera/status' && req.method === 'GET') {
    if (!ceraBridge) {
      return jsonResponse({ error: 'CERA bridge not initialized' }, 503);
    }
    return jsonResponse(ceraBridge.getStatus());
  }

  if (path === '/cera/mutations' && req.method === 'GET') {
    if (!ceraBridge) {
      return jsonResponse({ error: 'CERA bridge not initialized' }, 503);
    }
    return jsonResponse(ceraBridge.getPending());
  }

  if (path === '/cera/history' && req.method === 'GET') {
    if (!ceraBridge) {
      return jsonResponse({ error: 'CERA bridge not initialized' }, 503);
    }
    return jsonResponse(ceraBridge.getHistory());
  }

  if (path.startsWith('/cera/accept/') && req.method === 'POST') {
    if (!ceraBridge) {
      return jsonResponse({ error: 'CERA bridge not initialized' }, 503);
    }
    const mutationId = path.slice('/cera/accept/'.length);
    const result = ceraBridge.accept(mutationId);
    if (!result) {
      return jsonResponse({ error: `Mutation ${mutationId} not found` }, 404);
    }
    return jsonResponse({ accepted: true, mutation: result });
  }

  if (path.startsWith('/cera/reject/') && req.method === 'POST') {
    if (!ceraBridge) {
      return jsonResponse({ error: 'CERA bridge not initialized' }, 503);
    }
    const mutationId = path.slice('/cera/reject/'.length);
    const result = ceraBridge.reject(mutationId);
    if (!result) {
      return jsonResponse({ error: `Mutation ${mutationId} not found` }, 404);
    }
    return jsonResponse({ rejected: true, mutation: result });
  }

  if (path === '/cera/events' && req.method === 'GET') {
    if (!ceraBridge) {
      return jsonResponse({ error: 'CERA bridge not initialized' }, 503);
    }
    const stream = ceraBridge.createSseStream();
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  if (path === '/cera/daydream/status' && req.method === 'GET') {
    const { daydreamEngine } = await import('./daydream');
    return jsonResponse(daydreamEngine.getStatus());
  }

  if (path === '/cera/daydream/candidates' && req.method === 'GET') {
    const { daydreamEngine } = await import('./daydream');
    return jsonResponse(daydreamEngine.getCandidates());
  }

  if (path === '/cera/daydream/dream' && req.method === 'POST') {
    const { daydreamEngine } = await import('./daydream');
    const body = (await req.json()) as { file_path?: string };
    const cycle = await daydreamEngine.triggerDream(body.file_path);
    return jsonResponse({
      triggered: true,
      cycle,
    });
  }

  if (path === '/cera/daydream/accept' && req.method === 'POST') {
    const { daydreamEngine } = await import('./daydream');
    const body = (await req.json()) as { id?: string; apply?: boolean };
    if (!body.id) return jsonResponse({ error: 'id is required' }, 400);
    const candidate = daydreamEngine.acceptCandidate(body.id);
    if (!candidate) return jsonResponse({ error: 'Candidate not found' }, 404);

    // If apply=true, bridge the accepted candidate into multi-file-agent
    let editResult = null;
    if (body.apply !== false) {
      try {
        const { executeMultiFileEdit } = await import('./multi-file-agent');
        editResult = await executeMultiFileEdit({
          instruction: candidate.suggestion,
          workspacePath: process.env.AEON_ROOT || process.cwd(),
          targetFiles: [candidate.filePath],
        });
      } catch {
        // Edit application is best-effort
      }
    }

    return jsonResponse({ accepted: true, candidate, editResult });
  }

  if (path === '/cera/daydream/reject' && req.method === 'POST') {
    const { daydreamEngine } = await import('./daydream');
    const body = (await req.json()) as { id?: string };
    if (!body.id) return jsonResponse({ error: 'id is required' }, 400);
    const candidate = daydreamEngine.rejectCandidate(body.id);
    if (!candidate) return jsonResponse({ error: 'Candidate not found' }, 404);
    return jsonResponse({ rejected: true, candidate });
  }

  if (path === '/cera/daydream/activity' && req.method === 'POST') {
    const { daydreamEngine } = await import('./daydream');
    const body = (await req.json()) as { file_path?: string };
    daydreamEngine.notifyActivity(body.file_path);
    return jsonResponse({ notified: true });
  }

  if (path === '/forge/events' && req.method === 'GET') {
    if (!forgeBridge) {
      return jsonResponse({ error: 'Forge bridge not initialized' }, 503);
    }
    // SSE endpoint streaming forge events to Zed in real time
    const encoder = new TextEncoder();
    let forgeHeartbeat: ReturnType<typeof setInterval> | null = null;
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"type":"connected"}\n\n'));
        forgeHeartbeat = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(': heartbeat\n\n'));
          } catch {
            if (forgeHeartbeat) clearInterval(forgeHeartbeat);
          }
        }, 15_000);
      },
      cancel() {
        if (forgeHeartbeat) clearInterval(forgeHeartbeat);
      },
    });
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  // ==================== VFS (Phase 2) ====================

  if (path === '/vfs/mount' && req.method === 'POST') {
    if (!vfsBridge)
      return jsonResponse({ error: 'VFS bridge not initialized' }, 503);
    const body = (await req.json()) as {
      repoPath?: string;
      passphrase?: string;
    };
    if (!body.repoPath)
      return jsonResponse({ error: 'repoPath is required' }, 400);
    const mount = vfsBridge.mount(body.repoPath, body.passphrase);
    return jsonResponse({
      id: mount.id,
      fileCount: mount.files.size,
      mountedAt: mount.mountedAt,
    });
  }

  if (path.startsWith('/vfs/status/') && req.method === 'GET') {
    if (!vfsBridge)
      return jsonResponse({ error: 'VFS bridge not initialized' }, 503);
    const mountId = path.slice('/vfs/status/'.length);
    return jsonResponse(vfsBridge.getStatus(mountId));
  }

  if (path === '/vfs/mounts' && req.method === 'GET') {
    if (!vfsBridge)
      return jsonResponse({ error: 'VFS bridge not initialized' }, 503);
    return jsonResponse(
      vfsBridge.getMounts().map((m) => ({
        id: m.id,
        repoPath: m.repoPath,
        fileCount: m.files.size,
        peerCount: m.peers.size,
      }))
    );
  }

  if (path === '/vfs/changes' && req.method === 'GET') {
    if (!vfsBridge)
      return jsonResponse({ error: 'VFS bridge not initialized' }, 503);
    const since = url.searchParams.get('since');
    return jsonResponse(
      vfsBridge.getChanges(since ? Number(since) : undefined)
    );
  }

  // ==================== Collaborative Editing (Phase 3) ====================

  if (path === '/collab/session' && req.method === 'POST') {
    if (!collabBridge)
      return deprecatedJsonResponse(
        { error: 'Collab bridge not initialized' },
        503
      );
    const body = (await req.json()) as { filePath?: string; name?: string };
    if (!body.filePath)
      return deprecatedJsonResponse({ error: 'filePath is required' }, 400);
    const session = collabBridge.createSession(body.filePath, body.name);
    return deprecatedJsonResponse({
      id: session.id,
      name: session.name,
      hostPeerId: session.hostPeerId,
      filePath: session.filePath,
      participants: Array.from(session.participants.values()),
    });
  }

  if (path.startsWith('/collab/join/') && req.method === 'POST') {
    if (!collabBridge)
      return deprecatedJsonResponse(
        { error: 'Collab bridge not initialized' },
        503
      );
    const sessionId = path.slice('/collab/join/'.length);
    const body = (await req.json()) as {
      peerId?: string;
      displayName?: string;
    };
    if (!body.peerId || !body.displayName) {
      return deprecatedJsonResponse(
        { error: 'peerId and displayName are required' },
        400
      );
    }
    const participant = collabBridge.joinSession(
      sessionId,
      body.peerId,
      body.displayName
    );
    if (!participant)
      return deprecatedJsonResponse({ error: 'Session not found' }, 404);
    return deprecatedJsonResponse(participant);
  }

  if (path === '/collab/presence' && req.method === 'POST') {
    if (!collabBridge)
      return deprecatedJsonResponse(
        { error: 'Collab bridge not initialized' },
        503
      );
    const body = (await req.json()) as CollabPresenceUpdate;
    collabBridge.updatePresence(body);
    return deprecatedJsonResponse({ updated: true });
  }

  if (path === '/collab/sessions' && req.method === 'GET') {
    if (!collabBridge)
      return deprecatedJsonResponse(
        { error: 'Collab bridge not initialized' },
        503
      );
    return deprecatedJsonResponse(
      collabBridge.listSessions().map((s) => ({
        id: s.id,
        name: s.name,
        filePath: s.filePath,
        participantCount: s.participants.size,
        lastActivity: s.lastActivity,
      }))
    );
  }

  if (path.startsWith('/collab/participants/') && req.method === 'GET') {
    if (!collabBridge)
      return deprecatedJsonResponse(
        { error: 'Collab bridge not initialized' },
        503
      );
    const sessionId = path.slice('/collab/participants/'.length);
    return deprecatedJsonResponse(collabBridge.getParticipants(sessionId));
  }

  // ==================== Kernel (Phase 4) ====================

  if (path === '/kernel/commands' && req.method === 'GET') {
    if (!kernelBridge)
      return jsonResponse({ error: 'Kernel bridge not initialized' }, 503);
    return jsonResponse(
      kernelBridge.listCommands().map((c) => ({
        id: c.id,
        label: c.label,
        description: c.description,
      }))
    );
  }

  if (path === '/kernel/execute' && req.method === 'POST') {
    if (!kernelBridge)
      return jsonResponse({ error: 'Kernel bridge not initialized' }, 503);
    const body = (await req.json()) as {
      commandId?: string;
      payload?: unknown;
    };
    if (!body.commandId)
      return jsonResponse({ error: 'commandId is required' }, 400);
    try {
      const result = await kernelBridge.executeCommand(
        body.commandId,
        body.payload
      );
      return jsonResponse({ success: true, result });
    } catch (err) {
      return jsonResponse({ success: false, error: String(err) }, 400);
    }
  }

  if (path === '/kernel/route' && req.method === 'POST') {
    if (!kernelBridge)
      return jsonResponse({ error: 'Kernel bridge not initialized' }, 503);
    const body = (await req.json()) as { task?: string; taskType?: string };
    if (!body.task) return jsonResponse({ error: 'task is required' }, 400);
    return jsonResponse(kernelBridge.routeTask(body.task, body.taskType));
  }

  if (path === '/kernel/daemons' && req.method === 'GET') {
    if (!kernelBridge)
      return jsonResponse({ error: 'Kernel bridge not initialized' }, 503);
    return jsonResponse(kernelBridge.getDaemonStatus());
  }

  if (path === '/kernel/plugins' && req.method === 'GET') {
    if (!kernelBridge)
      return jsonResponse({ error: 'Kernel bridge not initialized' }, 503);
    return jsonResponse(kernelBridge.getPlugins());
  }

  if (path === '/kernel/flight-log' && req.method === 'GET') {
    if (!kernelBridge)
      return jsonResponse({ error: 'Kernel bridge not initialized' }, 503);
    const limit = url.searchParams.get('limit');
    return jsonResponse(kernelBridge.getFlightLog(limit ? Number(limit) : 50));
  }

  if (path === '/kernel/deep-link' && req.method === 'POST') {
    if (!kernelBridge)
      return jsonResponse({ error: 'Kernel bridge not initialized' }, 503);
    const body = (await req.json()) as { url?: string };
    if (!body.url) return jsonResponse({ error: 'url is required' }, 400);
    const parsed = kernelBridge.parseDeepLink(body.url);
    if (!parsed) return jsonResponse({ error: 'Invalid deep link' }, 400);
    return jsonResponse(parsed);
  }

  // ==================== Capacitor (Phase 5) ====================

  if (path === '/capacitor/mount' && req.method === 'POST') {
    if (!capacitorBridge)
      return deprecatedJsonResponse(
        { error: 'Capacitor bridge not initialized' },
        503
      );
    const body = (await req.json()) as {
      path?: string;
      projection?: ProjectionType;
    };
    if (!body.path)
      return deprecatedJsonResponse({ error: 'path is required' }, 400);
    const mount = capacitorBridge.mount(body.path, body.projection);
    return deprecatedJsonResponse({
      id: mount.id,
      path: mount.path,
      projection: mount.projection,
    });
  }

  if (path.startsWith('/capacitor/layout/') && req.method === 'GET') {
    if (!capacitorBridge)
      return deprecatedJsonResponse(
        { error: 'Capacitor bridge not initialized' },
        503
      );
    const mountId = path.slice('/capacitor/layout/'.length);
    return deprecatedJsonResponse(capacitorBridge.getLayout(mountId));
  }

  if (path === '/capacitor/personalize' && req.method === 'POST') {
    if (!capacitorBridge)
      return deprecatedJsonResponse(
        { error: 'Capacitor bridge not initialized' },
        503
      );
    const body = (await req.json()) as {
      developerId?: string;
      preferences?: Record<string, unknown>;
      recentFiles?: string[];
      focusArea?: string;
    };
    if (!body.developerId)
      return deprecatedJsonResponse({ error: 'developerId is required' }, 400);
    capacitorBridge.personalize({
      developerId: body.developerId,
      preferences: body.preferences ?? {},
      recentFiles: body.recentFiles ?? [],
      focusArea: body.focusArea,
    });
    return deprecatedJsonResponse({ personalized: true });
  }

  if (path.startsWith('/capacitor/graph/') && req.method === 'GET') {
    if (!capacitorBridge)
      return deprecatedJsonResponse(
        { error: 'Capacitor bridge not initialized' },
        503
      );
    const mountId = path.slice('/capacitor/graph/'.length);
    return deprecatedJsonResponse(capacitorBridge.getClusters(mountId));
  }

  if (path === '/capacitor/project' && req.method === 'POST') {
    if (!capacitorBridge)
      return deprecatedJsonResponse(
        { error: 'Capacitor bridge not initialized' },
        503
      );
    const body = (await req.json()) as {
      mountId?: string;
      projection?: ProjectionType;
    };
    if (!body.mountId || !body.projection) {
      return deprecatedJsonResponse(
        { error: 'mountId and projection are required' },
        400
      );
    }
    capacitorBridge.setProjection(body.mountId, body.projection);
    return deprecatedJsonResponse({ projection: body.projection });
  }

  if (path === '/capacitor/index' && req.method === 'POST') {
    if (!capacitorBridge)
      return deprecatedJsonResponse(
        { error: 'Capacitor bridge not initialized' },
        503
      );
    const body = (await req.json()) as { mountId?: string; block?: CodeBlock };
    if (!body.mountId || !body.block) {
      return deprecatedJsonResponse(
        { error: 'mountId and block are required' },
        400
      );
    }
    capacitorBridge.indexBlock(body.mountId, body.block);
    return deprecatedJsonResponse({ indexed: true, blockId: body.block.id });
  }

  // ==================== Superinference 2.0 (Phase 6) ====================

  if (path === '/v1/superinference/preset' && req.method === 'POST') {
    const body = (await req.json()) as {
      preset?: string;
      messages?: Array<{ role: string; content: string }>;
      timeout_ms?: number;
      max_tokens?: number;
    };
    if (!body.preset) return jsonResponse({ error: 'preset is required' }, 400);
    const preset = getCompositionPreset(body.preset);
    if (!preset) {
      return jsonResponse(
        {
          error: `Unknown preset: ${body.preset}. Available: ${Object.keys(
            COMPOSITION_PRESETS
          ).join(', ')}`,
        },
        400
      );
    }
    const result = await superinferWithPreset(
      preset,
      (body.messages ?? []) as ChatCompletionRequest['messages'],
      { timeoutMs: body.timeout_ms, maxTokens: body.max_tokens }
    );
    return jsonResponse(result);
  }

  if (path === '/v1/superinference/presets' && req.method === 'GET') {
    return jsonResponse(
      Object.entries(COMPOSITION_PRESETS).map(([key, p]) => ({
        key,
        name: p.name,
        description: p.description,
        models: p.models,
        strategy: p.strategy,
      }))
    );
  }

  // ==================== Compute Market 2.0 (Phase 8) ====================

  if (path === '/market/status' && req.method === 'GET') {
    return jsonResponse(getMarketStatus());
  }

  // ==================== Ghostwriter CRDT (Zedge 3.0) ====================

  if (path === '/crdt/status' && req.method === 'GET') {
    if (!crdtBridge)
      return jsonResponse({ error: 'CRDT bridge not initialized' }, 503);
    return jsonResponse(crdtBridge.getStatus());
  }

  if (path === '/crdt/open' && req.method === 'POST') {
    if (!crdtBridge)
      return jsonResponse({ error: 'CRDT bridge not initialized' }, 503);
    const body = (await req.json()) as {
      path?: string;
      initialContent?: string;
    };
    if (!body.path) return jsonResponse({ error: 'path is required' }, 400);
    const handle = await crdtBridge.openFile(body.path, body.initialContent);
    return jsonResponse({
      path: handle.path,
      contentLength: handle.content.length,
      cursors: Array.from(handle.cursors.values()),
    });
  }

  if (path === '/crdt/close' && req.method === 'POST') {
    if (!crdtBridge)
      return jsonResponse({ error: 'CRDT bridge not initialized' }, 503);
    const body = (await req.json()) as { path?: string };
    if (!body.path) return jsonResponse({ error: 'path is required' }, 400);
    crdtBridge.closeFile(body.path);
    return jsonResponse({ closed: true, path: body.path });
  }

  if (path === '/crdt/files' && req.method === 'GET') {
    if (!crdtBridge)
      return jsonResponse({ error: 'CRDT bridge not initialized' }, 503);
    return jsonResponse(crdtBridge.getOpenFiles());
  }

  if (path === '/crdt/cursor' && req.method === 'POST') {
    if (!crdtBridge)
      return jsonResponse({ error: 'CRDT bridge not initialized' }, 503);
    const body = (await req.json()) as {
      path?: string;
      line?: number;
      col?: number;
    };
    if (!body.path || body.line === undefined || body.col === undefined) {
      return jsonResponse({ error: 'path, line, and col are required' }, 400);
    }
    crdtBridge.updateCursor(body.path, body.line, body.col);
    return jsonResponse({ updated: true });
  }

  if (path === '/crdt/selection' && req.method === 'POST') {
    if (!crdtBridge)
      return jsonResponse({ error: 'CRDT bridge not initialized' }, 503);
    const body = (await req.json()) as {
      path?: string;
      startLine?: number;
      startCol?: number;
      endLine?: number;
      endCol?: number;
    };
    if (
      !body.path ||
      body.startLine === undefined ||
      body.startCol === undefined ||
      body.endLine === undefined ||
      body.endCol === undefined
    ) {
      return jsonResponse(
        { error: 'path, startLine, startCol, endLine, endCol are required' },
        400
      );
    }
    crdtBridge.updateSelection(
      body.path,
      body.startLine,
      body.startCol,
      body.endLine,
      body.endCol
    );
    return jsonResponse({ updated: true });
  }

  if (path === '/crdt/cursors' && req.method === 'GET') {
    if (!crdtBridge)
      return jsonResponse({ error: 'CRDT bridge not initialized' }, 503);
    const filePath = url.searchParams.get('path');
    if (!filePath)
      return jsonResponse({ error: 'path query param is required' }, 400);
    return jsonResponse(crdtBridge.getCursors(filePath));
  }

  if (path === '/crdt/diagnostics' && req.method === 'POST') {
    if (!crdtBridge)
      return jsonResponse({ error: 'CRDT bridge not initialized' }, 503);
    const body = (await req.json()) as {
      path?: string;
      diagnostics?: Array<{
        filePath: string;
        line: number;
        column: number;
        severity: string;
        message: string;
        source: string;
      }>;
    };
    if (!body.path || !body.diagnostics) {
      return jsonResponse({ error: 'path and diagnostics are required' }, 400);
    }
    crdtBridge.shareDiagnostics(
      body.path,
      body.diagnostics as Parameters<typeof crdtBridge.shareDiagnostics>[1]
    );
    return jsonResponse({ shared: true, count: body.diagnostics.length });
  }

  if (path === '/crdt/diagnostics' && req.method === 'GET') {
    if (!crdtBridge)
      return jsonResponse({ error: 'CRDT bridge not initialized' }, 503);
    const filePath = url.searchParams.get('path');
    if (!filePath)
      return jsonResponse({ error: 'path query param is required' }, 400);
    return jsonResponse(crdtBridge.getDiagnostics(filePath));
  }

  if (path === '/crdt/annotation' && req.method === 'POST') {
    if (!crdtBridge)
      return jsonResponse({ error: 'CRDT bridge not initialized' }, 503);
    const body = (await req.json()) as {
      path?: string;
      blockId?: string;
      content?: string;
      type?: 'comment' | 'todo' | 'question' | 'suggestion';
      line?: number;
    };
    if (
      !body.path ||
      !body.blockId ||
      !body.content ||
      !body.type ||
      body.line === undefined
    ) {
      return jsonResponse(
        { error: 'path, blockId, content, type, and line are required' },
        400
      );
    }
    const annotation = crdtBridge.addAnnotation(body.path, {
      blockId: body.blockId,
      content: body.content,
      type: body.type,
      line: body.line,
    });
    return jsonResponse(annotation);
  }

  if (path === '/crdt/annotations' && req.method === 'GET') {
    if (!crdtBridge)
      return jsonResponse({ error: 'CRDT bridge not initialized' }, 503);
    const filePath = url.searchParams.get('path');
    if (!filePath)
      return jsonResponse({ error: 'path query param is required' }, 400);
    return jsonResponse(crdtBridge.getAnnotations(filePath));
  }

  if (path === '/crdt/reading' && req.method === 'POST') {
    if (!crdtBridge)
      return jsonResponse({ error: 'CRDT bridge not initialized' }, 503);
    const body = (await req.json()) as {
      path?: string;
      blockId?: string;
      timeSpentMs?: number;
    };
    if (!body.path || !body.blockId || !body.timeSpentMs) {
      return jsonResponse(
        { error: 'path, blockId, and timeSpentMs are required' },
        400
      );
    }
    crdtBridge.recordReading(body.path, body.blockId, body.timeSpentMs);
    return jsonResponse({ recorded: true });
  }

  if (path === '/crdt/emotion' && req.method === 'POST') {
    if (!crdtBridge)
      return jsonResponse({ error: 'CRDT bridge not initialized' }, 503);
    const body = (await req.json()) as {
      path?: string;
      blockId?: string;
      emotion?: string;
      valence?: number;
      arousal?: number;
      dominance?: number;
      intensity?: number;
    };
    if (!body.path || !body.blockId || !body.emotion) {
      return jsonResponse(
        { error: 'path, blockId, and emotion are required' },
        400
      );
    }
    crdtBridge.tagEmotion(body.path, {
      blockId: body.blockId,
      emotion: body.emotion,
      valence: body.valence ?? 0,
      arousal: body.arousal ?? 0,
      dominance: body.dominance ?? 0,
      intensity: body.intensity ?? 0.5,
    });
    return jsonResponse({ tagged: true });
  }

  if (path === '/crdt/emotion' && req.method === 'GET') {
    if (!crdtBridge)
      return jsonResponse({ error: 'CRDT bridge not initialized' }, 503);
    const filePath = url.searchParams.get('path');
    const blockId = url.searchParams.get('blockId');
    if (!filePath || !blockId) {
      return jsonResponse(
        { error: 'path and blockId query params are required' },
        400
      );
    }
    return jsonResponse(crdtBridge.getEmotionTags(filePath, blockId));
  }

  if (path === '/crdt/participants' && req.method === 'GET') {
    if (!crdtBridge)
      return jsonResponse({ error: 'CRDT bridge not initialized' }, 503);
    return jsonResponse(crdtBridge.getParticipants());
  }

  if (path === '/crdt/undo' && req.method === 'POST') {
    if (!crdtBridge)
      return jsonResponse({ error: 'CRDT bridge not initialized' }, 503);
    const body = (await req.json()) as { path?: string };
    if (!body.path) return jsonResponse({ error: 'path is required' }, 400);
    crdtBridge.undo(body.path);
    return jsonResponse({ undone: true });
  }

  if (path === '/crdt/snapshot' && req.method === 'GET') {
    if (!crdtBridge)
      return jsonResponse({ error: 'CRDT bridge not initialized' }, 503);
    const filePath = url.searchParams.get('path');
    if (!filePath)
      return jsonResponse({ error: 'path query param is required' }, 400);
    const snapshot = crdtBridge.getSnapshot(filePath);
    if (!snapshot) return jsonResponse({ error: 'File not open' }, 404);
    return jsonResponse({ path: filePath, snapshot: Array.from(snapshot) });
  }

  if (path === '/crdt/state-vector' && req.method === 'GET') {
    if (!crdtBridge)
      return jsonResponse({ error: 'CRDT bridge not initialized' }, 503);
    const filePath = url.searchParams.get('path');
    if (!filePath)
      return jsonResponse({ error: 'path query param is required' }, 400);
    const stateVector = crdtBridge.getStateVector(filePath);
    if (!stateVector) return jsonResponse({ error: 'File not open' }, 404);
    return jsonResponse({
      path: filePath,
      stateVector: Array.from(stateVector),
    });
  }

  if (path === '/crdt/ledger' && req.method === 'GET') {
    if (!crdtBridge)
      return jsonResponse({ error: 'CRDT bridge not initialized' }, 503);
    return jsonResponse(crdtBridge.getReputationLedger());
  }

  if (path === '/crdt/contribute' && req.method === 'POST') {
    if (!crdtBridge)
      return jsonResponse({ error: 'CRDT bridge not initialized' }, 503);
    const body = (await req.json()) as {
      peerId?: string;
      tokens?: number;
      requests?: number;
    };
    if (
      !body.peerId ||
      body.tokens === undefined ||
      body.requests === undefined
    ) {
      return jsonResponse(
        { error: 'peerId, tokens, and requests are required' },
        400
      );
    }
    crdtBridge.recordContribution(body.peerId, body.tokens, body.requests);
    return jsonResponse({ recorded: true });
  }

  if (path === '/crdt/redo' && req.method === 'POST') {
    if (!crdtBridge)
      return jsonResponse({ error: 'CRDT bridge not initialized' }, 503);
    const body = (await req.json()) as { path?: string };
    if (!body.path) return jsonResponse({ error: 'path is required' }, 400);
    crdtBridge.redo(body.path);
    return jsonResponse({ redone: true });
  }

  // ==================== UCAN Invite/Join (Ghostwriter Phase 2) ====================

  if (path === '/crdt/invite' && req.method === 'POST') {
    if (!crdtBridge)
      return jsonResponse({ error: 'CRDT bridge not initialized' }, 503);
    const body = (await req.json()) as {
      room?: string;
      mode?: string;
      ttlMs?: number;
    };
    if (!body.room) return jsonResponse({ error: 'room is required' }, 400);
    const mode = (body.mode ?? 'reviewMode') as ZedgeAccessMode;
    const status = crdtBridge.getStatus();
    const invite = generateInvite(status.peerId, body.room, mode, body.ttlMs);
    return jsonResponse(invite);
  }

  if (path === '/crdt/join' && req.method === 'POST') {
    if (!crdtBridge)
      return jsonResponse({ error: 'CRDT bridge not initialized' }, 503);
    const body = (await req.json()) as { token?: string };
    if (!body.token) return jsonResponse({ error: 'token is required' }, 400);
    const payload = parseRoomUcan(body.token);
    if (!payload) return jsonResponse({ error: 'Invalid token' }, 400);
    if (isRoomUcanExpired(body.token))
      return jsonResponse({ error: 'Token expired' }, 401);
    return jsonResponse({
      joined: true,
      room: payload.room,
      capabilities: payload.capabilities,
    });
  }

  // ==================== Agent Participant (Ghostwriter Phase 3) ====================

  if (path === '/agent-participant/join' && req.method === 'POST') {
    if (!crdtBridge)
      return jsonResponse({ error: 'CRDT bridge not initialized' }, 503);
    const body = (await req.json()) as {
      agentId?: string;
      displayName?: string;
      model?: string;
      color?: string;
      mode?: AgentMode;
    };
    if (!body.agentId || !body.model) {
      return jsonResponse({ error: 'agentId and model are required' }, 400);
    }
    const mode = body.mode ?? 'review';
    const agent = new AgentParticipant(
      {
        agentId: body.agentId,
        displayName: body.displayName ?? `${body.model} (${mode})`,
        model: body.model,
        color: body.color ?? '',
        mode,
      },
      crdtBridge,
      ucanBridge ?? undefined
    );
    await agent.join();
    agentParticipants.set(body.agentId, agent);
    return jsonResponse(agent.getStatus());
  }

  if (path === '/agent-participant/leave' && req.method === 'POST') {
    const body = (await req.json()) as { agentId?: string };
    if (!body.agentId)
      return jsonResponse({ error: 'agentId is required' }, 400);
    const agent = agentParticipants.get(body.agentId);
    if (!agent) return jsonResponse({ error: 'Agent not found' }, 404);
    agent.leave();
    agentParticipants.delete(body.agentId);
    return jsonResponse({ left: true, agentId: body.agentId });
  }

  if (path === '/agent-participant/status' && req.method === 'GET') {
    const agentId = url.searchParams.get('agentId');
    if (agentId) {
      const agent = agentParticipants.get(agentId);
      if (!agent) return jsonResponse({ error: 'Agent not found' }, 404);
      return jsonResponse(agent.getStatus());
    }
    return jsonResponse(
      Array.from(agentParticipants.values()).map((a) => a.getStatus())
    );
  }

  if (path === '/agent-participant/open' && req.method === 'POST') {
    const body = (await req.json()) as {
      agentId?: string;
      path?: string;
      initialContent?: string;
    };
    if (!body.agentId || !body.path) {
      return jsonResponse({ error: 'agentId and path are required' }, 400);
    }
    const agent = agentParticipants.get(body.agentId);
    if (!agent) return jsonResponse({ error: 'Agent not found' }, 404);
    const state = await agent.openFile(body.path, body.initialContent);
    return jsonResponse(state);
  }

  if (path === '/agent-participant/read' && req.method === 'GET') {
    const agentId = url.searchParams.get('agentId');
    const filePath = url.searchParams.get('path');
    if (!agentId || !filePath) {
      return jsonResponse(
        { error: 'agentId and path query params are required' },
        400
      );
    }
    const agent = agentParticipants.get(agentId);
    if (!agent) return jsonResponse({ error: 'Agent not found' }, 404);
    const content = agent.readFile(filePath);
    if (content === null) return jsonResponse({ error: 'File not open' }, 404);
    return jsonResponse({ path: filePath, content });
  }

  if (path === '/agent-participant/insert' && req.method === 'POST') {
    const body = (await req.json()) as {
      agentId?: string;
      path?: string;
      offset?: number;
      text?: string;
    };
    if (
      !body.agentId ||
      !body.path ||
      body.offset === undefined ||
      !body.text
    ) {
      return jsonResponse(
        { error: 'agentId, path, offset, and text are required' },
        400
      );
    }
    const agent = agentParticipants.get(body.agentId);
    if (!agent) return jsonResponse({ error: 'Agent not found' }, 404);
    const ok = agent.insert(body.path, body.offset, body.text);
    return jsonResponse({ inserted: ok });
  }

  if (path === '/agent-participant/delete' && req.method === 'POST') {
    const body = (await req.json()) as {
      agentId?: string;
      path?: string;
      offset?: number;
      length?: number;
    };
    if (
      !body.agentId ||
      !body.path ||
      body.offset === undefined ||
      !body.length
    ) {
      return jsonResponse(
        { error: 'agentId, path, offset, and length are required' },
        400
      );
    }
    const agent = agentParticipants.get(body.agentId);
    if (!agent) return jsonResponse({ error: 'Agent not found' }, 404);
    const ok = agent.delete(body.path, body.offset, body.length);
    return jsonResponse({ deleted: ok });
  }

  if (path === '/agent-participant/replace' && req.method === 'POST') {
    const body = (await req.json()) as {
      agentId?: string;
      path?: string;
      offset?: number;
      length?: number;
      text?: string;
    };
    if (
      !body.agentId ||
      !body.path ||
      body.offset === undefined ||
      !body.length ||
      body.text === undefined
    ) {
      return jsonResponse(
        { error: 'agentId, path, offset, length, and text are required' },
        400
      );
    }
    const agent = agentParticipants.get(body.agentId);
    if (!agent) return jsonResponse({ error: 'Agent not found' }, 404);
    const ok = agent.replace(body.path, body.offset, body.length, body.text);
    return jsonResponse({ replaced: ok });
  }

  if (path === '/agent-participant/batch-edit' && req.method === 'POST') {
    const body = (await req.json()) as {
      agentId?: string;
      edits?: AgentEdit[];
    };
    if (!body.agentId || !body.edits?.length) {
      return jsonResponse({ error: 'agentId and edits are required' }, 400);
    }
    const agent = agentParticipants.get(body.agentId);
    if (!agent) return jsonResponse({ error: 'Agent not found' }, 404);
    const applied = agent.applyEdits(body.edits);
    return jsonResponse({ applied });
  }

  if (path === '/agent-participant/batch-replace' && req.method === 'POST') {
    const body = (await req.json()) as {
      agentId?: string;
      replacements?: AgentReplacement[];
    };
    if (!body.agentId || !body.replacements?.length) {
      return jsonResponse(
        { error: 'agentId and replacements are required' },
        400
      );
    }
    const agent = agentParticipants.get(body.agentId);
    if (!agent) return jsonResponse({ error: 'Agent not found' }, 404);
    const applied = agent.applyReplacements(body.replacements);
    return jsonResponse({ applied });
  }

  if (path === '/agent-participant/review' && req.method === 'POST') {
    const body = (await req.json()) as {
      agentId?: string;
      path?: string;
      line?: number;
      content?: string;
      type?: 'comment' | 'suggestion';
    };
    if (
      !body.agentId ||
      !body.path ||
      body.line === undefined ||
      !body.content
    ) {
      return jsonResponse(
        { error: 'agentId, path, line, and content are required' },
        400
      );
    }
    const agent = agentParticipants.get(body.agentId);
    if (!agent) return jsonResponse({ error: 'Agent not found' }, 404);
    if (body.type === 'suggestion') {
      agent.addSuggestion(body.path, body.line, body.content);
    } else {
      agent.addReviewComment(body.path, body.line, body.content);
    }
    return jsonResponse({ reviewed: true });
  }

  if (path === '/agent-participant/thinking' && req.method === 'POST') {
    const body = (await req.json()) as { agentId?: string; context?: string };
    if (!body.agentId)
      return jsonResponse({ error: 'agentId is required' }, 400);
    const agent = agentParticipants.get(body.agentId);
    if (!agent) return jsonResponse({ error: 'Agent not found' }, 404);
    agent.setThinking(body.context ?? '');
    return jsonResponse({ thinking: true });
  }

  if (path === '/agent-participant/undo' && req.method === 'POST') {
    const body = (await req.json()) as { agentId?: string; path?: string };
    if (!body.agentId || !body.path) {
      return jsonResponse({ error: 'agentId and path are required' }, 400);
    }
    const agent = agentParticipants.get(body.agentId);
    if (!agent) return jsonResponse({ error: 'Agent not found' }, 404);
    agent.undo(body.path);
    return jsonResponse({ undone: true });
  }

  if (path === '/agent-participant/redo' && req.method === 'POST') {
    const body = (await req.json()) as { agentId?: string; path?: string };
    if (!body.agentId || !body.path) {
      return jsonResponse({ error: 'agentId and path are required' }, 400);
    }
    const agent = agentParticipants.get(body.agentId);
    if (!agent) return jsonResponse({ error: 'Agent not found' }, 404);
    agent.redo(body.path);
    return jsonResponse({ redone: true });
  }

  // ==================== UCAN Auth (Ghostwriter Phase 2) ====================

  if (path === '/ucan/status' && req.method === 'GET') {
    if (!ucanBridge)
      return jsonResponse({ error: 'UCAN bridge not initialized' }, 503);
    return jsonResponse(ucanBridge.getStatus());
  }

  if (path === '/ucan/did' && req.method === 'GET') {
    if (!ucanBridge)
      return jsonResponse({ error: 'UCAN bridge not initialized' }, 503);
    return jsonResponse({
      did: ucanBridge.getDid(),
      publicKey: ucanBridge.getPublicKeyJwk(),
    });
  }

  if (path === '/ucan/issue' && req.method === 'POST') {
    if (!ucanBridge)
      return jsonResponse({ error: 'UCAN bridge not initialized' }, 503);
    const body = (await req.json()) as {
      audienceDid?: string;
      capabilities?: UcanCapability[];
      expirationSeconds?: number;
    };
    if (!body.audienceDid || !body.capabilities?.length) {
      return jsonResponse(
        { error: 'audienceDid and capabilities are required' },
        400
      );
    }
    const token = await ucanBridge.issueToken(
      body.audienceDid,
      body.capabilities,
      body.expirationSeconds
    );
    return jsonResponse({
      token: token.token,
      expiresAt: token.payload.exp * 1000,
    });
  }

  if (path === '/ucan/agent' && req.method === 'POST') {
    if (!ucanBridge)
      return jsonResponse({ error: 'UCAN bridge not initialized' }, 503);
    const body = (await req.json()) as {
      agentDid?: string;
      mode?: AgentMode;
      expirationSeconds?: number;
    };
    if (!body.agentDid || !body.mode) {
      return jsonResponse({ error: 'agentDid and mode are required' }, 400);
    }
    if (!['review', 'pair', 'autonomous'].includes(body.mode)) {
      return jsonResponse(
        { error: 'mode must be review, pair, or autonomous' },
        400
      );
    }
    const result = await ucanBridge.issueAgentToken(
      body.agentDid,
      body.mode,
      body.expirationSeconds
    );
    return jsonResponse({
      token: result.token,
      mode: result.mode,
      capabilities: result.payload.att,
      expiresAt: result.payload.exp * 1000,
    });
  }

  if (path === '/ucan/invite' && req.method === 'POST') {
    if (!ucanBridge)
      return jsonResponse({ error: 'UCAN bridge not initialized' }, 503);
    const body = (await req.json()) as {
      audienceDid?: string;
      path?: string;
      dirPath?: string;
      access?: 'read' | 'write' | 'read_write';
      expirationSeconds?: number;
      label?: string;
      open?: boolean;
    };
    const invite = body.open
      ? await ucanBridge.createOpenInvite({
          path: body.path,
          dirPath: body.dirPath,
          access: body.access,
          expirationSeconds: body.expirationSeconds,
        })
      : await ucanBridge.createInvite(body.audienceDid ?? 'did:key:*', {
          path: body.path,
          dirPath: body.dirPath,
          access: body.access,
          expirationSeconds: body.expirationSeconds,
          label: body.label,
        });
    return jsonResponse(invite);
  }

  if (path === '/ucan/verify' && req.method === 'POST') {
    if (!ucanBridge)
      return jsonResponse({ error: 'UCAN bridge not initialized' }, 503);
    const body = (await req.json()) as {
      token?: string;
      requiredCapabilities?: UcanCapability[];
    };
    if (!body.token) return jsonResponse({ error: 'token is required' }, 400);
    const result = await ucanBridge.verifyToken(
      body.token,
      body.requiredCapabilities
    );
    return jsonResponse(result);
  }

  if (path === '/ucan/grants' && req.method === 'GET') {
    if (!ucanBridge)
      return jsonResponse({ error: 'UCAN bridge not initialized' }, 503);
    return jsonResponse(ucanBridge.listGrants());
  }

  if (path.startsWith('/ucan/revoke/') && req.method === 'POST') {
    if (!ucanBridge)
      return jsonResponse({ error: 'UCAN bridge not initialized' }, 503);
    const grantId = path.slice('/ucan/revoke/'.length);
    const revoked = ucanBridge.revokeGrant(grantId);
    return jsonResponse({ revoked, grantId });
  }

  if (path === '/ucan/revoke-audience' && req.method === 'POST') {
    if (!ucanBridge)
      return jsonResponse({ error: 'UCAN bridge not initialized' }, 503);
    const body = (await req.json()) as { audienceDid?: string };
    if (!body.audienceDid)
      return jsonResponse({ error: 'audienceDid is required' }, 400);
    const count = ucanBridge.revokeAudience(body.audienceDid);
    return jsonResponse({ revoked: count, audienceDid: body.audienceDid });
  }

  if (path === '/ucan/revoke-mode' && req.method === 'POST') {
    if (!ucanBridge)
      return jsonResponse({ error: 'UCAN bridge not initialized' }, 503);
    const body = (await req.json()) as { mode?: AgentMode };
    if (!body.mode) return jsonResponse({ error: 'mode is required' }, 400);
    const count = ucanBridge.revokeMode(body.mode);
    return jsonResponse({ revoked: count, mode: body.mode });
  }

  return jsonResponse({ error: 'Not found' }, 404);
}

function requestPayloadToWebRequest(request: RequestPayload): Request {
  const host = request.headers.host ?? `localhost:${getCompanionPort()}`;
  const query = request.query ?? '';
  const headers = new Headers();
  for (const [key, value] of Object.entries(request.headers)) {
    headers.set(key, value);
  }

  const init: RequestInit = {
    method: request.method,
    headers,
  };
  if (
    request.method !== 'GET' &&
    request.method !== 'HEAD' &&
    request.body &&
    request.body.length > 0
  ) {
    init.body = new Blob([Uint8Array.from(request.body)]);
  }

  return new Request(`http://${host}${request.path}${query}`, init);
}

async function webResponseToPayload(
  response: Response
): Promise<ResponsePayload> {
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: response.body
      ? new Uint8Array(await response.arrayBuffer())
      : new Uint8Array(0),
  };
}

export const zedgeControlSurface: XGnosisControlSurface = {
  async handleRequest(request) {
    if (request.path.startsWith('/.aeon/')) {
      return null;
    }

    const webRequest = requestPayloadToWebRequest(request);
    const webResponse = await handleWebRequest(webRequest);
    return await webResponseToPayload(webResponse);
  },
};

function createCompanionConfigSource(port: number): string {
  return `
http {
  server {
    listen ${port};
    server_name localhost 127.0.0.1 _;
    root /;
  }
}
`;
}

let nativeListenerCleanupRegistered = false;
let nativeListenerProcess: Bun.Subprocess | null = null;

function registerNativeListenerCleanup(): void {
  if (nativeListenerCleanupRegistered) {
    return;
  }

  nativeListenerCleanupRegistered = true;
  process.on('exit', () => {
    try {
      nativeListenerProcess?.kill();
    } catch {
      // Best effort shutdown
    }
  });
}

async function waitForListenerHealth(
  port: number,
  timeoutMs = 90_000
): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(1_500),
      });
      if (response.ok) {
        return;
      }
    } catch {
      // Listener not ready yet.
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Listener on :${port} did not become healthy in time`);
}

async function startNativeProxyListener(
  publicPort: number,
  listenerConfig: ReturnType<typeof getZedgeConfig>['listener']
): Promise<void> {
  if (typeof Bun === 'undefined') {
    throw new Error('gnosis-uring proxy mode requires the Bun runtime');
  }

  const internalPort = listenerConfig.internalPort ?? publicPort;
  const internalServer = new XGnosisServer({
    configSource: createCompanionConfigSource(internalPort),
    controlSurfaces: [zedgeControlSurface],
    listenHostname: '127.0.0.1',
  });

  await internalServer.listen();

  const command = resolveGnosisUringCommand({
    port: publicPort,
    root: '/',
    threads: listenerConfig.threads,
    flowPort: listenerConfig.flowPort,
    useUring: listenerConfig.useUring,
    proxyAll: true,
    proxyUpstreamHost: '127.0.0.1',
    proxyUpstreamPort: internalPort,
  });

  registerNativeListenerCleanup();
  nativeListenerProcess = Bun.spawn([command.command, ...command.args], {
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  void nativeListenerProcess.exited.then((exitCode) => {
    if (nativeListenerProcess) {
      console.warn(
        `[zedge] gnosis-uring proxy exited with code ${exitCode} (${command.display})`
      );
      nativeListenerProcess = null;
    }
  });

  await waitForListenerHealth(publicPort);
  console.log(
    `[zedge] Companion sidecar v2.0 mounted on gnosis-uring:${publicPort} -> x-gnosis:127.0.0.1:${internalPort}`
  );
}

export async function startServer(): Promise<void> {
  const config = getZedgeConfig();
  const port = getCompanionPort();

  if (config.listener.mode === 'gnosis-uring-proxy') {
    try {
      await startNativeProxyListener(port, config.listener);
    } catch (error) {
      console.warn(
        `[zedge] Falling back to direct x-gnosis listener: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  if (!nativeListenerProcess) {
    const server = new XGnosisServer({
      configSource: createCompanionConfigSource(port),
      controlSurfaces: [zedgeControlSurface],
    });

    await server.listen();
    console.log(
      `[zedge] Companion sidecar v2.0 mounted on x-gnosis at http://localhost:${port}`
    );
  }

  console.log(`[zedge] OpenAI-compatible API: http://localhost:${port}/v1`);
  console.log(
    `[zedge] Superinference: POST http://localhost:${port}/v1/superinference`
  );
  console.log(`[zedge] Mesh: http://localhost:${port}/mesh/status`);
  console.log(`[zedge] Agent: POST http://localhost:${port}/agent/session`);
  console.log(`[zedge] Forge: http://localhost:${port}/forge/status`);
  console.log(`[zedge] Health: http://localhost:${port}/health`);
  console.log(`[zedge] Ghostwriter CRDT: http://localhost:${port}/crdt/status`);
  console.log(`[zedge] Ghostwriter UCAN: http://localhost:${port}/ucan/status`);
}
