// Task → model policy. Gemini primary, DeepSeek fallback (PRD hard rule: no OpenAI).
// All ids are euri-gateway model identifiers.
// NOTE: euri's /models list can include ids Google has already retired (the 2.5
// family 404s since Sept 2026 while still listed) — verify with a real call.
export const MODEL_POLICY = {
  extract: 'gemini-3.5-flash-lite', // resume/JD parse + claim extraction (cheap)
  plan: 'gemini-3.5-flash', // interview blueprint (one-time, depth matters)
  evaluate: 'gemini-3.5-flash-lite', // live answer evaluation (latency-critical)
  question: 'gemini-3.5-flash-lite', // live question generation (latency-critical)
  report: 'gemini-3.1-pro', // final report narrative (strong)
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
 * (3.5-flash-lite honours `none`, ~2.2s via euri; 3.5-flash / 3.1-pro keep
 * thinking regardless, so only use them where latency doesn't matter.)
 */
export const TASK_REASONING: Partial<Record<LlmTask, 'none' | 'low' | 'medium' | 'high'>> = {
  evaluate: 'none',
  question: 'none',
};

/**
 * Used when the primary model errors or times out.
 * DeepSeek is reliable but ~13s per call through euri — fine for one-off work,
 * a dead-air freeze mid-interview. Live tasks fall back to a second Gemini
 * (~2.5s, honours reasoning none) instead.
 */
const DEFAULT_FALLBACK = 'deepseek-ai/DeepSeek-V4-Flash';
const LIVE_FALLBACK = 'gemini-3.1-flash-lite';

export const FALLBACK_POLICY: Record<LlmTask, string> = {
  extract: DEFAULT_FALLBACK,
  plan: DEFAULT_FALLBACK,
  evaluate: LIVE_FALLBACK,
  question: LIVE_FALLBACK,
  report: DEFAULT_FALLBACK,
};

/**
 * Per-task ceiling before giving up on the primary. Live calls take ~2-3s, so a
 * call still running at 8s is stalled — cut over to the fallback rather than
 * leave the candidate in silence for the default 20s.
 */
export const TASK_TIMEOUT_MS: Partial<Record<LlmTask, number>> = {
  evaluate: 8_000,
  question: 8_000,
};
