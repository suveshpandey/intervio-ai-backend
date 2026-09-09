import { z } from 'zod';
import { completeJson } from '@/llm/router';
import { questionPrompt, openingQuestionPrompt } from '@/llm/prompts/interview';
import { logger } from '@/common/logger';
import type { Action } from '@/modules/interview/types';

const questionSchema = z.object({ question: z.string().default('') });

/** Short output: these are spoken aloud, and short questions cut TTS cost too. */
const MAX_TOKENS = 200;

const FALLBACK = 'Could you walk me through that in a bit more detail?';

/** Question for an action the ENGINE chose (only when it overrode the model). */
export async function generateQuestion(
  compactState: string,
  action: Action,
  objective: string,
): Promise<string> {
  try {
    const { data } = await completeJson(
      'question',
      questionSchema,
      questionPrompt(compactState, action, objective),
      { maxTokens: MAX_TOKENS },
    );
    return data.question.trim() || FALLBACK;
  } catch (err) {
    logger.error({ err, action }, 'Question generation failed — using fallback');
    return FALLBACK;
  }
}

/** First question of a section (nothing to evaluate yet). */
export async function generateOpeningQuestion(
  compactState: string,
  sectionKey: string,
): Promise<string> {
  try {
    const { data } = await completeJson(
      'question',
      questionSchema,
      openingQuestionPrompt(compactState, sectionKey),
      { maxTokens: MAX_TOKENS },
    );
    return data.question.trim() || FALLBACK;
  } catch (err) {
    logger.error({ err, sectionKey }, 'Opening question generation failed — using fallback');
    return FALLBACK;
  }
}
