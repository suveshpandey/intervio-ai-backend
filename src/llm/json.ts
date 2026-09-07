import type { z } from 'zod';

/** Pull a JSON object out of an LLM response that may be fenced or padded with prose. */
export function extractJson(raw: string): string {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1]! : raw;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start !== -1 && end > start) return body.slice(start, end + 1);
  return body.trim();
}

/** Parse + validate against a schema. Returns null on failure (caller decides what to do). */
export function tryParse<S extends z.ZodTypeAny>(schema: S, raw: string): z.infer<S> | null {
  try {
    return schema.parse(JSON.parse(extractJson(raw)));
  } catch {
    return null;
  }
}
