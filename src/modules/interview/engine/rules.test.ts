import { describe, it, expect } from 'vitest';
import {
  decide,
  isRepeat,
  isWeak,
  pickNextClaim,
  stepDifficulty,
  verdictFor,
  MAX_FOLLOW_UPS,
} from '@/modules/interview/engine/rules';
import type { EvalResult, InterviewState } from '@/modules/interview/types';
import type { PlanSection } from '@/modules/planner/schema';

const SECTIONS: PlanSection[] = [
  { key: 'intro', title: 'Warm-up & intro', budgetMin: 2 },
  { key: 'claim_verification', title: 'Claim verification', budgetMin: 9 },
  { key: 'fundamentals', title: 'Fundamentals', budgetMin: 3 },
  { key: 'problem_solving', title: 'Problem solving', budgetMin: 4 },
  { key: 'wrap', title: 'Wrap-up', budgetMin: 2 },
];
const DURATION = 20;
const CLAIMS = ['c1', 'c2'];

function makeState(over: Partial<InterviewState> = {}): InterviewState {
  return {
    interviewId: 'i1',
    blueprintId: 'b1',
    phase: 'section',
    sectionIdx: 1, // claim_verification
    sectionElapsedSec: 0,
    totalElapsedSec: 0,
    turnIdx: 1,
    currentClaimId: 'c1',
    currentObjective: 'Test caching depth',
    followUps: 0,
    difficulty: 'standard',
    weakStreak: 0,
    askedQuestions: [],
    claims: {
      c1: { status: 'probing', confidence: 0.5, openGaps: [], turnsSpent: 1 },
      c2: { status: 'pending', confidence: 0, openGaps: [], turnsSpent: 0 },
    },
    skills: {},
    rollingSummary: [],
    lastTurns: [],
    pendingQuestion: null,
    pendingTurnId: null,
    ...over,
  };
}

function makeEval(over: Partial<EvalResult> = {}): EvalResult {
  return {
    answerQuality: 0.7,
    technicalDepth: 0.6,
    claimEvidence: 'support',
    issue: 'none',
    actionSuggested: 'PROBE',
    reason: 'Solid, specific answer.',
    nextObjective: 'Dig into the trade-off',
    answerSummary: 'Explained the cache correctly.',
    skills: [],
    ...over,
  };
}

const run = (state: InterviewState, evaluation: EvalResult) =>
  decide({ state, evaluation, sections: SECTIONS, probeClaimIds: CLAIMS, durationMin: DURATION });

