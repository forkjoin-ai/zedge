/**
 * Daydream Annotations -- Surface suggestions in the editor
 *
 * Converts daydream candidates into LSP diagnostics (hints) and SSE events
 * that the Zed extension can render as inline gutter annotations.
 *
 * The flow:
 *   daydream cycle completes → candidates produced
 *   → convertToDiagnostics() → LSP publishDiagnostics (hint severity)
 *   → SSE stream pushes to connected clients
 *   → Zed shows gutter icons for each suggestion
 *   → Accept/reject through MCP tools
 */

import type { DaydreamCandidate, DaydreamCycle } from './daydream.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DaydreamDiagnostic {
  uri: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  severity: 4; // Hint
  message: string;
  source: string;
  code: string;
  data: {
    candidateId: string;
    category: string;
    confidence: number;
  };
}

export interface DaydreamAnnotationEvent {
  type:
    | 'daydream-candidate'
    | 'daydream-cycle-complete'
    | 'daydream-accepted'
    | 'daydream-rejected';
  candidate?: DaydreamCandidate;
  cycle?: {
    filePath: string;
    candidateCount: number;
    durationMs: number;
    model: string;
  };
  timestamp: number;
}

// ---------------------------------------------------------------------------
// SSE Clients
// ---------------------------------------------------------------------------

const sseClients = new Set<ReadableStreamDefaultController>();

export function addAnnotationClient(
  controller: ReadableStreamDefaultController
): void {
  sseClients.add(controller);
}

export function removeAnnotationClient(
  controller: ReadableStreamDefaultController
): void {
  sseClients.delete(controller);
}

function broadcastEvent(event: DaydreamAnnotationEvent): void {
  const encoder = new TextEncoder();
  const payload = encoder.encode(`data: ${JSON.stringify(event)}\n\n`);

  for (const client of sseClients) {
    try {
      client.enqueue(payload);
    } catch {
      sseClients.delete(client);
    }
  }
}

// ---------------------------------------------------------------------------
// Converters
// ---------------------------------------------------------------------------

/**
 * Convert daydream candidates to LSP hint diagnostics.
 * These show as subtle gutter indicators in the editor.
 */
export function convertToDiagnostics(
  candidates: DaydreamCandidate[],
  fileUri: string
): DaydreamDiagnostic[] {
  return candidates.map((c) => ({
    uri: fileUri,
    range: {
      start: { line: Math.max(0, c.line - 1), character: 0 },
      end: { line: Math.max(0, c.line - 1), character: 999 },
    },
    severity: 4, // Hint -- least intrusive
    message: `[${c.category}] ${c.suggestion}`,
    source: 'daydream',
    code: c.id,
    data: {
      candidateId: c.id,
      category: c.category,
      confidence: c.confidence,
    },
  }));
}

/**
 * Notify connected clients of new candidates.
 */
export function broadcastCandidates(candidates: DaydreamCandidate[]): void {
  for (const candidate of candidates) {
    broadcastEvent({
      type: 'daydream-candidate',
      candidate,
      timestamp: Date.now(),
    });
  }
}

/**
 * Notify connected clients that a dream cycle completed.
 */
export function broadcastCycleComplete(cycle: DaydreamCycle): void {
  broadcastEvent({
    type: 'daydream-cycle-complete',
    cycle: {
      filePath: cycle.filePath,
      candidateCount: cycle.candidates.length,
      durationMs: cycle.durationMs,
      model: cycle.model,
    },
    timestamp: Date.now(),
  });
}

/**
 * Notify clients that a candidate was accepted.
 */
export function broadcastAccepted(candidate: DaydreamCandidate): void {
  broadcastEvent({
    type: 'daydream-accepted',
    candidate,
    timestamp: Date.now(),
  });
}

/**
 * Notify clients that a candidate was rejected.
 */
export function broadcastRejected(candidate: DaydreamCandidate): void {
  broadcastEvent({
    type: 'daydream-rejected',
    candidate,
    timestamp: Date.now(),
  });
}

/**
 * Create an SSE stream for daydream annotation events.
 */
export function createAnnotationStream(): ReadableStream {
  const encoder = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  return new ReadableStream({
    start(controller) {
      addAnnotationClient(controller);
      controller.enqueue(encoder.encode('data: {"type":"connected"}\n\n'));

      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': heartbeat\n\n'));
        } catch {
          if (heartbeat) clearInterval(heartbeat);
          removeAnnotationClient(controller);
        }
      }, 15_000);
    },
    cancel() {
      if (heartbeat) clearInterval(heartbeat);
    },
  });
}

/**
 * Get connected client count.
 */
export function getAnnotationClientCount(): number {
  return sseClients.size;
}
