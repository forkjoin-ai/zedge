/**
 * Inference Quality Observatory
 *
 * Real-time dashboard of the self-improving loop. Makes the invisible visible:
 * - Void map growth (rejections/day, category trends)
 * - Steering effectiveness (did rejections decrease after steering?)
 * - Engram accumulation (memory density per workspace)
 * - Emotion heatmap (file-level emotional state across project)
 * - Agent session timeline (success/failure rates, duration trends)
 * - BuleyeanTrainer complement distribution evolution
 *
 * Single JSON snapshot + SSE stream for live updates.
 */

import { voidMapStore } from './void-map-store.ts';
import { getEngramStore } from './engram-store.ts';
import { getPhase3Status } from './wire-phase3.ts';
import { analyzeCodeEmotion } from './emotion-router.ts';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, relative } from 'node:path';
import { recordSnapshot as persistSnapshot } from './observatory-history.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ObservatorySnapshot {
  timestamp: string;

  /** Void map overview */
  voidMap: {
    totalRejections: number;
    categoryCounts: Record<string, number>;
    recentRejections: number; // last 24h
    steeringActive: boolean;
    topRejectedFiles: Array<{ file: string; count: number }>;
  };

  /** Engram store overview */
  engrams: {
    total: number;
    byType: Record<string, number>;
    recentEngrams: number; // last 24h
  };

  /** Emotion heatmap (sampled files) */
  emotionHeatmap: Array<{
    file: string;
    dominantEmotion: string;
    valence: number;
    arousal: number;
  }>;

  /** Agent session summary */
  agents: {
    totalSessions: number;
    completed: number;
    failed: number;
    avgDurationMs: number;
  };

  /** Phase 3 wiring health */
  phase3: {
    wired: boolean;
    trainerActive: boolean;
    rejectionsProcessed: number;
  };

  /** System health */
  health: {
    companionUptime: number;
    peersConnected: number;
    mcpToolCount: number;
  };
}

// ---------------------------------------------------------------------------
// SSE
// ---------------------------------------------------------------------------

const observatoryClients = new Set<ReadableStreamDefaultController>();
const startTime = Date.now();

/**
 * Handles the zedge broadcast Observatory Event workflow.
 */
export function broadcastObservatoryEvent(
  event: Record<string, unknown>
): void {
  const encoder = new TextEncoder();
  const payload = encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
  for (const client of observatoryClients) {
    try {
      client.enqueue(payload);
    } catch {
      observatoryClients.delete(client);
    }
  }
}

/**
 * Creates the Observatory Stream.
 */
export function createObservatoryStream(): ReadableStream {
  const encoder = new TextEncoder();
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  return new ReadableStream({
    start(controller) {
      observatoryClients.add(controller);

      // Send initial snapshot
      getObservatorySnapshot().then((snapshot) => {
        try {
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: 'snapshot', ...snapshot })}\n\n`
            )
          );
        } catch {
          /* client disconnected */
        }
      });

      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': heartbeat\n\n'));
        } catch {
          if (heartbeat) clearInterval(heartbeat);
          observatoryClients.delete(controller);
        }
      }, 15_000);

      // Periodic snapshots every 30s
      const snapshotInterval = setInterval(() => {
        getObservatorySnapshot().then((snapshot) => {
          try {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ type: 'snapshot', ...snapshot })}\n\n`
              )
            );
          } catch {
            clearInterval(snapshotInterval);
          }
        });
      }, 30_000);
    },
    cancel() {
      if (heartbeat) clearInterval(heartbeat);
    },
  });
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

/**
 * Build a complete observatory snapshot.
 */
