/**
 * The deterministic brain (PRD §7).
 *
 * Every function here is PURE — no DB, no Redis, no LLM. The engine takes the
 * LLM's *suggestion* and applies hard guardrails to pick the REAL next move.
 * If these rules are right, the interview is predictable and debuggable.
 */

import type {
  Action,
  Decision,
  Difficulty,
  EvalResult,
  InterviewState,
  ClaimVerdict,
} from '@/modules/interview/types';
import type { PlanSection } from '@/modules/planner/schema';

/**
 * Never dig more than this many times on one topic.
 * 2 → at most 3 turns per claim (question + 2 follow-ups), which keeps a ~9 min
 * claim-verification section wide enough to cover all 5–8 planned claims.
 */
export const MAX_FOLLOW_UPS = 2;
/** Two weak answers in a row → make it easier. */
export const WEAK_STREAK_LIMIT = 2;
/** answerQuality below this counts as "weak". */
export const WEAK_QUALITY = 0.45;

const DIFFICULTY_ORDER: Difficulty[] = ['easy', 'standard', 'hard'];
/** Actions that mean "keep working the current topic". */
const DIGGING: ReadonlySet<Action> = new Set(['PROBE', 'FOLLOW_UP', 'CHALLENGE', 'CLARIFY']);

export function isWeak(e: EvalResult): boolean {
  return e.answerQuality < WEAK_QUALITY || e.issue === 'no_answer';
}

export function stepDifficulty(d: Difficulty, dir: 'down' | 'up'): Difficulty {
  const i = DIFFICULTY_ORDER.indexOf(d);
  const next = dir === 'down' ? i - 1 : i + 1;
  return DIFFICULTY_ORDER[Math.max(0, Math.min(DIFFICULTY_ORDER.length - 1, next))]!;
}

/** Turn accumulated confidence into the claim's final band (PRD safe language). */
export function verdictFor(confidence: number, turnsSpent: number): ClaimVerdict {
  if (turnsSpent === 0) return 'insufficient';
  if (confidence >= 0.7) return 'verified';
  if (confidence >= 0.4) return 'partial';
  return 'insufficient';
}

/** Next claim to probe: first one we haven't opened yet, in planner order. */
export function pickNextClaim(state: InterviewState, probeClaimIds: string[]): string | null {
  for (const id of probeClaimIds) {
    const p = state.claims[id];
    if (!p || p.status === 'pending') return id;
  }
  return null;
}

/** Questions must never repeat. Compare loosely so near-identical phrasing is caught. */
export function isRepeat(question: string, asked: string[]): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const q = norm(question);
  return asked.some((a) => norm(a) === q);
}

export function sectionBudgetExceeded(state: InterviewState, sections: PlanSection[]): boolean {
  const section = sections[state.sectionIdx];
  if (!section) return true;
  return state.sectionElapsedSec >= section.budgetMin * 60;
}

export function totalBudgetExceeded(state: InterviewState, durationMin: number): boolean {
  return state.totalElapsedSec >= durationMin * 60;
}

export interface DecideInput {
  state: InterviewState;
  evaluation: EvalResult;
  sections: PlanSection[];
  probeClaimIds: string[];
  durationMin: number;
}

/**
 * Pick the real next move. Guardrails are checked in priority order and win over
 * the LLM; only if none fire do we accept the model's suggestion.
 */
