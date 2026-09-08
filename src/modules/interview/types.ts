/**
 * Interview engine types.
 *
 * PRD §7: the LLM does NOT run the interview. It only (a) evaluates an answer and
 * (b) writes question text. Everything below is state OUR code owns and decides on.
 */

export const ACTIONS = [
  'PROBE', // dig into the current claim
  'FOLLOW_UP', // push on the same answer
  'MOVE_ON', // next claim / topic
  'CHALLENGE', // press a shaky assertion
  'CLARIFY', // answer was vague/off-topic
  'DECREASE_DIFFICULTY',
] as const;
export type Action = (typeof ACTIONS)[number];

export const ISSUES = ['generic', 'memorized', 'no_answer', 'off_topic', 'none'] as const;
export type Issue = (typeof ISSUES)[number];

/** How the answer bears on the claim being probed. */
export const CLAIM_EVIDENCE = ['support', 'partial', 'none', 'weaken'] as const;
export type ClaimEvidence = (typeof CLAIM_EVIDENCE)[number];

export type Difficulty = 'easy' | 'standard' | 'hard';

export type ClaimVerdict = 'pending' | 'probing' | 'verified' | 'partial' | 'insufficient';

export interface ClaimProgress {
  status: ClaimVerdict;
  /** Running 0–1 confidence that the claim is genuinely supported. */
  confidence: number;
  /** What still hasn't been substantiated — drives the next objective. */
  openGaps: string[];
  turnsSpent: number;
}

export interface SkillScore {
  /** Running mean, 0–1. */
  score: number;
  samples: number;
}

export interface TurnRecord {
  question: string;
  answer: string;
}

/**
 * Layer 1 (PRD §8.5): the authoritative interview memory. Lives in Redis,
 * checkpointed to Postgres each turn. NEVER sent to the LLM whole — the
 * compact-state builder sends a small slice.
 */
export interface InterviewState {
  interviewId: string;
  blueprintId: string;

  phase: 'intro' | 'section' | 'wrap' | 'done';
  sectionIdx: number;
  sectionElapsedSec: number;
  totalElapsedSec: number;
  turnIdx: number;

  /** The claim currently under examination (claim-verification section). */
  currentClaimId: string | null;
  currentObjective: string;
  /** Follow-ups spent on the CURRENT topic (reset when we move on). */
  followUps: number;
  difficulty: Difficulty;
  /** Consecutive weak answers — 2 in a row drops difficulty. */
  weakStreak: number;

  /** Every question already asked, so we never repeat one. */
  askedQuestions: string[];
  claims: Record<string, ClaimProgress>;
  skills: Record<string, SkillScore>;
  /** 2–4 line "story so far", appended from each eval's one-line summary. */
  rollingSummary: string[];
  /** Last 1–2 answered turns, verbatim, for coherence. */
  lastTurns: TurnRecord[];

  /** The question awaiting an answer (and its DB row). */
  pendingQuestion: string | null;
  pendingTurnId: string | null;
}

/** What the LLM returns after judging an answer. */
export interface EvalResult {
  answerQuality: number; // 0–1
  technicalDepth: number; // 0–1
  claimEvidence: ClaimEvidence;
  issue: Issue;
  actionSuggested: Action;
  reason: string;
  nextObjective: string;
  /** One line — appended to the rolling summary. Free byproduct (PRD §8.5). */
  answerSummary: string;
  /** Skill signals observed in this answer. */
  skills: { skill: string; score: number }[];
  /** Present when the merged eval+question call succeeded. */
  nextQuestion?: string;
}

/** The engine's decision for the next move — may override the LLM's suggestion. */
export interface Decision {
  action: Action;
  objective: string;
  claimId: string | null;
  /** True when the engine disagreed with the LLM (needs a fresh question call). */
  overrode: boolean;
  /** Why the engine decided this — logged, and invaluable when debugging. */
  rationale: string;
  /** Set when this decision ends the interview. */
  finished?: boolean;
  /** Set when the engine jumps sections (time-up goes straight to wrap, not just +1). */
  gotoSectionIdx?: number;
  /** Set when the engine lowered the difficulty as part of this decision. */
  newDifficulty?: Difficulty;
}
