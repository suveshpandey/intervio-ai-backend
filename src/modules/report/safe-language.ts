/**
 * The report's safe-language gate and its no-LLM fallback prose (PRD §"safe
 * language"): a candidate is never called a liar. Verdicts are "supported /
 * partial / insufficient evidence", never an accusation.
 *
 * Kept free of LLM/config imports so it is pure, testable, and can never be the
 * reason a report fails to render.
 */

import type { ComputedReport } from '@/modules/report/scoring';

/**
 * Words that accuse rather than describe. Matched on whole words so "faking" is
 * caught but "fake news detector" in a quoted answer isn't mangled mid-word.
 */
const BANNED = [
  'lying',
  'lied',
  'liar',
  'lies',
  'fake',
  'faked',
  'faking',
  'fraud',
  'fraudulent',
  'fabricat',
  'dishonest',
  'deceptive',
  'deceit',
  'bullshit',
  'bogus',
  'made it up',
  'making it up',
  'inflated',
  'exaggerat',
];

const BANNED_RE = new RegExp(`\\b(${BANNED.join('|')})`, 'i');

/** @returns the offending word, or null when the text is safe to ship. */
export function findBannedWord(text: string): string | null {
  return BANNED_RE.exec(text)?.[1]?.toLowerCase() ?? null;
}

/**
 * Written from the computed numbers alone — no LLM. Used when the model is
 * unavailable or won't stop accusing. Deliberately plain: it should read as
 * terse, not as broken.
 */
export function fallbackNarrative(report: ComputedReport): string {
  const { stats, readiness } = report;
  const verdict =
    readiness.verdict === 'ready'
      ? 'You held up well in this interview.'
      : readiness.verdict === 'almost'
        ? "You're close, but a few answers didn't hold up."
        : 'This interview showed real gaps.';

  const claims = stats.claimsProbed
    ? `You backed up ${stats.claimsSupported} of the ${stats.claimsProbed} resume claims you were asked about.`
    : 'No resume claims were covered in this interview.';

  const depth = report.dimensions.find((d) => d.key === 'depth')?.score ?? 0;
  const next = report.improvements[0]
    ? `${report.improvements[0].title}: ${report.improvements[0].detail}`
    : 'Keep practising with the claims on your resume.';

  return `${verdict} ${claims} Your answers scored ${depth.toFixed(1)}/10 for technical depth.\n\n${next}`;
}
