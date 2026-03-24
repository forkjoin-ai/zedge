/**
 * Cloud CERA Agent Sessions
 *
 * Runs CERA agents in the cloud (via forge) with VFS-mounted access to
 * the user's codebase. The agent reads/writes files through the encrypted
 * CRDT-backed VFS bridge. Edits appear in Zed as individually undoable
 * CRDT operations. Rejections feed the void map → BuleyeanTrainer.
 *
 * Flow:
 *   1. User triggers cloud agent from Zed (/zedge-agent or MCP tool)
 *   2. Session created: VFS mount shared with forge agent
 *   3. Agent runs GG topology (fork/race/fold)
 *   4. File reads go through VFS → encrypted CRDT → local filesystem
 *   5. File writes go through VFS → CRDT op → appears in editor
 *   6. Agent activity streamed back via SSE
 *   7. On completion: results collected, rejections → void map
 */

import { voidMapStore } from './void-map-store';
import type { VfsMount } from './vfs-bridge';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CloudAgentSession {
  id: string;
  agentName: string;
  status: 'starting' | 'running' | 'completed' | 'failed' | 'cancelled';
  /** VFS mount ID the agent operates on */
  vfsMountId: string | null;
  /** Forge process ID (if deployed) */
  forgeProcessId: string | null;
  /** Target files the agent is working on */
  targetFiles: string[];
  /** Task description */
  task: string;
  /** Agent results (populated on completion) */
  result?: CloudAgentResult;
  /** Error message (populated on failure) */
  error?: string;
  /** Timestamps */
  startedAt: number;
  completedAt?: number;
}

export interface CloudAgentResult {
  /** Files modified by the agent */
  filesModified: string[];
  /** Agent's analysis/review output */
  output: string;
  /** Number of CRDT edits applied */
  editsApplied: number;
  /** Duration in ms */
  durationMs: number;
  /** Topology execution metrics */
  metrics?: {
    beta1: number;
    nodeCount: number;
    edgeCount: number;
  };
}

