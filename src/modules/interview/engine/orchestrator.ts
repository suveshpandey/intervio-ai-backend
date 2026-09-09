import type { Blueprint } from '@prisma/client';
import { prisma } from '@/db/prisma';
import { badRequest, notFound } from '@/common/errors';
import { logger } from '@/common/logger';
import type { PlanSection } from '@/modules/planner/schema';
import { stateStore } from '@/modules/interview/state.store';
import { interviewRepository } from '@/modules/interview/interview.repository';
import { buildCompactState } from '@/modules/interview/context/compact-state';
import { evaluateAnswer } from '@/modules/interview/evaluation/evaluate';
import { generateQuestion, generateOpeningQuestion } from '@/modules/interview/question/generate';
import { decide, isRepeat, isWeak, verdictFor } from '@/modules/interview/engine/rules';
import type {
  Decision,
  Difficulty,
  EvalResult,
  InterviewState,
} from '@/modules/interview/types';

/**
 * How much wall-clock a turn costs. In Phase 4 the voice layer will pass the real
 * duration; for typed/dev runs we estimate so time budgets behave realistically.
 */
export const ESTIMATED_TURN_SECONDS = 45;

/** Confidence movement per evidence verdict. */
const CONFIDENCE_DELTA: Record<EvalResult['claimEvidence'], number> = {
  support: 0.3,
  partial: 0.15,
  none: 0,
  weaken: -0.25,
};

const MAX_SUMMARY = 6;
const MAX_LAST_TURNS = 2;
const MAX_OPEN_GAPS = 3;

export interface TurnResult {
  interviewId: string;
  turnIdx: number;
  /** null once the interview is over. */
  question: string | null;
  done: boolean;
  sectionKey: string;
  /** Why the engine did what it did — surfaced for the dev harness and debugging. */
  debug?: {
    action: Decision['action'];
    overrode: boolean;
    rationale: string;
    evaluation: EvalResult;
    difficulty: Difficulty;
  };
}

/* ────────────────────────── public API ────────────────────────── */

export async function startInterview(userId: string, blueprintId: string): Promise<TurnResult> {
  const blueprint = await prisma.blueprint.findFirst({ where: { id: blueprintId, userId } });
  if (!blueprint) throw notFound('Blueprint not found');

  const sections = sectionsOf(blueprint);
  if (sections.length === 0) throw badRequest('Blueprint has no sections', 'bad_blueprint');

  const interview = await interviewRepository.create(userId, blueprint.id);

  const state: InterviewState = {
    interviewId: interview.id,
    blueprintId: blueprint.id,
    phase: 'section',
    sectionIdx: 0,
    sectionElapsedSec: 0,
    totalElapsedSec: 0,
    turnIdx: 0,
    currentClaimId: null,
    currentObjective: `Begin: ${sections[0]!.title}`,
    followUps: 0,
    difficulty: blueprint.difficulty as Difficulty,
    weakStreak: 0,
    askedQuestions: [],
    claims: Object.fromEntries(
      blueprint.probeClaimIds.map((id) => [
        id,
        { status: 'pending' as const, confidence: 0, openGaps: [], turnsSpent: 0 },
      ]),
    ),
    skills: {},
    rollingSummary: [],
    lastTurns: [],
    pendingQuestion: null,
    pendingTurnId: null,
  };

  const compact = await contextFor(state, blueprint, sections);
  const question = await generateOpeningQuestion(compact, sections[0]!.key);
  await issueQuestion(state, sections, question);
  await stateStore.save(state);

  return {
    interviewId: interview.id,
    turnIdx: state.turnIdx,
    question,
    done: false,
    sectionKey: sections[0]!.key,
  };
}

