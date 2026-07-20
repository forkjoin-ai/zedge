/**
 * Zedge Compute Pool Node
 *
 * Joins the distributed inference mesh via DistributedClient WASM bridge.
 * Earns Edgework tokens by serving inference requests from the mesh.
 *
 * Integrates with:
 * - distributed-bridge.ts (WASM DistributedClient or HTTP fallback)
 * - p2p-mesh.ts (LAN peer discovery)
 * - billing headers (X-Edgework-Debt-Mode, X-Edgework-Debt-Max)
 */

import {
  getZedgeConfig,
  getEdgeworkConfig,
  saveZedgeConfig,
  getApiKey,
} from './config.ts';
import {
  connectToMesh,
  disconnectFromMesh,
  getMeshNodes,
  getBridgeStatus,
} from './distributed-bridge.ts';
import type { DistributedConfig } from './distributed-bridge.ts';

export interface ComputePoolStatus {
  joined: boolean;
  tokensEarned: number;
  requestsServed: number;
  connectedNodes: number;
  uptime: number;
  wasmBridgeAvailable: boolean;
  config: {
    maxCpuPercent: number;
    maxMemoryMb: number;
    allowedModels: string[];
  };
  billing: {
    debtMode: string;
    debtMax: number;
    currentDebt: number;
  };
}

let poolState: {
  joined: boolean;
  tokensEarned: number;
  requestsServed: number;
  connectedNodes: number;
  startTime: number | null;
  currentDebt: number;
} = {
  joined: false,
  tokensEarned: 0,
  requestsServed: 0,
  connectedNodes: 0,
  startTime: null,
  currentDebt: 0,
};

/**
 * Get billing headers for mesh requests
 * Implements the BillingDaemon debt policy from the edge inference ebook
 */
export function getBillingHeaders(): Record<string, string> {
  const isPremium = !!getApiKey();
  return {
    'X-Edgework-Debt-Mode': isPremium ? 'premium' : 'free',
    'X-Edgework-Debt-Max': isPremium ? '5' : '0',
  };
}

/**
 * Join the distributed inference mesh
 *
 * Connects via DistributedClient WASM bridge if available,
 * falls back to HTTP mesh endpoint, then P2P discovery.
 */
export async function joinPool(): Promise<ComputePoolStatus> {
  if (poolState.joined) {
    return getPoolStatus();
  }

  const config = getZedgeConfig();
  const edgeworkConfig = getEdgeworkConfig();

  // Build distributed config for the WASM bridge
  const distributedConfig: DistributedConfig = {
    meshEndpoint: edgeworkConfig.apiBaseUrl,
    maxNodes: 50,
    timeoutMs: 10_000,
    retryCount: 3,
    enableFallback: true,
  };

  // Connect to mesh via WASM bridge or HTTP fallback
  const result = await connectToMesh(distributedConfig);

  poolState = {
    joined: true,
    tokensEarned: poolState.tokensEarned,
    requestsServed: poolState.requestsServed,
    connectedNodes: Math.max(1, result.nodeCount),
    startTime: Date.now(),
    currentDebt: 0,
  };

  // Persist preference
  saveZedgeConfig({
    computePool: { ...config.computePool, enabled: true },
  });

  const bridge = getBridgeStatus();
  console.log(
    `[zedge] Joined compute pool — WASM bridge: ${
      bridge.wasmAvailable ? 'yes' : 'no'
    }, ` +
      `nodes: ${result.nodeCount}, max CPU: ${config.computePool.maxCpuPercent}%, ` +
      `max memory: ${config.computePool.maxMemoryMb}MB`
  );

  return getPoolStatus();
}

/**
 * Leave the distributed inference mesh
 */
export async function leavePool(): Promise<ComputePoolStatus> {
  if (!poolState.joined) {
    return getPoolStatus();
  }

  const config = getZedgeConfig();

  // Disconnect from mesh
  disconnectFromMesh();

  poolState = {
    ...poolState,
    joined: false,
    connectedNodes: 0,
    startTime: null,
  };

  saveZedgeConfig({
    computePool: { ...config.computePool, enabled: false },
  });

  // console.log('[zedge] Left compute pool');
  return getPoolStatus();
}

/**
 * Get current pool status
 */
export function getPoolStatus(): ComputePoolStatus {
  const config = getZedgeConfig();
  const bridge = getBridgeStatus();

  // Update connected nodes from mesh
  if (poolState.joined) {
    const meshNodes = getMeshNodes();
    if (meshNodes.length > 0) {
      poolState.connectedNodes = meshNodes.length + 1; // +1 for self
    }
  }

  return {
    joined: poolState.joined,
    tokensEarned: poolState.tokensEarned,
    requestsServed: poolState.requestsServed,
    connectedNodes: poolState.connectedNodes,
    uptime: poolState.startTime ? Date.now() - poolState.startTime : 0,
    wasmBridgeAvailable: bridge.wasmAvailable,
    config: {
      maxCpuPercent: config.computePool.maxCpuPercent,
      maxMemoryMb: config.computePool.maxMemoryMb,
      allowedModels: config.computePool.allowedModels,
    },
    billing: {
      debtMode: getApiKey() ? 'premium' : 'free',
      debtMax: getApiKey() ? 5 : 0,
      currentDebt: poolState.currentDebt,
    },
  };
}