export function decide(input: DecideInput): Decision {
  const { state, evaluation, sections, probeClaimIds, durationMin } = input;
  const lastIdx = sections.length - 1;
  const isLastSection = state.sectionIdx >= lastIdx;

  // 1. Overall time is up. Wrap, or finish if we're already wrapping.
  if (totalBudgetExceeded(state, durationMin)) {
    if (isLastSection) {
      return {
        action: 'MOVE_ON',
        objective: 'Close out the interview',
        claimId: null,
        overrode: true,
        rationale: 'Total time exhausted while in the final section — ending.',
        finished: true,
      };
    }
    return {
      action: 'MOVE_ON',
      objective: 'Wrap up and invite any questions',
      claimId: null,
      overrode: true,
      rationale: 'Total time exhausted — jumping straight to wrap.',
      gotoSectionIdx: lastIdx,
    };
  }

  // 2. This section's budget is spent — advance (or finish if it was the last).
  if (sectionBudgetExceeded(state, sections)) {
    if (isLastSection) {
      return {
        action: 'MOVE_ON',
        objective: 'Close out the interview',
        claimId: null,
        overrode: true,
        rationale: 'Final section budget spent — ending.',
        finished: true,
      };
    }
    const nextIdx = state.sectionIdx + 1;
    return {
      action: 'MOVE_ON',
      objective: `Begin: ${sections[nextIdx]?.title ?? 'next section'}`,
      claimId: sections[nextIdx]?.key === 'claim_verification' ? pickNextClaim(state, probeClaimIds) : null,
      overrode: true,
      rationale: `Section "${sections[state.sectionIdx]?.key}" budget spent — advancing.`,
      gotoSectionIdx: nextIdx,
    };
  }

  // 3. Two weak answers in a row — ease off before we lose them.
  if (state.weakStreak >= WEAK_STREAK_LIMIT && state.difficulty !== 'easy') {
    return {
      action: 'DECREASE_DIFFICULTY',
      objective: evaluation.nextObjective || 'Re-approach with a simpler question',
      claimId: state.currentClaimId,
      overrode: true,
      rationale: `${state.weakStreak} weak answers in a row — dropping difficulty.`,
      newDifficulty: stepDifficulty(state.difficulty, 'down'),
    };
  }

  // 4. They don't know it. Grinding here wastes time and morale.
  if (evaluation.issue === 'no_answer') {
    return moveOn(state, probeClaimIds, sections, "Candidate doesn't know this — moving on.");
  }

  // 5. Follow-up budget spent on this topic — stop digging even if the LLM wants more.
  if (state.followUps >= MAX_FOLLOW_UPS && DIGGING.has(evaluation.actionSuggested)) {
    return moveOn(
      state,
      probeClaimIds,
      sections,
      `Follow-up cap (${MAX_FOLLOW_UPS}) reached on this topic — moving on.`,
    );
  }

  // 6. No guardrail fired — take the LLM's suggestion.
  if (evaluation.actionSuggested === 'MOVE_ON') {
    return moveOn(state, probeClaimIds, sections, 'Answer resolved — model suggested moving on.');
  }

  return {
    action: evaluation.actionSuggested,
    objective: evaluation.nextObjective,
    claimId: state.currentClaimId,
    overrode: false,
    rationale: evaluation.reason,
  };
}

/** Move to the next claim, or advance the section when this one is exhausted. */
function moveOn(
  state: InterviewState,
  probeClaimIds: string[],
  sections: PlanSection[],
  rationale: string,
): Decision {
  const section = sections[state.sectionIdx];
  const lastIdx = sections.length - 1;

  // In claim verification, "move on" means the next unprobed claim.
  if (section?.key === 'claim_verification') {
    const next = pickNextClaim({ ...state, claims: closeCurrent(state) }, probeClaimIds);
    if (next) {
      return {
        action: 'MOVE_ON',
        objective: 'Probe the next claim',
        claimId: next,
        overrode: true,
        rationale,
      };
    }
    // Claims exhausted — advance the section.
    if (state.sectionIdx < lastIdx) {
      const nextIdx = state.sectionIdx + 1;
      return {
        action: 'MOVE_ON',
        objective: `Begin: ${sections[nextIdx]?.title ?? 'next section'}`,
        claimId: null,
        overrode: true,
        rationale: `${rationale} All planned claims covered — advancing section.`,
        gotoSectionIdx: nextIdx,
      };
    }
    return {
      action: 'MOVE_ON',
      objective: 'Close out the interview',
      claimId: null,
      overrode: true,
      rationale: `${rationale} All claims covered and no sections left.`,
      finished: true,
    };
  }

  // Other sections: just take a new objective within the section.
  return {
    action: 'MOVE_ON',
    objective: 'Move to the next topic in this section',
    claimId: null,
    overrode: true,
    rationale,
  };
}

/** Mark the current claim closed so pickNextClaim skips it. */
function closeCurrent(state: InterviewState): InterviewState['claims'] {
  if (!state.currentClaimId) return state.claims;
  const cur = state.claims[state.currentClaimId];
  if (!cur) return state.claims;
  return {
    ...state.claims,
    [state.currentClaimId]: { ...cur, status: verdictFor(cur.confidence, cur.turnsSpent) },
  };
}
