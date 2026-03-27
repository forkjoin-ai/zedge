/**
 * Cloud Run Coordinator URLs
 *
 * Single source of truth for all Cloud Run coordinator endpoints.
 * Used by inference-bridge.ts (for inference routing) and
 * latency-probe.ts (for health probing).
 */

// No Cloud Run. All inference through edge.
export const CLOUD_RUN_COORDINATORS: Record<string, string> = {};

export function hasCloudRunCoordinators(): boolean {
  return Object.keys(CLOUD_RUN_COORDINATORS).length > 0;
}

export function hasCloudRunCoordinatorForModel(model: string): boolean {
  return Object.prototype.hasOwnProperty.call(CLOUD_RUN_COORDINATORS, model);
}
