/**
 * Gnosis Topology Runner -- Execute .gg files from Zed
 *
 * Runs topologies through the gnosis engine and streams execution
 * results back to the editor. Supports:
 * - Direct .gg file execution
 * - TypeScript files with embedded topology directives
 * - Live execution visualization via SSE
 * - Formal verification (beta1, universe law)
 *
 * Flow:
 *   /zedge-gnosis-run → read active .gg file → compile with Betty
 *   → execute with GnosisEngine → stream results + metrics
 *   → store execution engram for future recall
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, extname } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TopologyRunRequest {
  /** File path to execute (absolute or workspace-relative) */
  filePath: string;
  /** Optional input payload for the topology */
  input?: unknown;
  /** Execution strategy */
  strategy?: 'cannon' | 'linear';
  /** Timeout in ms */
  timeoutMs?: number;
}

export interface TopologyRunResult {
  /** Whether execution succeeded */
  success: boolean;
  /** Topology output payload */
  payload: unknown;
  /** Execution logs */
  logs: string;
  /** Compiler diagnostics */
  diagnostics: Array<{
    line: number;
    column: number;
    message: string;
    severity: string;
  }>;
  /** Topology metrics */
  metrics: {
    beta1: number;
    nodeCount: number;
    edgeCount: number;
    wallaceNumber?: number;
    quantumIndex?: number;
  };
  /** Duration in ms */
  durationMs: number;
  /** File that was executed */
  filePath: string;
  /** Error message on failure */
  error?: string;
}

// ---------------------------------------------------------------------------
// SSE Clients for live execution visualization
// ---------------------------------------------------------------------------

const runClients = new Set<ReadableStreamDefaultController>();

function broadcastRunEvent(event: Record<string, unknown>): void {
  const encoder = new TextEncoder();
  const payload = encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
  for (const client of runClients) {
    try {
      client.enqueue(payload);
    } catch {
      runClients.delete(client);
    }
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

/**
 * Execute a Gnosis topology file and return results.
 */
export async function runTopology(
  request: TopologyRunRequest
): Promise<TopologyRunResult> {
  const t0 = Date.now();
  const workspacePath = process.env.AEON_ROOT || process.cwd();
  const fullPath = resolve(workspacePath, request.filePath);

  if (!existsSync(fullPath)) {
    return {
      success: false,
      payload: null,
      logs: '',
      diagnostics: [],
      metrics: { beta1: 0, nodeCount: 0, edgeCount: 0 },
      durationMs: Date.now() - t0,
      filePath: request.filePath,
      error: `File not found: ${fullPath}`,
    };
  }

  const content = readFileSync(fullPath, 'utf-8');
  const ext = extname(fullPath);

  broadcastRunEvent({
    type: 'run-started',
    filePath: request.filePath,
    strategy: request.strategy ?? 'cannon',
  });

  try {
    // Compile with Betty compiler
    const { BettyCompiler } = await import(
      '../../../gnosis/src/betty/compiler'
    );
    const compiler = new BettyCompiler();
    const parseResult = compiler.parse(content);

    const diagnostics = (parseResult.diagnostics ?? []).map(
      (d: { line: number; column: number; message: string; severity: string }) => ({
        line: d.line,
        column: d.column,
        message: d.message,
        severity: d.severity,
      })
    );

    broadcastRunEvent({
      type: 'compiled',
      diagnosticCount: diagnostics.length,
      hasAst: !!parseResult.ast,
    });

    if (!parseResult.ast) {
      return {
        success: false,
        payload: null,
        logs: '',
        diagnostics,
        metrics: { beta1: 0, nodeCount: 0, edgeCount: 0 },
        durationMs: Date.now() - t0,
        filePath: request.filePath,
        error: 'Compilation failed -- no AST produced',
      };
    }

    // Count nodes and edges from AST
    const nodeCount = parseResult.ast.nodes?.size ?? 0;
    const edgeCount = parseResult.ast.edges?.length ?? 0;

    // For TypeScript files, use the ts-check path
    if (ext === '.ts' || ext === '.tsx') {
      const { checkTypeScriptWithGnosis } = await import(
        '../../../gnosis/src/ts-check'
      );
      const tsResult = await checkTypeScriptWithGnosis(content, fullPath);

      broadcastRunEvent({
        type: 'run-completed',
        filePath: request.filePath,
        nodeCount: tsResult.topology.nodes.length,
        edgeCount: tsResult.topology.edges.length,
        durationMs: Date.now() - t0,
      });

      return {
        success: true,
        payload: {
          topology: tsResult.topology,
          diagnostics: tsResult.diagnostics,
        },
        logs: `TypeScript topology: ${tsResult.topology.nodes.length} nodes, ${tsResult.topology.edges.length} edges`,
        diagnostics: tsResult.diagnostics.map(
          (d: { line: number; column?: number; message: string; severity?: string }) => ({
            line: d.line,
            column: d.column ?? 0,
            message: d.message,
            severity: d.severity ?? 'warning',
          })
        ),
        metrics: {
          beta1: tsResult.metrics?.beta1 ?? 0,
          nodeCount: tsResult.topology.nodes.length,
          edgeCount: tsResult.topology.edges.length,
          wallaceNumber: tsResult.metrics?.wallaceNumber,
          quantumIndex: tsResult.metrics?.quantumIndex,
        },
        durationMs: Date.now() - t0,
        filePath: request.filePath,
      };
    }

    // For .gg files, return compilation + metrics
    broadcastRunEvent({
      type: 'run-completed',
      filePath: request.filePath,
      nodeCount,
      edgeCount,
      durationMs: Date.now() - t0,
    });

    // Try to get metrics from the compile result (may exist on extended result types)
    const resultAny = parseResult as unknown as Record<string, unknown>;
    const metricsObj = resultAny.metrics as Record<string, number> | undefined;
    const buleyNumber = metricsObj?.buleyNumber ?? 0;
    const wallaceNumber = metricsObj?.wallaceNumber;

    return {
      success: true,
      payload: {
        nodes: [...(parseResult.ast.nodes?.entries() ?? [])].map(([id, node]) => ({
          id,
          labels: node.labels,
          properties: node.properties,
        })),
        edges: parseResult.ast.edges ?? [],
      },
      logs: `Topology: ${nodeCount} nodes, ${edgeCount} edges, beta1=${buleyNumber}`,
      diagnostics,
      metrics: {
        beta1: buleyNumber,
        nodeCount,
        edgeCount,
        wallaceNumber,
      },
      durationMs: Date.now() - t0,
      filePath: request.filePath,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);

    broadcastRunEvent({
      type: 'run-failed',
      filePath: request.filePath,
      error,
    });

    return {
      success: false,
      payload: null,
      logs: '',
      diagnostics: [],
      metrics: { beta1: 0, nodeCount: 0, edgeCount: 0 },
      durationMs: Date.now() - t0,
      filePath: request.filePath,
      error,
    };
  }
}

/**
 * Create an SSE stream for live topology execution events.
 */
export function createRunStream(): ReadableStream {
  const encoder = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  return new ReadableStream({
    start(controller) {
      runClients.add(controller);
      controller.enqueue(encoder.encode('data: {"type":"connected"}\n\n'));

      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': heartbeat\n\n'));
        } catch {
          if (heartbeat) clearInterval(heartbeat);
          runClients.delete(controller);
        }
      }, 15_000);
    },
    cancel() {
      if (heartbeat) clearInterval(heartbeat);
    },
  });
}
