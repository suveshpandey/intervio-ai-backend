/**
 * Topic-change question prefetch (latency).
 *
 * Every MOVE_ON is an engine override, so it used to cost a second LLM call AFTER
 * the answer was scored (~2-2.5s of extra silence, on ~40% of turns). But where
 * "moving on" leads — next claim, next section, next topic — depends only on
 * state we already have when the question is asked. So while the candidate is
 * talking we write that question in the background, and use it only if the
 * engine's real decision is exactly the move we predicted. Follow-ups, probes
 * and difficulty drops never touch it.
 *
 * In-memory on purpose: a miss (restart, second instance) just falls back to the
 * normal call, so there is nothing worth persisting.
 */

import type { Decision } from '@/modules/interview/types';

interface Entry {
  /** turnIdx of the question this was prepared during — stale entries never match. */
  forTurnIdx: number;
  move: Decision;
  question: Promise<string | null>;
  expires: ReturnType<typeof setTimeout>;
}

/** Safety net for abandoned tabs: nothing lives longer than a single turn could. */
const ENTRY_TTL_MS = 15 * 60_000;

const entries = new Map<string, Entry>();

export function storePrefetch(
  interviewId: string,
  forTurnIdx: number,
  move: Decision,
  question: Promise<string | null>,
): void {
  clearPrefetch(interviewId);
  const expires = setTimeout(() => entries.delete(interviewId), ENTRY_TTL_MS);
  expires.unref();
  entries.set(interviewId, { forTurnIdx, move, question, expires });
}

/**
 * The prepared question, if it was made for this turn AND for this exact move.
 * Always consumes the entry — a prefetch is only ever good for one turn.
 * May wait briefly if the answer was very short and the prefetch is still running;
 * that is never slower than starting the call from scratch.
 */
export async function takePrefetch(
  interviewId: string,
  forTurnIdx: number,
  decision: Decision,
): Promise<string | null> {
  const entry = entries.get(interviewId);
  clearPrefetch(interviewId);
  if (!entry || entry.forTurnIdx !== forTurnIdx || !sameMove(entry.move, decision)) return null;
  return entry.question;
}

export function clearPrefetch(interviewId: string): void {
  const entry = entries.get(interviewId);
  if (!entry) return;
  clearTimeout(entry.expires);
  entries.delete(interviewId);
}

/** Same destination = same question is right. */
function sameMove(a: Decision, b: Decision): boolean {
  return (
    a.action === 'MOVE_ON' &&
    b.action === 'MOVE_ON' &&
    !a.finished &&
    !b.finished &&
    a.claimId === b.claimId &&
    a.objective === b.objective &&
    a.gotoSectionIdx === b.gotoSectionIdx
  );
}
