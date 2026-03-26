/**
 * Cloud Run Coordinator URLs
 *
 * Single source of truth for all Cloud Run coordinator endpoints.
 * Used by inference-bridge.ts (for inference routing) and
 * latency-probe.ts (for health probing).
 */

// No Cloud Run. All inference through edge.
export const CLOUD_RUN_COORDINATORS: Record<string, string> = {};
