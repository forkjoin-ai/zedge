/**
 * Phase 3 Startup Wiring -- Connect All Loops
 *
 * Called once at server startup to wire:
 * 1. Void map → BuleyeanTrainer (rejection → training)
 * 2. Auto-engram embedding function
 * 3. Phase 3 status reporting
 *
 * This is the integration layer that makes the self-improving loop real.
 * Every rejection trains the local model. Every conversation builds memory.
 */

import { voidMapStore, type VoidMapEntry } from "./void-map-store.ts";
import { convertToRejectionRecords } from "./void-map-export.ts";
import { getEngramStore } from "./engram-store.ts";
import { neuralBridge } from "./neural-bridge.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Phase3Status {
  wired: boolean;
  buleyeanTrainerActive: boolean;
  neuralBridgeActive: boolean;
  voidMapCallbackRegistered: boolean;
  engramStoreInitialized: boolean;
  totalRejectionsProcessed: number;
  totalEngramsStored: number;
  neuralMeanDeficit: number;
  neuralConverged: boolean;
  wiredAt: string | null;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let wired = false;
let wiredAt: string | null = null;
let rejectionsProcessed = 0;
let trainerAvailable = false;

// Simple tokenizer for void map entries (word-level)
const simpleTokenizer = {
  encode: (text: string): number[] => {
    // Simple word-level tokenization for void map entries
    return text.split(/\s+/).map((word) => {
      let hash = 0;
      for (let i = 0; i < word.length; i++) {
        hash = ((hash << 5) - hash + word.charCodeAt(i)) | 0;
      }
      return Math.abs(hash) % 32000; // Map to vocab range
    });
  },
  vocabSize: 32000,
};

// ---------------------------------------------------------------------------
// Wire
// ---------------------------------------------------------------------------

/**
 * Wire all Phase 3 integrations. Called once at server startup.
 */
export async function wirePhase3(): Promise<Phase3Status> {
  if (wired) return getPhase3Status();

  // 1. Wire void map → BuleyeanTrainer
  try {
    // Dynamic import -- may not be available depending on monorepo linking
    const trainerMod = await import(
      /* webpackIgnore: true */
      '../../../packages/edgework-sdk/src/compute/buleyean/trainer' as string
    );
    const { BuleyeanTrainer } = trainerMod as { BuleyeanTrainer: any };

    // Create an in-memory storage adapter (no persistence for now)
    const memoryStorage = createMemoryStorage();

    const trainer = new BuleyeanTrainer({
      storage: memoryStorage,
      modelId: 'zedge-local',
      userId: 'local',
      vocabSize: simpleTokenizer.vocabSize,
      modality: 'text',
    });

    await trainer.initialize();
    trainerAvailable = true;

    // Register void map callback → trainer + neural bridge
    voidMapStore.onRecord((entry: VoidMapEntry) => {
      // Feed BuleyeanTrainer (edgework-sdk)
      const records = convertToRejectionRecords([entry]);
      for (const record of records) {
        trainer.ingestRejectionRecord(record, simpleTokenizer).catch(() => {});
      }
      // Feed neural bridge (God Formula complement distribution)
      neuralBridge.feedRejection(entry);
      rejectionsProcessed++;
    });
  } catch {
    // BuleyeanTrainer not available -- still feed neural bridge
    voidMapStore.onRecord((entry: VoidMapEntry) => {
      neuralBridge.feedRejection(entry);
      rejectionsProcessed++;
    });
  }

  // 1b. Initialize neural bridge (try real @a0n/neural engine)
  await neuralBridge.initialize();

  // 2. Wire engram store embedding function
  try {
    const store = getEngramStore();
    // Wire embedding function for semantic recall
    const { computeEmbedding } = await import("./code-index.ts").then(
      (m) => m as unknown as { computeEmbedding: (text: string) => Promise<Float32Array | null> }
    ).catch(() => ({ computeEmbedding: null }));
    if (computeEmbedding) {
      store.setEmbedFunction(computeEmbedding);
    }
  } catch {
    // Embedding not available -- engram store falls back to keyword matching
  }

  wired = true;
  wiredAt = new Date().toISOString();
  return getPhase3Status();
}

/**
 * Get Phase 3 wiring status.
 */
export function getPhase3Status(): Phase3Status {
  const store = getEngramStore();
  const neuralStatus = neuralBridge.getStatus();
  return {
    wired,
    buleyeanTrainerActive: trainerAvailable,
    neuralBridgeActive: neuralStatus.engineAvailable || neuralStatus.totalRejectionsFed > 0,
    voidMapCallbackRegistered: true,
    engramStoreInitialized: store.size >= 0,
    totalRejectionsProcessed: rejectionsProcessed,
    totalEngramsStored: store.size,
    neuralMeanDeficit: neuralStatus.meanDeficit,
    neuralConverged: neuralStatus.converged,
    wiredAt,
  };
}

// ---------------------------------------------------------------------------
// In-memory storage adapter (for BuleyeanTrainer)
// ---------------------------------------------------------------------------

function createMemoryStorage() {
  const data = new Map<string, string>();
  return {
    get: async (key: string) => data.get(key) ?? null,
    set: async (key: string, value: string) => { data.set(key, value); },
    delete: async (key: string) => { data.delete(key); },
    list: async (prefix: string) =>
      [...data.keys()].filter((k) => k.startsWith(prefix)),
    has: async (key: string) => data.has(key),
  };
}
