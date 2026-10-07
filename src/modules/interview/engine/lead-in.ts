/**
 * The bare question, without the conversational opener in front of it.
 *
 * A question is spoken exactly as the model wrote it, and its opener usually
 * belongs there: "Thanks — so how did you measure that?" reacts to what the
 * candidate just said. But on a REPEAT that reaction is stale; "Sure — thanks,
 * so how did you…" sounds broken. So the opener is removed only when the
 * question is said again.
 *
 * PURE. Errs on the side of leaving text alone: a short question is never
 * reduced to a fragment.
 */

/** One opener at a time, at the very start, with its trailing punctuation. */
const OPENER = new RegExp(
  '^\\s*(' +
    [
      'thank you( (so|very) much)?( for (that|sharing|explaining)[^,.!—:;-]*)?',
      'thanks( (a lot|for (that|sharing|explaining)[^,.!—:;-]*))?',
      'ok(ay)?',
      'alright',
      'all right',
      'got it',
      'great',
      'nice',
      'perfect',
      'cool',
      'sure',
      'understood',
      'makes sense',
      'that makes sense',
      'no worries( at all)?',
      'no problem',
      'interesting',
      'good( point)?',
      'fair enough',
      'right',
      // "That sounds interesting, but …" / "That's impressive — …"
      "that('?s| is| sounds)( really| very| quite)? (great|interesting|good|impressive|solid|helpful|clear|fair)",
      // Our own clarify lead-ins, so a second repeat of a reworded question is clean too.
      'let me put it differently',
      'let( us|\'s) keep it simple',
    ].join('|') +
    ')\\s*[,.!—–:;-]+\\s*',
  'i',
);

/** Joining words left dangling once an opener is gone: "…, but how did you". */
const CONNECTOR = /^\s*(but|so|and|now)\b[,\s]*/i;

/** Below this many words, assume we cut too much and keep the original. */
const MIN_WORDS = 4;

export function stripLeadIn(question: string): string {
  let text = question.trim();

  // Repeatedly: "Okay, thanks. Got it — so …" has several in a row.
  for (let i = 0; i < 4; i++) {
    const next = text.replace(OPENER, '');
    if (next === text) break;
    text = next.replace(CONNECTOR, '');
  }

  if (text.split(/\s+/).filter(Boolean).length < MIN_WORDS) return question.trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}
