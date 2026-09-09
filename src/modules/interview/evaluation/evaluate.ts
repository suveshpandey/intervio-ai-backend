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
  try {
    const { data } = await completeJson(
      'evaluate',
      evalLlmSchema,
      evalPrompt(compactState, question, answer),
      { maxTokens: 700 },
    );
    return toEvalResult(data);
  } catch (err) {
    logger.error({ err }, 'Answer evaluation failed — using safe fallback');
    return fallbackEval();
  }
}
