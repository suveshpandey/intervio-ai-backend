/**
 * "Sorry, can you repeat that?" — recognising when the candidate is asking ABOUT
 * the question instead of answering it.
 *
 * Two different asks, handled differently:
 *   repeat  — they didn't hear it → say the same question again
 *   clarify — they didn't understand it → say it again in simpler words
 *
 * This is the FAST PATH only: a phrase match, trusted solely on very short
 * replies. "I had to repeat that test three times before it passed" contains
 * "repeat that" but is a real answer — so anything longer than a few words is
 * left to the evaluation model, which reads the whole thing in context (it
 * reports `repeat_request` / `clarify_request` as the answer's issue).
 *
 * PURE: no I/O. The fast path exists so the common case is instant and still
 * works when the model is slow or down.
 */

export type RepeatKind = 'repeat' | 'clarify';

/** A reply longer than this is treated as an attempt at an answer. */
const MAX_WORDS = 8;

/** They didn't catch it. Checked second — "didn't understand" is the stronger signal. */
const REPEAT = [
  /\brepeat\b/,
  /\bsay (that|it|the question) again\b/,
  /\bcome again\b/,
  /\bone more time\b/,
  /\bonce more\b/,
  /\bpardon\b/,
  /\b(didn'?t|did not|couldn'?t|could not|can'?t|cannot) (hear|catch)\b/,
  /\bdidn'?t get (that|you|it)\b/,
  /\bwhat did you (say|ask)\b/,
  /\bmissed (that|it|the question)\b/,
  /\bphir se\b/, // Hindi: "again"
  /^(sorry|what|huh|hm+|eh)\??[.!]?$/, // the whole reply is just "sorry?" / "what?"
];

/** They heard it but don't know what's being asked. */
const CLARIFY = [
  /\b(don'?t|do not|didn'?t|did not) understand\b/,
  /\bnot sure what (you mean|you are asking|you'?re asking)\b/,
  /\bwhat do you mean\b/,
  /\bwhat (exactly )?are you asking\b/,
  /\brephrase\b/,
  /\b(explain|clarify) (the|that|your) question\b/,
  /\bsay it differently\b/,
  /\bin (simpler|other|different) words\b/,
  /\bconfus(ed|ing)\b/,
  /\bsamajh nahi\b/, // Hindi: "didn't understand"
];

export function detectRepeatRequest(answer: string): RepeatKind | null {
  const text = answer.toLowerCase().replace(/[’`]/g, "'").replace(/\s+/g, ' ').trim();
  if (!text) return null;

  const words = text.split(' ').length;
  if (words > MAX_WORDS) return null;

  if (CLARIFY.some((re) => re.test(text))) return 'clarify';
  if (REPEAT.some((re) => re.test(text))) return 'repeat';
  return null;
}
