import { z } from 'zod';
import { ACTIONS, CLAIM_EVIDENCE, ISSUES, type EvalResult } from '@/modules/interview/types';

/** Models sometimes emit 0–100 or stray outside the range; pull it back to 0–1. */
const unit = z.coerce.number().transform((n) => {
  const v = n > 1 ? n / 100 : n;
  return Math.max(0, Math.min(1, v));
});

/**
 * Raw LLM shape (snake_case, forgiving). Everything has a default so a partial
 * response still validates — the engine can always act on a safe fallback.
 */
export const evalLlmSchema = z.object({
  answer_quality: unit.default(0.5),
  technical_depth: unit.default(0.5),
  claim_evidence: z.enum(CLAIM_EVIDENCE).default('none'),
  issue: z.enum(ISSUES).default('none'),
  action_suggested: z.enum(ACTIONS).default('MOVE_ON'),
  reason: z.string().default(''),
  next_objective: z.string().default(''),
  answer_summary: z.string().default(''),
  skills: z
    .array(z.object({ skill: z.string(), score: unit }))
    .default([])
    .catch([]),
  next_question: z.string().default(''),
});

export type EvalLlm = z.infer<typeof evalLlmSchema>;

export function toEvalResult(raw: EvalLlm): EvalResult {
  return {
    answerQuality: raw.answer_quality,
    technicalDepth: raw.technical_depth,
    claimEvidence: raw.claim_evidence,
    issue: raw.issue,
    actionSuggested: raw.action_suggested,
    reason: raw.reason,
    nextObjective: raw.next_objective,
    answerSummary: raw.answer_summary,
    skills: raw.skills,
    nextQuestion: raw.next_question || undefined,
  };
}

/** Used when the LLM fails entirely — keep the interview moving, never crash. */
export function fallbackEval(): EvalResult {
  return {
    answerQuality: 0.5,
    technicalDepth: 0.5,
    claimEvidence: 'none',
    issue: 'none',
    actionSuggested: 'MOVE_ON',
    reason: 'Evaluation unavailable — moving on.',
    nextObjective: 'Move to the next topic',
    answerSummary: '',
    skills: [],
  };
}
