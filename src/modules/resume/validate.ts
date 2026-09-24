/**
 * Is this actually a resume?
 *
 * Someone uploading a dinner menu, a screenshot of text, or a page of keyboard
 * mash costs us two LLM calls and produces a "plan" built on nothing — claims
 * invented from noise, an interview that can't probe them, and a report that
 * means nothing. Cheaper and far clearer to say no at the door.
 *
 * PURE and deterministic: no LLM, no cost. The model check that follows it
 * (empty extraction) catches what this can't.
 */

/** Shorter than this is a cover note, a scan with no text layer, or nothing at all. */
const MIN_CHARS = 400;
/** Real resumes carry plenty of distinct vocabulary; mash and repetition do not. */
const MIN_DISTINCT_WORDS = 60;
/** Below this share of letters/digits/punctuation it isn't prose (binary, symbols, art). */
const MIN_READABLE_RATIO = 0.75;
/** A resume mentions at least a couple of these. */
const SECTION_WORDS =
  /\b(experience|education|skills?|projects?|employment|internship|work history|certification|summary|objective|achievements?|responsibilities|bachelor|master|b\.?tech|engineer|developer|university|college)\b/gi;
/** How many of those distinct signals we need. */
const MIN_SIGNALS = 3;

export type ResumeCheck = { ok: true } | { ok: false; reason: string };

/**
 * The message goes straight to the user, so it says what to do next rather than
 * what our checks are — knowing the thresholds only helps someone gaming them.
 */
const REJECTION = "This doesn't look like a resume. Upload your CV as a PDF or DOCX with your experience, skills and projects.";

export function looksLikeResume(text: string): ResumeCheck {
  const trimmed = text.trim();

  if (trimmed.length < MIN_CHARS) {
    return {
      ok: false,
      reason:
        trimmed.length === 0
          ? "We couldn't read any text from this file. If it's a scan or an image, upload a text-based PDF or DOCX instead."
          : REJECTION,
    };
  }

  // Readable prose vs symbol soup.
  const readable = (trimmed.match(/[\p{L}\p{N}\s.,;:'"()\-–—/&@+#%]/gu) ?? []).length;
  if (readable / trimmed.length < MIN_READABLE_RATIO) return { ok: false, reason: REJECTION };

  const words = trimmed.toLowerCase().match(/[\p{L}][\p{L}'-]*/gu) ?? [];
  const distinct = new Set(words);
  if (distinct.size < MIN_DISTINCT_WORDS) return { ok: false, reason: REJECTION };

  // "asdkjfhaskdjfh" — long unbroken runs of letters are mash, not words.
  const longRuns = words.filter((w) => w.length > 24).length;
  if (longRuns > words.length * 0.05) return { ok: false, reason: REJECTION };

  const signals = new Set((trimmed.match(SECTION_WORDS) ?? []).map((s) => s.toLowerCase()));
  if (signals.size < MIN_SIGNALS) return { ok: false, reason: REJECTION };

  return { ok: true };
}

/**
 * The model's turn: a document that passed the text checks but yielded nothing a
 * resume would contain. Usually a real document that simply isn't a CV.
 */
export function extractionIsEmpty(extracted: {
  skills: string[];
  projects: unknown[];
  experience: unknown[];
}): boolean {
  return extracted.skills.length === 0 && extracted.projects.length === 0 && extracted.experience.length === 0;
}

export const NOT_A_RESUME = REJECTION;
