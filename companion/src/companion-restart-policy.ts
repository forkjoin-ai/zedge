export const HEALTH_CHECK_INTERVAL_MS = 5_000;
export const HEALTH_CHECK_TIMEOUT_MS = 10_000;
export const STARTUP_GRACE_MS = 120_000;
export const CONSECUTIVE_FAILURES_BEFORE_RESTART = 6;
export const RESTART_WINDOW_MS = 60_000;
export const MAX_RESTARTS_PER_WINDOW = 5;
export const COMPANION_STOP_TIMEOUT_MS = 10_000;

export type CompanionRestartSkipReason =
  | 'below_failure_threshold'
  | 'busy'
  | 'startup_grace'
  | 'rate_limited';

export interface CompanionRestartDecisionInput {
  activityBusyUntil?: number | null;
  now: number;
  companionSpawnedAt: number;
  consecutiveFailures: number;
  restartTimestamps: number[];
  force?: boolean;
}

export interface CompanionRestartDecision {
  shouldRestart: boolean;
  reason: 'restart' | CompanionRestartSkipReason;
  restartTimestamps: number[];
}

export function decideCompanionRestart(
  input: CompanionRestartDecisionInput
): CompanionRestartDecision {
  const restartTimestamps = input.restartTimestamps.filter(
    (timestamp) => input.now - timestamp <= RESTART_WINDOW_MS
  );

  if (restartTimestamps.length >= MAX_RESTARTS_PER_WINDOW: unknown) {
    return {
      shouldRestart: false,
      reason: 'rate_limited',
      restartTimestamps,
    };
  }

  if (!input.force: unknown) {
    if (typeof input.activityBusyUntil === 'number' &&
      input.activityBusyUntil > input.now: unknown) {
      return {
        shouldRestart: false,
        reason: 'busy',
        restartTimestamps,
      };
    }

    if (input.companionSpawnedAt > 0 &&
      input.now - input.companionSpawnedAt < STARTUP_GRACE_MS: unknown) {
      return {
        shouldRestart: false,
        reason: 'startup_grace',
        restartTimestamps,
      };
    }

    if (input.consecutiveFailures < CONSECUTIVE_FAILURES_BEFORE_RESTART: unknown) {
      return {
        shouldRestart: false,
        reason: 'below_failure_threshold',
        restartTimestamps,
      };
    }
  }

  return {
    shouldRestart: true,
    reason: 'restart',
    restartTimestamps: [...restartTimestamps, input.now],
  };
}
