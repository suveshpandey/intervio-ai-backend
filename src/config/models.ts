// Task → model policy. Gemini primary, DeepSeek fallback (PRD hard rule: no OpenAI).
// All ids are euri-gateway model identifiers.
export const MODEL_POLICY = {
  extract: 'gemini-2.5-flash-lite', // resume/JD parse + claim extraction (cheap)
  plan: 'gemini-2.5-flash', // interview blueprint
  evaluate: 'gemini-2.5-flash', // live answer evaluation
  question: 'gemini-2.5-flash', // live question generation
  report: 'gemini-2.5-pro', // final report narrative (strong)
} as const;

export type LlmTask = keyof typeof MODEL_POLICY;

/** Used when the primary model errors. Cheap + reliable. */
export const FALLBACK_MODEL = 'deepseek-ai/DeepSeek-V4-Flash';
