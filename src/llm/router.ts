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

/**
 * Get schema-valid JSON from an LLM task.
 * Strategy: call → validate → one repair retry → throw (caller supplies a safe fallback).
 */
export async function completeJson<T>(
  task: LlmTask,
  schema: z.ZodType<T>,
  messages: ChatMessage[],
  opts: ChatOptions = {},
): Promise<{ data: T; usage: ChatResult['usage'] }> {
  const first = await chat(task, messages, { ...opts, json: true });
  const parsed = tryParse(schema, first.content);
  if (parsed) return { data: parsed, usage: first.usage };

  // Repair pass: show the model its own output and ask it to fix the shape.
  const repair = await chat(
    task,
    [
      ...messages,
      { role: 'assistant', content: first.content },
      {
        role: 'user',
        content:
          'That was not valid JSON matching the required schema. Reply with ONLY the corrected JSON object, no prose, no code fences.',
      },
    ],
    { ...opts, json: true, temperature: 0 },
  );
  const repaired = tryParse(schema, repair.content);
  if (repaired) {
    return {
      data: repaired,
      usage: {
        input: first.usage.input + repair.usage.input,
        output: first.usage.output + repair.usage.output,
      },
    };
  }

  throw new AppError(502, `LLM returned invalid JSON for task "${task}"`, 'llm_bad_json');
}
