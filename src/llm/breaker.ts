/**
 * Circuit breaker per model (PRD Phase 6).
 *
 * When euri or a model is properly down, every call still burns its full timeout
 * before falling back — 8s of dead air per turn, on every turn. After a few
 * failures in a row we stop asking for a while and go straight to the fallback,
 * then let one request through to see if it has recovered.
 *
 * Deliberately tiny and in-process: this protects a live interview from a
 * provider outage, it is not a distributed traffic policy.
 */

import { logger } from '@/common/logger';

/** Consecutive failures before we stop calling a model. */
const FAILURE_THRESHOLD = 3;
/** How long to leave it alone before trying again. */
const COOLDOWN_MS = 30_000;

interface BreakerState {
  failures: number;
  openedAt: number | null;
}

const states = new Map<string, BreakerState>();

const stateFor = (model: string): BreakerState =>
  states.get(model) ?? { failures: 0, openedAt: null };

/** Should we skip this model right now? */
export function isOpen(model: string, now = Date.now()): boolean {
  const state = stateFor(model);
  if (state.openedAt === null) return false;

  if (now - state.openedAt >= COOLDOWN_MS) {
    // Half-open: let the next call through. If it fails, recordFailure re-opens.
    states.set(model, { failures: FAILURE_THRESHOLD - 1, openedAt: null });
    logger.info({ model }, 'circuit half-open — trying the primary again');
    return false;
  }
  return true;
}

export function recordSuccess(model: string): void {
  const state = stateFor(model);
  if (state.failures || state.openedAt !== null) {
    logger.info({ model }, 'model recovered — circuit closed');
  }
  states.delete(model);
}

export function recordFailure(model: string, now = Date.now()): void {
  const state = stateFor(model);
  const failures = state.failures + 1;

  if (failures >= FAILURE_THRESHOLD) {
    states.set(model, { failures, openedAt: now });
    logger.warn({ model, failures }, `model failing — skipping it for ${COOLDOWN_MS / 1000}s`);
    return;
  }
  states.set(model, { failures, openedAt: null });
}

/** Tests only. */
export function resetBreakers(): void {
  states.clear();
}
