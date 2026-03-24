/**
 * Observatory History -- Time-Series Persistence
 *
 * The observatory doesn't just snapshot -- it tracks trends over time.
 * Every snapshot is persisted as a JSONL entry. The history IS the void
 * boundary at the system level: the rate of change of steering effectiveness,
 * the derivative of engram accumulation, the convergence velocity.
 *
 * The breeding loop reads this history to decide what to evolve.
 * The observatory observing itself creates a new rejection surface.
 * Void boundaries all the way down.
 *
 * Storage: ~/.edgework/observatory-history.jsonl
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ObservatorySnapshot } from './observatory';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ObservatoryTrend {
  /** Time window label */
  window: '1h' | '6h' | '24h' | '7d';
  /** Void map rejections in this window */
  rejections: number;
  /** Rejections in previous window (for delta) */
  rejectionsPrev: number;
  /** Rejection delta (positive = more rejections) */
  rejectionDelta: number;
  /** Engrams created in this window */
  engramsCreated: number;
  /** Steering effectiveness: did rejections decrease after steering? */
  steeringEffectiveness: number; // 0-1, higher = steering is working
  /** Agent success rate in this window */
  agentSuccessRate: number;
  /** Convergence velocity (delta of convergence estimate) */
  convergenceVelocity: number;
}

