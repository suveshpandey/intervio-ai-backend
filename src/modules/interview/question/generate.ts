import { z } from 'zod';
import { completeJson } from '@/llm/router';
import { questionPrompt, openingQuestionPrompt } from '@/llm/prompts/interview';
import { logger } from '@/common/logger';
import type { Action } from '@/modules/interview/types';

const questionSchema = z.object({ question: z.string().default('') });

/** Short output: these are spoken aloud, and short questions cut TTS cost too. */
const MAX_TOKENS = 200;

/**
 * Spoken when generation fails outright (provider down, both models dead).
 * A pool rather than one line: during an outage EVERY turn lands here, and an
 * interviewer repeating one sentence is worse than the outage itself. These are
 * deliberately open-ended — they have to make sense after any answer.
 */
const FALLBACKS: Partial<Record<Action, string[]>> & { default: string[] } = {
  default: [
    'Could you walk me through that in a bit more detail?',
    'What was the hardest part of that to get right?',
    'How did you know it was working?',
  ],
  MOVE_ON: [
    'Tell me about another piece of work you are proud of.',
    'What else have you built recently that you would want to be asked about?',
  ],
  CLARIFY: [
    'Could you give me a concrete example from your own work?',
    'What did you personally do on that?',
  ],
  CHALLENGE: [
    'What would you do differently if you built that again?',
    'What broke first when that got busy?',
  ],
  DECREASE_DIFFICULTY: [
    'Let us take a step back — what part of that are you most comfortable with?',
  ],
};

const FALLBACK_SET = new Set(Object.values(FALLBACKS).flat());

/** Is this text one of our canned lines rather than a written question? */
export const isFallbackQuestion = (text: string): boolean => FALLBACK_SET.has(text.trim());

function fallbackFor(action?: Action): string {
  const pool = (action && FALLBACKS[action]) || FALLBACKS.default;
  return pool[Math.floor(Math.random() * pool.length)]!;
}

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
    return data.question.trim() || fallbackFor(action);
  } catch (err) {
    logger.error({ err, action }, 'Question generation failed — using fallback');
    return fallbackFor(action);
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
    return data.question.trim() || fallbackFor();
  } catch (err) {
    logger.error({ err, sectionKey }, 'Opening question generation failed — using fallback');
    return fallbackFor();
  }
}
