// Task → model policy. Gemini primary, DeepSeek fallback (PRD hard rule: no OpenAI).
// All ids are euri-gateway model identifiers.
export const MODEL_POLICY = {
  extract: 'gemini-2.5-flash-lite', // resume/JD parse + claim extraction (cheap)
  plan: 'gemini-2.5-flash', // interview blueprint (one-time, depth matters)
  evaluate: 'gemini-2.5-flash-lite', // live answer evaluation (latency-critical)
  question: 'gemini-2.5-flash-lite', // live question generation (latency-critical)
  report: 'gemini-2.5-pro', // final report narrative (strong)
} as const;

export type LlmTask = keyof typeof MODEL_POLICY;

/**
 * Per-task "thinking" budget. Gemini spends hidden reasoning tokens before the answer,
 * which costs both latency and output budget. Measured on a real evaluate-turn prompt:
 *   flash (thinking on) ......... ~5-6s
 *   flash + reasoning none ...... ~3.5s
 *   flash-lite .................. ~1.4-2.3s
 *   flash-lite + reasoning none .. ~1.2s  ← same JSON quality
 * The live interview loop must stay ~1s, so evaluate/question disable thinking.
 */
export const TASK_REASONING: Partial<Record<LlmTask, 'none' | 'low' | 'medium' | 'high'>> = {
  evaluate: 'none',
  question: 'none',
};

/** Used when the primary model errors. Cheap + reliable. */
export const FALLBACK_MODEL = 'deepseek-ai/DeepSeek-V4-Flash';
