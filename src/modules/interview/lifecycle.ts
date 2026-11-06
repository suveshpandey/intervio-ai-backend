/**
 * Interview lifecycle rules (times in seconds).
 *
 *   planned ──join──► live ──leave──► (rejoin for REJOIN_WINDOW_SEC) ──► abandoned
 *      │                │
 *      │                └── time's up (+ grace) ──► completed
 *      └── not joined within NOT_STARTED_AFTER_SEC ──► not_started
 *
 * The clock starts when the room is first joined, never when the interview is
 * created.
 */

/** An interview nobody joined is closed as "not started" after this long. */
export const NOT_STARTED_AFTER_SEC = 5 * 60;
/** After the connection drops, the candidate can rejoin for this long. */
export const REJOIN_WINDOW_SEC = 10 * 60;
/**
 * Breathing room past the planned duration. The engine ends an interview on the
 * answer AFTER time runs out, so a candidate mid-sentence at the buzzer should
 * finish their thought rather than be cut off by the sweeper.
 */
export const EXPIRY_GRACE_SEC = 90;

interface Timed {
  status: string;
  createdAt: Date;
  startedAt: Date | null;
  lastLeftAt: Date | null;
  durationMin: number;
}

/**
 * When this interview will be closed if the candidate doesn't come back, or null
 * if nothing is counting down (finished, or someone is in the room right now).
 */
export function returnBy(i: Timed): Date | null {
  if (i.status === 'planned') return new Date(i.createdAt.getTime() + NOT_STARTED_AFTER_SEC * 1000);
  if (i.status === 'live' && i.lastLeftAt && i.startedAt) {
    const left = i.lastLeftAt.getTime() + REJOIN_WINDOW_SEC * 1000;
    const timeUp = i.startedAt.getTime() + (i.durationMin * 60 + EXPIRY_GRACE_SEC) * 1000;
    return new Date(Math.min(left, timeUp));
  }
  return null;
}