export interface SystemVoidBoundary {
  /** Timestamp of this boundary computation */
  timestamp: string;
  /** Trends at multiple time scales */
  trends: ObservatoryTrend[];
  /** Overall system health score (0-1) */
  healthScore: number;
  /** Areas needing improvement (for breeding) */
  weakPoints: Array<{
    area: string;
    score: number;
    suggestion: string;
  }>;
  /** Meta-metric: is the system getting better over time? */
  improvementRate: number; // positive = improving
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EDGEWORK_DIR = join(homedir(), '.edgework');
const HISTORY_FILE = join(EDGEWORK_DIR, 'observatory-history.jsonl');
const MAX_HISTORY_ENTRIES = 10000;

// ---------------------------------------------------------------------------
// History Store
// ---------------------------------------------------------------------------

interface HistoryEntry {
  timestamp: string;
  rejections: number;
  engrams: number;
  agentCompleted: number;
  agentFailed: number;
  steeringActive: boolean;
  convergence: number;
  rejectionsProcessed: number;
}

let history: HistoryEntry[] = [];
let loaded = false;

function loadHistory(): void {
  if (loaded) return;
  loaded = true;

  if (!existsSync(HISTORY_FILE)) return;
  try {
    const lines = readFileSync(HISTORY_FILE, 'utf-8')
      .split('\n')
      .filter((l) => l.trim().length > 0);
    for (const line of lines) {
      try {
        history.push(JSON.parse(line));
      } catch { /* skip malformed */ }
    }
    if (history.length > MAX_HISTORY_ENTRIES) {
      history = history.slice(-MAX_HISTORY_ENTRIES);
    }
  } catch { /* file not ready */ }
}

function persistEntry(entry: HistoryEntry): void {
  try {
    mkdirSync(EDGEWORK_DIR, { recursive: true });
    appendFileSync(HISTORY_FILE, JSON.stringify(entry) + '\n');
  } catch { /* best effort */ }
}

/**
 * Record a snapshot into history.
 */
export function recordSnapshot(snapshot: ObservatorySnapshot): void {
  loadHistory();

  const entry: HistoryEntry = {
    timestamp: snapshot.timestamp,
    rejections: snapshot.voidMap.totalRejections,
    engrams: snapshot.engrams.total,
    agentCompleted: snapshot.agents.completed,
    agentFailed: snapshot.agents.failed,
    steeringActive: snapshot.voidMap.steeringActive,
    convergence: snapshot.phase3.wired ? 1 : 0,
    rejectionsProcessed: snapshot.phase3.rejectionsProcessed,
  };

  history.push(entry);
  if (history.length > MAX_HISTORY_ENTRIES) {
    history = history.slice(-MAX_HISTORY_ENTRIES);
  }
  persistEntry(entry);
}

/**
 * Compute trends at multiple time scales.
 */
export function computeTrends(): ObservatoryTrend[] {
  loadHistory();
  if (history.length < 2) return [];

  const now = Date.now();
  const windows: Array<{ label: '1h' | '6h' | '24h' | '7d'; ms: number }> = [
    { label: '1h', ms: 60 * 60 * 1000 },
    { label: '6h', ms: 6 * 60 * 60 * 1000 },
    { label: '24h', ms: 24 * 60 * 60 * 1000 },
    { label: '7d', ms: 7 * 24 * 60 * 60 * 1000 },
  ];

  return windows.map(({ label, ms }) => {
    const windowStart = new Date(now - ms).toISOString();
    const prevWindowStart = new Date(now - ms * 2).toISOString();

    const inWindow = history.filter((e) => e.timestamp >= windowStart);
    const inPrevWindow = history.filter(
      (e) => e.timestamp >= prevWindowStart && e.timestamp < windowStart
    );

    const rejections = inWindow.length > 0
      ? inWindow[inWindow.length - 1].rejections - (inWindow[0].rejections ?? 0)
      : 0;
    const rejectionsPrev = inPrevWindow.length > 0
      ? inPrevWindow[inPrevWindow.length - 1].rejections - (inPrevWindow[0].rejections ?? 0)
      : 0;

    const engrams = inWindow.length > 0
      ? inWindow[inWindow.length - 1].engrams - (inWindow[0].engrams ?? 0)
      : 0;

    const totalAgents = inWindow.reduce((sum, e) => sum + e.agentCompleted + e.agentFailed, 0);
    const completedAgents = inWindow.reduce((sum, e) => sum + e.agentCompleted, 0);

    // Steering effectiveness: if steering is active and rejections decreased, it's working
    const steeringActive = inWindow.some((e) => e.steeringActive);
    const steeringEffectiveness = steeringActive && rejectionsPrev > 0
      ? Math.max(0, Math.min(1, 1 - rejections / rejectionsPrev))
      : 0;

    return {
      window: label,
      rejections: Math.max(0, rejections),
      rejectionsPrev: Math.max(0, rejectionsPrev),
      rejectionDelta: rejections - rejectionsPrev,
      engramsCreated: Math.max(0, engrams),
      steeringEffectiveness,
      agentSuccessRate: totalAgents > 0 ? completedAgents / totalAgents : 0,
      convergenceVelocity: 0, // Requires federated sync data
    };
  });
}

/**
 * Compute the system-level void boundary.
 * This is the meta-rejection-surface that the breeding loop reads.
 */
export function computeSystemVoidBoundary(): SystemVoidBoundary {
  loadHistory();
  const trends = computeTrends();

  // Health score: weighted average of key metrics
  const trend24h = trends.find((t) => t.window === '24h');
  const healthFactors = [
    trend24h ? trend24h.agentSuccessRate : 0.5,
    trend24h ? trend24h.steeringEffectiveness : 0,
    trend24h && trend24h.rejectionDelta < 0 ? 0.8 : 0.3, // Decreasing rejections = healthy
  ];
  const healthScore = healthFactors.reduce((a, b) => a + b, 0) / healthFactors.length;

  // Weak points for breeding to target
  const weakPoints: SystemVoidBoundary['weakPoints'] = [];

  if (trend24h) {
    if (trend24h.agentSuccessRate < 0.5) {
      weakPoints.push({
        area: 'agent-success',
        score: trend24h.agentSuccessRate,
        suggestion: 'Agent topologies need restructuring for higher success rates',
      });
    }
    if (trend24h.steeringEffectiveness < 0.3 && trend24h.rejections > 5) {
      weakPoints.push({
        area: 'steering-effectiveness',
        score: trend24h.steeringEffectiveness,
        suggestion: 'Steering vectors not reducing rejections -- refine category detection',
      });
    }
    if (trend24h.rejectionDelta > 0) {
      weakPoints.push({
        area: 'rejection-growth',
        score: Math.max(0, 1 - trend24h.rejectionDelta / 10),
        suggestion: 'Rejections increasing -- model suggestions misaligned with developer preferences',
      });
    }
  }

  // Improvement rate: are things getting better over time?
  const trend1h = trends.find((t) => t.window === '1h');
  const improvementRate = trend1h && trend24h
    ? (trend1h.steeringEffectiveness - (trend24h.steeringEffectiveness ?? 0)) +
      (trend1h.agentSuccessRate - (trend24h.agentSuccessRate ?? 0))
    : 0;

  return {
    timestamp: new Date().toISOString(),
    trends,
    healthScore,
    weakPoints,
    improvementRate,
  };
}

/**
 * Get raw history entries.
 */
export function getHistory(limit = 100): HistoryEntry[] {
  loadHistory();
  return history.slice(-limit);
}

/**
 * Get history entry count.
 */
export function getHistorySize(): number {
  loadHistory();
  return history.length;
}