export async function getObservatorySnapshot(): Promise<ObservatorySnapshot> {
  const now = new Date();
  const twentyFourHoursAgo = new Date(
    now.getTime() - 24 * 60 * 60 * 1000
  ).toISOString();

  // Void map
  const voidStatus = voidMapStore.getStatus();
  const recentVoidEntries = voidMapStore
    .query({ limit: 1000 })
    .filter((e) => e.timestamp > twentyFourHoursAgo);
  const categoryCounts: Record<string, number> = {};
  for (const { category, count } of voidStatus.topCategories) {
    categoryCounts[category] = count;
  }

  const steering = voidMapStore.getSteeringVector();

  // Engrams
  const engramStore = getEngramStore();
  const engramStatus = engramStore.getStatus();
  const recentEngrams = engramStore
    .getAll()
    .filter((e) => e.createdAt > twentyFourHoursAgo).length;

  // Emotion heatmap (sample source files from workspace)
  const emotionHeatmap = sampleEmotionHeatmap();

  // Agent sessions
  const agentStats = {
    totalSessions: 0,
    completed: 0,
    failed: 0,
    avgDurationMs: 0,
  };
  try {
    const { listSessions } = await import('./cloud-agent-session.ts');
    const sessions = listSessions(100);
    agentStats.totalSessions = sessions.length;
    agentStats.completed = sessions.filter(
      (s) => s.status === 'completed'
    ).length;
    agentStats.failed = sessions.filter((s) => s.status === 'failed').length;
    const durations = sessions
      .filter((s) => s.completedAt)
      .map((s) => (s.completedAt ?? s.startedAt) - s.startedAt);
    agentStats.avgDurationMs =
      durations.length > 0
        ? durations.reduce((a, b) => a + b, 0) / durations.length
        : 0;
  } catch {
    /* cloud-agent-session may not be loaded */
  }

  // Phase 3
  const phase3 = getPhase3Status();

  // Peer count
  let peersConnected = 0;
  try {
    const { getMeshStatus } = await import('./p2p-mesh.ts');
    peersConnected = getMeshStatus().peers.length;
  } catch {
    /* mesh may not be running */
  }

  // Auto-persist snapshot to history for trend analysis
  const snapshot = {
    timestamp: now.toISOString(),
    voidMap: {
      totalRejections: voidStatus.totalEntries,
      categoryCounts,
      recentRejections: recentVoidEntries.length,
      steeringActive: steering.negativePrompt.length > 0,
      topRejectedFiles: voidStatus.topFiles
        .slice(0, 5)
        .map((f) => ({ file: f.filePath, count: f.count })),
    },
    engrams: {
      total: engramStatus.totalEngrams,
      byType: engramStatus.byType,
      recentEngrams,
    },
    emotionHeatmap,
    agents: agentStats,
    phase3: {
      wired: phase3.wired,
      trainerActive: phase3.buleyeanTrainerActive,
      rejectionsProcessed: phase3.totalRejectionsProcessed,
    },
    health: {
      companionUptime: Date.now() - startTime,
      peersConnected,
      mcpToolCount: 30,
    },
  };

  try {
    persistSnapshot(snapshot);
  } catch {
    // History persistence is best-effort
  }

  return snapshot;
}

// ---------------------------------------------------------------------------
// Emotion Heatmap Sampler
// ---------------------------------------------------------------------------

const SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.py',
  '.rs',
  '.go',
  '.gg',
]);
const IGNORED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  'coverage',
]);

function sampleEmotionHeatmap(
  maxFiles = 20
): ObservatorySnapshot['emotionHeatmap'] {
  const workspacePath = process.env.AEON_ROOT || process.cwd();
  const results: ObservatorySnapshot['emotionHeatmap'] = [];

  try {
    walkForHeatmap(workspacePath, workspacePath, results, maxFiles, 0);
  } catch {
    // Best effort
  }

  return results;
}

function walkForHeatmap(
  dir: string,
  root: string,
  results: ObservatorySnapshot['emotionHeatmap'],
  maxFiles: number,
  depth: number
): void {
  if (depth > 4 || results.length >= maxFiles) return;

  try {
    const entries = readdirSync(dir);
    for (const entry of entries) {
      if (results.length >= maxFiles) break;
      if (IGNORED_DIRS.has(entry)) continue;

      const fullPath = join(dir, entry);
      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          walkForHeatmap(fullPath, root, results, maxFiles, depth + 1);
        } else if (
          SOURCE_EXTENSIONS.has(extname(entry)) &&
          stat.size < 50_000
        ) {
          const content = readFileSync(fullPath, 'utf-8');
          const profile = analyzeCodeEmotion(content);
          if (profile.dominantEmotion !== 'neutral') {
            results.push({
              file: relative(root, fullPath),
              dominantEmotion: profile.dominantEmotion,
              valence: profile.avgValence,
              arousal: profile.avgArousal,
            });
          }
        }
      } catch {
        // Skip unreadable entries
      }
    }
  } catch {
    // Skip unreadable directories
  }
}
