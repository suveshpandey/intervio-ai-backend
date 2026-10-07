import { completeJson } from '@/llm/router';
import { evalPrompt } from '@/llm/prompts/interview';
import { logger } from '@/common/logger';
import type { EvalResult } from '@/modules/interview/types';
import { evalLlmSchema, toEvalResult, fallbackEval } from '@/modules/interview/evaluation/schema';

/**
 * Merged evaluate + next-question call (PRD §8.5 optimisation #6).
 * Never throws: a live interview must keep moving, so a failure degrades to a
 * safe "move on" rather than dropping the call.
 */
export async function evaluateAnswer(
  compactState: string,
  question: string,
  answer: string,
): Promise<EvalResult> {
  return (await tryEvaluateAnswer(compactState, question, answer)) ?? fallbackEval();
}

/**
 * The same call, but honest about failure: null instead of the safe fallback.
 *
 * Used for speculative scoring during the candidate's pause. A cancelled or
 * failed speculation must never be mistaken for a real judgement — the caller
 * discards null and scores again for real.
 */
export async function tryEvaluateAnswer(
  compactState: string,
  question: string,
  answer: string,
  signal?: AbortSignal,
): Promise<EvalResult | null> {
  try {
    const { data } = await completeJson(
      'evaluate',
      evalLlmSchema,
      evalPrompt(compactState, question, answer),
      { maxTokens: 700, signal },
    );
    return toEvalResult(data);
  } catch (err) {
    if (signal?.aborted) return null; // we cancelled it — not a failure
    logger.error({ err }, 'Answer evaluation failed');
    return null;
  }
}
