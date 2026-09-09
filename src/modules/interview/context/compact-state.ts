/**
 * Layer 2 of the context model (PRD §8.5): the small slice we send the LLM each turn.
 *
 * What is deliberately NOT here: the full transcript, the resume, the JD, every past
 * turn. Everything needed from the resume/JD was baked into the blueprint at plan time.
 * This keeps per-turn tokens FLAT instead of growing with the conversation.
 */

import type { InterviewState } from '@/modules/interview/types';
import type { PlanSection } from '@/modules/planner/schema';

/** Verbatim history window — coherence without the transcript. */
const LAST_TURNS = 2;
/** Enough recent questions for the model to avoid repeating itself. */
const RECENT_QUESTIONS = 4;
/** "Story so far" cap. */
const SUMMARY_LINES = 4;

export interface CompactStateInput {
  state: InterviewState;
  blueprint: {
    role: string;
    level: string;
    difficulty: string;
    durationMin: number;
    sections: PlanSection[];
  };
  /** Text of the claim currently under test, if any. */
  claimText: string | null;
  /** Skills tied to the current claim — used to send ONLY relevant scores. */
  claimSkills: string[];
}

const mins = (sec: number) => Math.max(0, Math.round(sec / 60));

export function buildCompactState({
  state,
  blueprint,
  claimText,
  claimSkills,
}: CompactStateInput): string {
  const section = blueprint.sections[state.sectionIdx];
  const sectionLeft = section ? section.budgetMin * 60 - state.sectionElapsedSec : 0;
  const totalLeft = blueprint.durationMin * 60 - state.totalElapsedSec;

  const lines: string[] = [
    `ROLE: ${blueprint.role} (${blueprint.level}) · difficulty: ${state.difficulty}`,
    `SECTION: ${section?.title ?? 'unknown'} — ${mins(sectionLeft)}m left of ${section?.budgetMin ?? 0}m · ${mins(totalLeft)}m left overall`,
    `OBJECTIVE: ${state.currentObjective || 'Open the section'}`,
  ];

  // The claim under test + what still isn't substantiated.
  if (claimText && state.currentClaimId) {
    const p = state.claims[state.currentClaimId];
    lines.push('', `CLAIM UNDER TEST: "${claimText}"`);
    if (p) {
      lines.push(`  status: ${p.status} · confidence ${p.confidence.toFixed(2)} · turns spent ${p.turnsSpent}`);
      if (p.openGaps.length) lines.push(`  open gaps: ${p.openGaps.join('; ')}`);
    }
  }

  // Only the skill scores relevant to this topic (PRD cost optimisation #5).
  const relevant = claimSkills
    .map((s) => [s, state.skills[s]] as const)
    .filter(([, v]) => v !== undefined)
    .map(([s, v]) => `${s} ${v!.score.toFixed(2)} (${v!.samples})`);
  if (relevant.length) lines.push('', `RELEVANT SKILLS: ${relevant.join(', ')}`);

  const recent = state.askedQuestions.slice(-RECENT_QUESTIONS);
  if (recent.length) {
    lines.push('', 'ALREADY ASKED (do not repeat):');
    for (const q of recent) lines.push(`- ${q}`);
  }

  const summary = state.rollingSummary.slice(-SUMMARY_LINES);
  if (summary.length) {
    lines.push('', 'STORY SO FAR:');
    for (const s of summary) lines.push(`- ${s}`);
  }

  const turns = state.lastTurns.slice(-LAST_TURNS);
  if (turns.length) {
    lines.push('', 'LAST EXCHANGE(S):');
    for (const t of turns) {
      lines.push(`Q: ${t.question}`, `A: ${t.answer}`);
    }
  }

  return lines.join('\n');
}
