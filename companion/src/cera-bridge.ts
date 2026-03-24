/**
 * Zedge CERA Bridge -- Editor ↔ CERA Perturbation
 *
 * Subscribes to CERA events from the forge event bus, maintains
 * pending mutations, and exposes endpoints for accept/reject from Zed.
 */

import type {
  ExtendedForgoEvent,
  ForgeEventBus,
} from "../../../aeon-forge/src/deploy/event-bus.ts";
import type {
  PerturbationEngine,
  PerturbationCycle,
} from "../../../../shared-utils/src/laminar/perturbation-engine.ts";
import type { CodeMutationOutput } from "../../../../shared-utils/src/laminar/code-laminar.ts";
import { voidMapStore } from "./void-map-store.ts";

// ── Types ────────────────────────────────────────────────────

export interface PendingMutation {
  id: string;
  mutation: CodeMutationOutput;
  cycle: PerturbationCycle;
  timestamp: number;
  status: 'pending' | 'accepted' | 'rejected';
}

export interface CeraStatus {
  connected: boolean;
  pendingMutations: number;
  totalGraduated: number;
  totalRejected: number;
  totalAccepted: number;
  voidMapDensity: {
    rounds: number;
    entropy: number;
    complementWeights: Record<string, number>;
  };
  lastCycle: PerturbationCycle | null;
}

// ── CERA Bridge ──────────────────────────────────────────────

export class CeraBridge {
  private pendingMutations = new Map<string, PendingMutation>();
  private acceptedMutations: PendingMutation[] = [];
  private rejectedMutations: PendingMutation[] = [];
  private sseClients = new Set<ReadableStreamDefaultController>();
  private engine: PerturbationEngine | null;
  private eventBus: ForgeEventBus | null;
  private unsubscribe: (() => void) | null = null;
  private nextMutationId = 0;

  constructor(
    engine: PerturbationEngine | null = null,
    eventBus: ForgeEventBus | null = null
  ) {
    this.engine = engine;
    this.eventBus = eventBus;

    if (eventBus) {
      this.unsubscribe = eventBus.subscribe(
        (event) => this.handleEvent(event),
        {
          types: [
            'cera-scan-complete',
            'cera-mutation-result',
            'cera-graduation',
          ],
        }
      );
    }

    if (engine) {
      engine.setGraduationHandler((mutation) => {
        this.addPendingMutation(mutation);
      });
    }
  }

  /**
   * Accept a mutation -- apply to workspace and commit.
   */
  accept(mutationId: string): PendingMutation | null {
    const pending = this.pendingMutations.get(mutationId);
    if (!pending) return null;

    pending.status = 'accepted';
    this.acceptedMutations.push(pending);
    this.pendingMutations.delete(mutationId);

    this.broadcastSse({
      type: 'mutation-accepted',
      mutationId,
      mutation: pending.mutation,
    });

    return pending;
  }

  /**
   * Reject a mutation -- record in void map.
   */
  reject(mutationId: string): PendingMutation | null {
    const pending = this.pendingMutations.get(mutationId);
    if (!pending) return null;

    pending.status = 'rejected';
    this.rejectedMutations.push(pending);
    this.pendingMutations.delete(mutationId);

    // Persist rejection in void map store
    const mutationFilePath = pending.mutation.files?.[0]?.path ?? 'unknown';
    voidMapStore.record({
      filePath: mutationFilePath,
      category: 'cera-mutation',
      rejectedContent: pending.mutation.description ?? JSON.stringify(pending.mutation).slice(0, 200),
      source: 'cera',
    });

    this.broadcastSse({
      type: 'mutation-rejected',
      mutationId,
      mutation: pending.mutation,
    });

    return pending;
  }

  /**
   * Get all pending mutations.
   */
  getPending(): PendingMutation[] {
    return Array.from(this.pendingMutations.values());
  }

  /**
   * Get CERA status.
   */
  getStatus(): CeraStatus {
    return {
      connected: this.eventBus !== null || this.engine !== null,
      pendingMutations: this.pendingMutations.size,
      totalGraduated:
        this.acceptedMutations.length + this.pendingMutations.size,
      totalRejected: this.rejectedMutations.length,
      totalAccepted: this.acceptedMutations.length,
      voidMapDensity: this.engine?.getVoidMapDensity() ?? {
        rounds: 0,
        entropy: 0,
        complementWeights: {},
      },
      lastCycle: this.engine?.getHistory(1)[0] ?? null,
    };
  }

  /**
   * Get recent mutation history (accepted + rejected).
   */
  getHistory(limit = 50): PendingMutation[] {
    return [...this.acceptedMutations, ...this.rejectedMutations]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  /**
   * Create an SSE stream for CERA events.
   */
  createSseStream(): ReadableStream {
    const encoder = new TextEncoder();
    let heartbeat: ReturnType<typeof setInterval> | null = null;

    return new ReadableStream({
      start: (controller) => {
        this.sseClients.add(controller);
        controller.enqueue(encoder.encode('data: {"type":"connected"}\n\n'));

        heartbeat = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(': heartbeat\n\n'));
          } catch {
            if (heartbeat) clearInterval(heartbeat);
            this.sseClients.delete(controller);
          }
        }, 15_000);
      },
      cancel: () => {
        if (heartbeat) clearInterval(heartbeat);
      },
    });
  }

  /**
   * Cleanup.
   */
  destroy(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  // ── Private ──────────────────────────────────────────────

  private handleEvent(event: ExtendedForgoEvent): void {
    if (event.type === 'cera-graduation' && event.details) {
      const mutation = event.details as unknown as CodeMutationOutput;
      this.addPendingMutation(mutation);
    }

    this.broadcastSse({
      type: event.type,
      projectName: event.projectName,
      details: event.details,
    });
  }

  private addPendingMutation(mutation: CodeMutationOutput): void {
    const id = `cera-mut-${this.nextMutationId++}`;
    const pending: PendingMutation = {
      id,
      mutation,
      cycle: this.engine?.getHistory(1)[0] ?? ({} as PerturbationCycle),
      timestamp: Date.now(),
      status: 'pending',
    };

    this.pendingMutations.set(id, pending);

    this.broadcastSse({
      type: 'mutation-pending',
      mutationId: id,
      mutation,
    });
  }

  private broadcastSse(data: Record<string, unknown>): void {
    const encoder = new TextEncoder();
    const payload = encoder.encode(`data: ${JSON.stringify(data)}\n\n`);

    for (const client of this.sseClients) {
      try {
        client.enqueue(payload);
      } catch {
        this.sseClients.delete(client);
      }
    }
  }
}