export interface CloudAgentConfig {
  /** Agent name (must match a GG agent in forge) */
  agentName: string;
  /** Task description */
  task: string;
  /** Target files to operate on */
  targetFiles?: string[];
  /** VFS mount to use (creates new if not provided) */
  vfsMountId?: string;
  /** Model override for the agent */
  model?: string;
  /** Timeout in ms */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// SSE Clients
// ---------------------------------------------------------------------------

const sseClients = new Map<string, Set<ReadableStreamDefaultController>>();

function broadcastToSession(
  sessionId: string,
  event: Record<string, unknown>
): void {
  const clients = sseClients.get(sessionId);
  if (!clients) return;
  const encoder = new TextEncoder();
  const payload = encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
  for (const client of clients) {
    try {
      client.enqueue(payload);
    } catch {
      clients.delete(client);
    }
  }
}

// ---------------------------------------------------------------------------
// Session Manager
// ---------------------------------------------------------------------------

const sessions = new Map<string, CloudAgentSession>();
let nextSessionId = 0;

/**
 * Start a cloud CERA agent session.
 */
export async function startCloudAgent(
  config: CloudAgentConfig
): Promise<CloudAgentSession> {
  const sessionId = `cloud-agent-${Date.now()}-${nextSessionId++}`;

  const session: CloudAgentSession = {
    id: sessionId,
    agentName: config.agentName,
    status: 'starting',
    vfsMountId: config.vfsMountId ?? null,
    forgeProcessId: null,
    targetFiles: config.targetFiles ?? [],
    task: config.task,
    startedAt: Date.now(),
  };

  sessions.set(sessionId, session);
  broadcastToSession(sessionId, { type: 'session-created', sessionId });

  // Launch agent execution asynchronously
  executeCloudAgent(session, config).catch((err) => {
    session.status = 'failed';
    session.error = err instanceof Error ? err.message : String(err);
    session.completedAt = Date.now();
    broadcastToSession(sessionId, {
      type: 'session-failed',
      sessionId,
      error: session.error,
    });
  });

  return session;
}

/**
 * Execute the cloud agent (internal).
 *
 * Strategy: try the REAL forge agent scheduler first (HTTP POST to agent's
 * /tick endpoint with full AgentTickContext). Fall back to superinference
 * if the agent isn't deployed or the scheduler isn't available.
 */
async function executeCloudAgent(
  session: CloudAgentSession,
  config: CloudAgentConfig
): Promise<void> {
  session.status = 'running';
  broadcastToSession(session.id, { type: 'agent-running', agentName: config.agentName });

  const timeoutMs = config.timeoutMs ?? 120_000;
  const t0 = Date.now();

  try {
    // --- Path 1: Try REAL forge agent invocation ---
    const forgeResult = await tryForgeAgentTick(session, config, timeoutMs);

    if (forgeResult) {
      session.result = forgeResult;
      session.status = 'completed';
      session.completedAt = Date.now();

      broadcastToSession(session.id, {
        type: 'session-completed',
        sessionId: session.id,
        result: session.result,
        path: 'forge-agent',
      });
      return;
    }

    // --- Path 2: Try topology execution through Betty ---
    const topologyResult = await tryTopologyExecution(session, config, timeoutMs);

    if (topologyResult) {
      session.result = topologyResult;
      session.status = 'completed';
      session.completedAt = Date.now();

      broadcastToSession(session.id, {
        type: 'session-completed',
        sessionId: session.id,
        result: session.result,
        path: 'topology-executor',
      });
      return;
    }

    // --- Path 3: Fallback to superinference ---
    broadcastToSession(session.id, {
      type: 'fallback',
      reason: 'forge agent not deployed, topology not available',
    });

    const superResult = await executeSuperinferenceFallback(session, config, timeoutMs);
    session.result = superResult;
    session.status = 'completed';
    session.completedAt = Date.now();

    broadcastToSession(session.id, {
      type: 'session-completed',
      sessionId: session.id,
      result: session.result,
      path: 'superinference-fallback',
    });
  } catch (err) {
    session.status = 'failed';
    session.error = err instanceof Error ? err.message : String(err);
    session.completedAt = Date.now();

    voidMapStore.record({
      filePath: session.targetFiles[0] ?? 'unknown',
      category: 'cloud-agent-failure',
      rejectedContent: `Agent ${config.agentName} failed: ${session.error}`,
      source: 'cera',
    });

    broadcastToSession(session.id, {
      type: 'session-failed',
      sessionId: session.id,
      error: session.error,
    });
  }
}

/**
 * Path 1: Invoke the real forge agent via HTTP /tick endpoint.
 * Returns null if the agent isn't deployed or unreachable.
 */
async function tryForgeAgentTick(
  session: CloudAgentSession,
  config: CloudAgentConfig,
  timeoutMs: number
): Promise<CloudAgentResult | null> {
  try {
    // Try to discover agent ports from forge
    const { discoverProjects } = await import(
      '../../../aeon-forge/src/deploy/discovery'
    );
    const workspacePath = process.env.AEON_ROOT || process.cwd();
    const projects = await discoverProjects(workspacePath);
    const agentProject = projects.find(
      (p: { name: string; kind: string }) =>
        p.name === config.agentName && p.kind === 'agent'
    );

    if (!agentProject) return null;

    // Build AgentTickContext
    const tickContext = {
      trigger: 'manual' as const,
      payload: {
        task: config.task,
        targetFiles: session.targetFiles,
        model: config.model,
      },
      env: {
        AEON_ROOT: workspacePath,
        AGENT_NAME: config.agentName,
        ...process.env as Record<string, string>,
      },
      tickNumber: Date.now(),
    };

    // POST to the agent's /tick endpoint
    const port = agentProject.port ?? 4800;
    const resp = await fetch(`http://127.0.0.1:${port}/tick`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tickContext),
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!resp.ok) return null;

    const tickResult = (await resp.json()) as {
      success: boolean;
      outputs?: Record<string, unknown>;
      actions?: Array<{ type: string; detail: string; url?: string }>;
      durationMs?: number;
      entropy?: { before: number; after: number; delta: number };
    };

    if (!tickResult.success) return null;

    return {
      filesModified: session.targetFiles,
      output: JSON.stringify(tickResult.outputs ?? {}, null, 2),
      editsApplied: tickResult.actions?.filter((a) => a.type === 'deploy').length ?? 0,
      durationMs: tickResult.durationMs ?? Date.now() - session.startedAt,
      metrics: tickResult.entropy
        ? {
            beta1: Math.abs(tickResult.entropy.delta),
            nodeCount: tickResult.actions?.length ?? 0,
            edgeCount: 0,
          }
        : undefined,
    };
  } catch {
    return null; // Agent not deployed or unreachable
  }
}

/**
 * Path 2: Execute the agent's topology through Betty/GnosisRuntime.
 * Returns null if topology file doesn't exist or compilation fails.
 */