describe('guardrail priority', () => {
  it('jumps straight to wrap when total time is exhausted', () => {
    const d = run(makeState({ totalElapsedSec: DURATION * 60 }), makeEval());
    expect(d.gotoSectionIdx).toBe(SECTIONS.length - 1);
    expect(d.overrode).toBe(true);
    expect(d.finished).toBeUndefined();
  });

  it('finishes when total time runs out during the final section', () => {
    const d = run(makeState({ sectionIdx: 4, totalElapsedSec: DURATION * 60 }), makeEval());
    expect(d.finished).toBe(true);
  });

  it('advances the section when the section budget is spent', () => {
    // claim_verification budget is 9 min
    const d = run(makeState({ sectionElapsedSec: 9 * 60 }), makeEval());
    expect(d.gotoSectionIdx).toBe(2);
    expect(d.overrode).toBe(true);
  });

  it('total-time beats section-budget (checked first)', () => {
    const d = run(
      makeState({ totalElapsedSec: DURATION * 60, sectionElapsedSec: 9 * 60 }),
      makeEval(),
    );
    expect(d.gotoSectionIdx).toBe(SECTIONS.length - 1); // wrap, not merely +1
  });

  it('drops difficulty after two weak answers', () => {
    const d = run(makeState({ weakStreak: 2 }), makeEval({ actionSuggested: 'PROBE' }));
    expect(d.action).toBe('DECREASE_DIFFICULTY');
    expect(d.newDifficulty).toBe('easy');
    expect(d.overrode).toBe(true);
  });

  it('does not drop difficulty below easy', () => {
    const d = run(makeState({ weakStreak: 3, difficulty: 'easy' }), makeEval());
    expect(d.action).not.toBe('DECREASE_DIFFICULTY');
  });

  it('moves on when the candidate does not know the answer', () => {
    const d = run(makeState(), makeEval({ issue: 'no_answer', actionSuggested: 'PROBE' }));
    expect(d.action).toBe('MOVE_ON');
    expect(d.claimId).toBe('c2');
    expect(d.rationale).toMatch(/doesn't know/i);
  });

  it('stops digging once the follow-up cap is reached', () => {
    const d = run(makeState({ followUps: MAX_FOLLOW_UPS }), makeEval({ actionSuggested: 'FOLLOW_UP' }));
    expect(d.action).toBe('MOVE_ON');
    expect(d.overrode).toBe(true);
  });

  it('the follow-up cap does not block a non-digging suggestion', () => {
    const d = run(makeState({ followUps: MAX_FOLLOW_UPS }), makeEval({ actionSuggested: 'MOVE_ON' }));
    expect(d.action).toBe('MOVE_ON');
    expect(d.claimId).toBe('c2'); // moved to the next claim, not blocked
  });
});

describe('accepting the model', () => {
  it('takes the suggested action when no guardrail fires', () => {
    const d = run(makeState(), makeEval({ actionSuggested: 'CHALLENGE', nextObjective: 'Press on scale' }));
    expect(d.action).toBe('CHALLENGE');
    expect(d.objective).toBe('Press on scale');
    expect(d.overrode).toBe(false);
    expect(d.claimId).toBe('c1'); // stays on the current claim
  });
});

describe('moving between claims and sections', () => {
  it('MOVE_ON picks the next unprobed claim', () => {
    const d = run(makeState(), makeEval({ actionSuggested: 'MOVE_ON' }));
    expect(d.claimId).toBe('c2');
    expect(d.gotoSectionIdx).toBeUndefined();
  });

  it('advances the section once every claim is covered', () => {
    const state = makeState({
      currentClaimId: 'c2',
      claims: {
        c1: { status: 'verified', confidence: 0.8, openGaps: [], turnsSpent: 2 },
        c2: { status: 'probing', confidence: 0.5, openGaps: [], turnsSpent: 1 },
      },
    });
    const d = run(state, makeEval({ actionSuggested: 'MOVE_ON' }));
    expect(d.gotoSectionIdx).toBe(2);
  });

  it('outside claim verification, MOVE_ON stays in the section', () => {
    const d = run(makeState({ sectionIdx: 2 }), makeEval({ actionSuggested: 'MOVE_ON' }));
    expect(d.gotoSectionIdx).toBeUndefined();
    expect(d.claimId).toBeNull();
  });
});

describe('helpers', () => {
  it('isWeak flags low quality and non-answers', () => {
    expect(isWeak(makeEval({ answerQuality: 0.2 }))).toBe(true);
    expect(isWeak(makeEval({ answerQuality: 0.9, issue: 'no_answer' }))).toBe(true);
    expect(isWeak(makeEval({ answerQuality: 0.8 }))).toBe(false);
  });

  it('stepDifficulty clamps at both ends', () => {
    expect(stepDifficulty('standard', 'down')).toBe('easy');
    expect(stepDifficulty('easy', 'down')).toBe('easy');
    expect(stepDifficulty('hard', 'up')).toBe('hard');
  });

  it('verdictFor bands confidence', () => {
    expect(verdictFor(0.9, 2)).toBe('verified');
    expect(verdictFor(0.5, 2)).toBe('partial');
    expect(verdictFor(0.1, 2)).toBe('insufficient');
    expect(verdictFor(0.9, 0)).toBe('insufficient'); // never probed = no evidence
  });

  it('isRepeat catches near-identical phrasing', () => {
    const asked = ['What was the bottleneck before you added caching?'];
    expect(isRepeat('what was the bottleneck before you added caching??', asked)).toBe(true);
    expect(isRepeat('How did you measure peak traffic?', asked)).toBe(false);
  });

  it('pickNextClaim returns null when all claims are closed', () => {
    const state = makeState({
      claims: {
        c1: { status: 'verified', confidence: 0.8, openGaps: [], turnsSpent: 2 },
        c2: { status: 'partial', confidence: 0.5, openGaps: [], turnsSpent: 1 },
      },
    });
    expect(pickNextClaim(state, CLAIMS)).toBeNull();
  });
});
