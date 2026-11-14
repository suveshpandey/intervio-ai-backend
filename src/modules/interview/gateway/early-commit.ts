/**
 * When may a turn end before Deepgram's slow utterance-end signal?
 *
 * A silence timer alone cannot tell "finished" from "thinking", and a 1-2 s pause
 * mid-answer is normal. So early commit is conservative and learns the speaker:
 *
 *  - the text must look finished (long enough, ends on . ? !);
 *  - it starts with a cautious hold, and only shortens it after we've seen this
 *    candidate's own pauses and they were short;
 *  - a candidate who pauses a lot never gets early commits (they keep the slow,
 *    safe signal), so they are not interrupted.
 */

/** Early commit only for answers of at least this many words. */
export const EARLY_COMMIT_MIN_WORDS = 4;
/** A finished sentence: ends in . ? or ! (smart_format adds the punctuation). */
const SENTENCE_END = /[.?!]["')\]]*$/;
/** Answers we must have heard before trusting what we've learned about their pauses. */
const LEARN_AFTER_TURNS = 2;
/** Safety margin over the longest pause seen mid-answer. */
const PAUSE_MARGIN = 1.4;
/** Past this the speaker pauses too much for early commit to be safe. */
const MAX_SAFE_HOLD_MS = 1700;

export function looksFinished(answer: string): boolean {
  const text = answer.trim();
  return text.split(/\s+/).length >= EARLY_COMMIT_MIN_WORDS && SENTENCE_END.test(text);
}

/**
 * How long to stay quiet before committing early, or 0 for "don't".
 * @param baseMs configured hold used until we know the speaker (0 = feature off)
 * @param turnsSeen answers heard so far in this interview
 * @param maxPauseMs longest silence seen between phrases inside one answer
 */
export function earlyCommitHoldMs(baseMs: number, turnsSeen: number, maxPauseMs: number): number {
  if (baseMs <= 0) return 0;
  if (turnsSeen < LEARN_AFTER_TURNS) return baseMs;
  const needed = Math.round(maxPauseMs * PAUSE_MARGIN);
  if (needed > MAX_SAFE_HOLD_MS) return 0;
  return Math.max(needed, Math.min(800, baseMs));
}