export async function submitAnswer(
  userId: string,
  interviewId: string,
  answer: string,
  turnSeconds: number = ESTIMATED_TURN_SECONDS,
): Promise<TurnResult> {
  const interview = await interviewRepository.findById(interviewId, userId);
  if (!interview) throw notFound('Interview not found');
  if (interview.status !== 'live') throw badRequest('Interview is not live', 'not_live');

  const state = await stateStore.load(interviewId);
  if (!state) throw badRequest('Interview state has expired', 'state_expired');
  if (!state.pendingQuestion || !state.pendingTurnId) {
    throw badRequest('No question is awaiting an answer', 'no_pending_question');
  }

  const blueprint = interview.blueprint;
  const sections = sectionsOf(blueprint);

  // Capture what was under test BEFORE the decision moves us on — evidence must
  // attach to the claim the candidate was actually answering about.
  const probedClaimId = state.currentClaimId;
  const answeredTurnId = state.pendingTurnId;
  const askedQuestion = state.pendingQuestion;

  // 1. Judge the answer (merged call also proposes the next question).
  const compact = await contextFor(state, blueprint, sections);
  const evaluation = await evaluateAnswer(compact, askedQuestion, answer);

  // 2. Advance the clocks.
  state.totalElapsedSec += turnSeconds;
  state.sectionElapsedSec += turnSeconds;
  state.turnIdx += 1;

  // 3. Fold the judgement into durable state.
  applyEvaluation(state, evaluation, askedQuestion, answer, probedClaimId);

  // 4. OUR engine decides the real next move.
  const decision = decide({
    state,
    evaluation,
    sections,
    probeClaimIds: blueprint.probeClaimIds,
    durationMin: blueprint.durationMin,
  });

  // 5. Persist the completed turn + any claim evidence.
  await interviewRepository.answerTurn(answeredTurnId, answer, evaluation, decision.action);
  if (probedClaimId && (evaluation.claimEvidence === 'support' || evaluation.claimEvidence === 'weaken')) {
    await interviewRepository.addEvidence({
      interviewId,
      claimId: probedClaimId,
      turnId: answeredTurnId,
      polarity: evaluation.claimEvidence === 'support' ? 'support' : 'weaken',
      weight: Math.abs(CONFIDENCE_DELTA[evaluation.claimEvidence]) * evaluation.answerQuality,
      rationale: evaluation.reason.slice(0, 500),
    });
  }

  state.pendingQuestion = null;
  state.pendingTurnId = null;

  // 6. Apply the decision to state (may close a claim / jump sections).
  const movedSection = applyDecision(state, decision);

  logger.info(
    { interviewId, turn: state.turnIdx, action: decision.action, overrode: decision.overrode },
    decision.rationale,
  );

  // 7. Finished?
  if (decision.finished) {
    state.phase = 'done';
    await stateStore.save(state);
    await interviewRepository.complete(interviewId);
    return {
      interviewId,
      turnIdx: state.turnIdx,
      question: null,
      done: true,
      sectionKey: sections[state.sectionIdx]?.key ?? 'wrap',
      debug: debugOf(decision, evaluation, state),
    };
  }

  // 8. Next question — free from the merged call when the engine agreed.
  const question = await nextQuestion(state, blueprint, sections, decision, evaluation, movedSection);
  await issueQuestion(state, sections, question);
  await stateStore.save(state);

  return {
    interviewId,
    turnIdx: state.turnIdx,
    question,
    done: false,
    sectionKey: sections[state.sectionIdx]?.key ?? 'unknown',
    debug: debugOf(decision, evaluation, state),
  };
}

/** Full transcript for the report (Phase 5) and the dev harness. */
export async function getTranscript(userId: string, interviewId: string) {
  const interview = await interviewRepository.findById(interviewId, userId);
  if (!interview) throw notFound('Interview not found');
  const turns = await interviewRepository.listTurns(interviewId);
  return { interview, turns };
}

/* ────────────────────────── internals ────────────────────────── */

function sectionsOf(blueprint: Blueprint): PlanSection[] {
  return (blueprint.sections as unknown as PlanSection[]) ?? [];
}

function debugOf(decision: Decision, evaluation: EvalResult, state: InterviewState) {
  return {
    action: decision.action,
    overrode: decision.overrode,
    rationale: decision.rationale,
    evaluation,
    difficulty: state.difficulty,
  };
}

async function contextFor(
  state: InterviewState,
  blueprint: Blueprint,
  sections: PlanSection[],
): Promise<string> {
  let claimText: string | null = null;
  let claimSkills: string[] = [];
  if (state.currentClaimId) {
    const claim = await prisma.claim.findUnique({ where: { id: state.currentClaimId } });
    claimText = claim?.text ?? null;
    claimSkills = claim?.relatedSkills ?? [];
  }
  return buildCompactState({
    state,
    blueprint: {
      role: blueprint.role,
      level: blueprint.level,
      difficulty: blueprint.difficulty,
      durationMin: blueprint.durationMin,
      sections,
    },
    claimText,
    claimSkills,
  });
}