/**
 * Record a served inference request (called by mesh when this node handles work)
 */
export function recordServedRequest(tokensProcessed: number): void {
  poolState.requestsServed += 1;
  // 1000 tokens processed = 1 credit
  poolState.tokensEarned += tokensProcessed / 1000;
}

/**
 * Record inference debt (called when this node consumes inference)
 */
export function recordDebt(amount: number): void {
  poolState.currentDebt += amount;
}

// ---------------------------------------------------------------------------
// Compute Market 2.0 (Phase 8) — Token Economics & Dashboard
// ---------------------------------------------------------------------------

export interface ComputeMarketStatus {
  /** Current clearing price (tokens per 1000 inference tokens) */
  clearingPrice: number;
  /** Supply/demand ratio (>1 = surplus, <1 = deficit) */
  supplyDemandRatio: number;
  /** This node's contribution stats */
  contributor: ContributorStats;
  /** Debt ledger */
  debtLedger: DebtLedger;
}

export interface ContributorStats {
  totalTokensEarned: number;
  totalRequestsServed: number;
  uptimeHours: number;
  modelsHosted: string[];
  averageLatencyMs: number;
  peakRequestsPerMinute: number;
}

export interface DebtLedger {
  tier: 'free' | 'premium' | 'ultra';
  debtMax: number;
  currentDebt: number;
  lifetimeSpent: number;
  lifetimeEarned: number;
  netBalance: number;
}

const DEBT_TIERS: Record<string, { maxDebt: number }> = {
  free: { maxDebt: 0 },
  premium: { maxDebt: 5 },
  ultra: { maxDebt: 20 },
};

const marketState = {
  clearingPrice: 1.0,
  supplyDemandRatio: 1.0,
  peakRpm: 0,
  totalLatencyMs: 0,
  latencySamples: 0,
  lifetimeSpent: 0,
};

/**
 * Record a metered inference operation for billing.
 */
export function recordMeteredOperation(
  tokensProcessed: number,
  latencyMs: number,
  isEarning: boolean
): void {
  if (isEarning) {
    recordServedRequest(tokensProcessed);
  } else {
    const cost = (tokensProcessed / 1000) * marketState.clearingPrice;
    poolState.currentDebt += cost;
    marketState.lifetimeSpent += cost;
  }

  marketState.totalLatencyMs += latencyMs;
  marketState.latencySamples++;
}

/**
 * Update market clearing price based on supply/demand.
 * Called periodically by the mesh.
 */
export function updateMarketPrice(
  totalSupplyNodes: number,
  totalDemandRequests: number
): void {
  const ratio =
    totalSupplyNodes > 0 ? totalDemandRequests / totalSupplyNodes : 1;

  marketState.supplyDemandRatio = ratio;

  // Price adjusts based on demand: more demand = higher price
  // Base price 1.0, scales with demand ratio
  marketState.clearingPrice = Math.max(0.1, Math.min(10, ratio));
}

/**
 * Get compute market dashboard data.
 */
export function getMarketStatus(): ComputeMarketStatus {
  const config = getZedgeConfig();
  const tier = getApiKey() ? 'premium' : 'free';
  const tierConfig = DEBT_TIERS[tier] ?? DEBT_TIERS['free']!;

  return {
    clearingPrice: marketState.clearingPrice,
    supplyDemandRatio: marketState.supplyDemandRatio,
    contributor: {
      totalTokensEarned: poolState.tokensEarned,
      totalRequestsServed: poolState.requestsServed,
      uptimeHours: poolState.startTime
        ? (Date.now() - poolState.startTime) / 3_600_000
        : 0,
      modelsHosted: config.computePool.allowedModels,
      averageLatencyMs:
        marketState.latencySamples > 0
          ? marketState.totalLatencyMs / marketState.latencySamples
          : 0,
      peakRequestsPerMinute: marketState.peakRpm,
    },
    debtLedger: {
      tier: tier as DebtLedger['tier'],
      debtMax: tierConfig.maxDebt,
      currentDebt: poolState.currentDebt,
      lifetimeSpent: marketState.lifetimeSpent,
      lifetimeEarned: poolState.tokensEarned,
      netBalance: poolState.tokensEarned - marketState.lifetimeSpent,
    },
  };
}
