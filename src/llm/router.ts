import type { z } from 'zod';
import { MODEL_POLICY, FALLBACK_MODEL, type LlmTask } from '@/config/models';
import { callEuri, type ChatMessage, type ChatOptions, type ChatResult } from '@/llm/client';
import { tryParse } from '@/llm/json';
import { AppError } from '@/common/errors';
import { logger } from '@/common/logger';

/** Route a task to its policy model; fall back to DeepSeek if the primary errors. */
export async function chat(
  task: LlmTask,
  messages: ChatMessage[],
  opts: ChatOptions = {},
): Promise<ChatResult> {
  const primary = MODEL_POLICY[task];
  try {
    return await callEuri(primary, messages, opts);
  } catch (err) {
    logger.warn({ err, task, primary }, 'LLM primary failed — falling back');
    return callEuri(FALLBACK_MODEL, messages, opts);
  }
}

const DEFAULT_JSON_TOKENS = 2048;
const MAX_JSON_TOKENS = 8192;

/**
 * Get schema-valid JSON from an LLM task. Two distinct failure modes, handled differently:
 *  - Truncated (hit the token cap): the JSON is cut off, not wrong — retry at a bigger budget.
 *  - Malformed (complete but wrong shape): show the model its output and ask it to fix it.
 * If neither recovers, throw with a specific code so the failure is diagnosable.
 */
export async function completeJson<S extends z.ZodTypeAny>(
  task: LlmTask,
  schema: S,
  messages: ChatMessage[],
  opts: ChatOptions = {},
): Promise<{ data: z.infer<S>; usage: ChatResult['usage'] }> {
  const usage = { input: 0, output: 0 };
  const track = (r: ChatResult) => {
    usage.input += r.usage.input;
    usage.output += r.usage.output;
    return r;
  };

  let budget = opts.maxTokens ?? DEFAULT_JSON_TOKENS;
  let last = track(await chat(task, messages, { ...opts, json: true, maxTokens: budget }));

  const first = tryParse(schema, last.content);
  if (first) return { data: first, usage };

  // Cut off mid-output → give it room and try again (repairing truncated JSON is futile).
  while (last.truncated && budget < MAX_JSON_TOKENS) {
    budget = Math.min(budget * 2, MAX_JSON_TOKENS);
    logger.warn({ task, budget }, 'LLM output truncated — retrying with a larger budget');
    last = track(await chat(task, messages, { ...opts, json: true, maxTokens: budget }));
    const parsed = tryParse(schema, last.content);
    if (parsed) return { data: parsed, usage };
  }

  // Complete but wrong shape → repair pass at the current (adequate) budget.
  if (!last.truncated) {
    const repair = track(
      await chat(
        task,
        [
          ...messages,
          { role: 'assistant', content: last.content },
          {
            role: 'user',
            content:
              'That was not valid JSON matching the required schema. Reply with ONLY the corrected JSON object, no prose, no code fences.',
          },
        ],
        { ...opts, json: true, temperature: 0, maxTokens: budget },
      ),
    );
    const repaired = tryParse(schema, repair.content);
    if (repaired) return { data: repaired, usage };
  }

  const code = last.truncated ? 'llm_truncated' : 'llm_bad_json';
  throw new AppError(502, `LLM returned unusable JSON for task "${task}" (${code})`, code);
}