/** Create the Turn row for a question and mark it pending. */
async function issueQuestion(
  state: InterviewState,
  sections: PlanSection[],
  question: string,
): Promise<void> {
  // Opening a claim flips it from pending → probing.
  if (state.currentClaimId) {
    const p = state.claims[state.currentClaimId];
    if (p && p.status === 'pending') p.status = 'probing';
  }

  const turn = await interviewRepository.createTurn({
    interviewId: state.interviewId,
    idx: state.turnIdx,
    sectionKey: sections[state.sectionIdx]?.key ?? 'unknown',
    objective: state.currentObjective,
    questionText: question,
    claimId: state.currentClaimId,
  });

  state.pendingQuestion = question;
  state.pendingTurnId = turn.id;
  state.askedQuestions.push(question);
}

function applyEvaluation(
  state: InterviewState,
  e: EvalResult,
  question: string,
  answer: string,
  probedClaimId: string | null,
): void {
  state.weakStreak = isWeak(e) ? state.weakStreak + 1 : 0;

  // Running mean per skill. Names are normalised first — the model happily returns
  // "system design", "system_design" and "System Design" for the same thing.
  for (const { skill, score } of e.skills) {
    const key = normalizeSkill(skill);
    if (!key) continue;
    const prev = state.skills[key];
    state.skills[key] = prev
      ? { score: (prev.score * prev.samples + score) / (prev.samples + 1), samples: prev.samples + 1 }
      : { score, samples: 1 };
  }

  // The rolling summary is a free byproduct of the eval call (PRD §8.5).
  if (e.answerSummary) {
    state.rollingSummary.push(e.answerSummary);
    if (state.rollingSummary.length > MAX_SUMMARY) state.rollingSummary.shift();
  }

  state.lastTurns.push({ question, answer });
  if (state.lastTurns.length > MAX_LAST_TURNS) state.lastTurns.shift();

  if (probedClaimId) {
    const p = state.claims[probedClaimId];
    if (p) {
      p.turnsSpent += 1;
      p.confidence = clamp01(p.confidence + CONFIDENCE_DELTA[e.claimEvidence] * e.answerQuality);
      // Whatever still isn't substantiated becomes the open gap to chase.
      if ((e.claimEvidence === 'partial' || e.claimEvidence === 'none') && e.nextObjective) {
        if (!p.openGaps.includes(e.nextObjective)) p.openGaps.push(e.nextObjective);
        if (p.openGaps.length > MAX_OPEN_GAPS) p.openGaps.shift();
      }
    }
  }
}

/** @returns true when the decision moved us into a new section. */
function applyDecision(state: InterviewState, decision: Decision): boolean {
  if (decision.newDifficulty) state.difficulty = decision.newDifficulty;

  const jumped = decision.gotoSectionIdx !== undefined;
  const movingOn = jumped || decision.action === 'MOVE_ON';

  if (movingOn) {
    closeCurrentClaim(state);
    state.followUps = 0;
  } else {
    state.followUps += 1; // still working the same topic
  }

  if (jumped) {
    state.sectionIdx = decision.gotoSectionIdx!;
    state.sectionElapsedSec = 0;
  }

  state.currentClaimId = decision.claimId;
  state.currentObjective = decision.objective;
  return jumped;
}

function closeCurrentClaim(state: InterviewState): void {
  if (!state.currentClaimId) return;
  const p = state.claims[state.currentClaimId];
  if (!p || (p.status !== 'probing' && p.status !== 'pending')) return;
  p.status = verdictFor(p.confidence, p.turnsSpent);
}

async function nextQuestion(
  state: InterviewState,
  blueprint: Blueprint,
  sections: PlanSection[],
  decision: Decision,
  evaluation: EvalResult,
  movedSection: boolean,
): Promise<string> {
  // Common path: the engine agreed, so the merged call already wrote the question.
  if (!decision.overrode && evaluation.nextQuestion && !isRepeat(evaluation.nextQuestion, state.askedQuestions)) {
    return evaluation.nextQuestion;
  }

  const compact = await contextFor(state, blueprint, sections);
  const sectionKey = sections[state.sectionIdx]?.key ?? 'claim_verification';

  let question = movedSection
    ? await generateOpeningQuestion(compact, sectionKey)
    : await generateQuestion(compact, decision.action, decision.objective);

  // One retry if we somehow produced a repeat.
  if (isRepeat(question, state.askedQuestions)) {
    question = await generateQuestion(
      compact,
      decision.action,
      `${decision.objective} (ask something clearly different from what was already asked)`,
    );
  }
  return question;
}

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/** "Caching (Redis)" / "caching_redis" / "Caching  Redis" → "caching redis". */
export function normalizeSkill(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[_\-/]+/g, ' ')
    .replace(/[^a-z0-9+#. ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