async function tryTopologyExecution(
  session: CloudAgentSession,
  config: CloudAgentConfig,
  _timeoutMs: number
): Promise<CloudAgentResult | null> {
  try {
    const { existsSync, readFileSync } = await import('node:fs');
    const { resolve, join } = await import('node:path');
    const workspacePath = process.env.AEON_ROOT || process.cwd();

    // Look for the agent's topology file
    const agentDir = resolve(workspacePath, 'packages', config.agentName);
    const tomlPath = join(agentDir, 'aeon.toml');

    if (!existsSync(tomlPath)) return null;

    // Parse topology path from aeon.toml
    const toml = readFileSync(tomlPath, 'utf-8');
    const topologyMatch = toml.match(/topology\s*=\s*"([^"]+)"/);
    if (!topologyMatch) return null;

    const topologyPath = resolve(agentDir, topologyMatch[1]);
    if (!existsSync(topologyPath)) return null;

    // Execute through topology runner
    const { runTopology } = await import('./topology-runner');
    const result = await runTopology({
      filePath: topologyPath,
      input: {
        task: config.task,
        targetFiles: session.targetFiles,
      },
    });

    if (!result.success) return null;

    return {
      filesModified: session.targetFiles,
      output: result.logs + '\n' + JSON.stringify(result.payload, null, 2),
      editsApplied: 0,
      durationMs: result.durationMs,
      metrics: {
        beta1: result.metrics.beta1,
        nodeCount: result.metrics.nodeCount,
        edgeCount: result.metrics.edgeCount,
      },
    };
  } catch {
    return null;
  }
}

/**
 * Path 3: Superinference fallback (original behavior).
 * Used when forge agent isn't deployed and topology isn't available.
 */
async function executeSuperinferenceFallback(
  session: CloudAgentSession,
  config: CloudAgentConfig,
  timeoutMs: number
): Promise<CloudAgentResult> {
  const t0 = Date.now();
  const { readFileSync } = await import('node:fs');
  const { resolve } = await import('node:path');
  const workspacePath = process.env.AEON_ROOT || process.cwd();

  const fileContents: Record<string, string> = {};
  for (const file of session.targetFiles.slice(0, 5)) {
    try {
      fileContents[file] = readFileSync(resolve(workspacePath, file), 'utf-8').slice(0, 8000);
    } catch { /* File may not exist */ }
  }

  const fileContext = Object.entries(fileContents)
    .map(([path, content]) => `--- ${path} ---\n${content}`)
    .join('\n\n');

  const { superinfer } = await import('./superinference');
  const { analyzeCodeEmotion, routeByEmotion } = await import('./emotion-router');

  let strategy: 'fastest' | 'consensus' | 'constructive' = 'constructive';
  if (fileContext) {
    const emotion = analyzeCodeEmotion(fileContext);
    const route = routeByEmotion(emotion);
    strategy = route.strategy;
  }

  const steering = voidMapStore.getSteeringVector(session.targetFiles[0]);

  const result = await superinfer({
    request: {
      model: config.model ?? 'qwen-2.5-coder-7b',
      messages: [
        {
          role: 'system',
          content: `You are a CERA cloud agent (${config.agentName}). Analyze the code and produce actionable results.\n\nAgent: ${config.agentName}\nTask: ${config.task}`,
        },
        {
          role: 'user',
          content: fileContext || `Task: ${config.task}\n\nNo target files specified.`,
        },
      ],
      temperature: 0.3,
      max_tokens: 2048,
    },
    models: [config.model ?? 'qwen-2.5-coder-7b'],
    strategy,
    steeringOverrides: steering.negativePrompt || undefined,
    timeoutMs,
  });

  return {
    filesModified: session.targetFiles,
    output: result.content,
    editsApplied: 0,
    durationMs: Date.now() - t0,
    metrics: {
      beta1: result.confidence,
      nodeCount: result.modelResults.length,
      edgeCount: 0,
    },
  };
}

/**
 * Get a session by ID.
 */
export function getSession(sessionId: string): CloudAgentSession | null {
  return sessions.get(sessionId) ?? null;
}

/**
 * List all sessions.
 */
export function listSessions(limit = 20): CloudAgentSession[] {
  return [...sessions.values()]
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, limit);
}

/**
 * Cancel a running session.
 */
export function cancelSession(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (!session || session.status !== 'running') return false;
  session.status = 'cancelled';
  session.completedAt = Date.now();
  broadcastToSession(sessionId, { type: 'session-cancelled', sessionId });
  return true;
}

/**
 * Create an SSE stream for a session's events.
 */
export function createSessionStream(sessionId: string): ReadableStream {
  const encoder = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  if (!sseClients.has(sessionId)) {
    sseClients.set(sessionId, new Set());
  }

  return new ReadableStream({
    start(controller) {
      sseClients.get(sessionId)!.add(controller);

      // Send current session state
      const session = sessions.get(sessionId);
      if (session) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: 'session-state', session })}\n\n`)
        );
      }

      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': heartbeat\n\n'));
        } catch {
          if (heartbeat) clearInterval(heartbeat);
          sseClients.get(sessionId)?.delete(controller);
        }
      }, 15_000);
    },
    cancel() {
      if (heartbeat) clearInterval(heartbeat);
    },
  });
}
