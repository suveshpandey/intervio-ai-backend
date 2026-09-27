/**
 * What each provider call costs us.
 *
 * ⚠️ These are ESTIMATES from public list prices, not an invoice. euri resells
 * Gemini and does not publish a per-model rate card, and Deepgram's rate depends
 * on the plan. Every figure in the admin page is only as right as this file —
 * update it from a real bill, and the page recomputes historical spend from the
 * stored token/second counts, so nothing needs re-recording.
 *
 * PRD: $1 = ₹95.
 */

export const USD_TO_INR = 95;

/** USD per 1 million tokens. */
interface TokenRate {
  input: number;
  output: number;
}

const LLM_RATES: Record<string, TokenRate> = {
  'gemini-3.5-flash-lite': { input: 0.1, output: 0.4 },
  'gemini-3.1-flash-lite': { input: 0.1, output: 0.4 },
  'gemini-3.5-flash': { input: 0.3, output: 2.5 },
  'gemini-3.1-pro': { input: 1.25, output: 10 },
  'deepseek-ai/DeepSeek-V4-Flash': { input: 0.27, output: 1.1 },
};

/** Used when a model isn't listed above — better to over-estimate than to show zero. */
const UNKNOWN_LLM_RATE: TokenRate = { input: 0.5, output: 2 };

/** Deepgram streaming speech-to-text, USD per minute of audio. */
export const STT_USD_PER_MINUTE = 0.0077;
/** Deepgram text-to-speech, USD per 1,000 characters. */
export const TTS_USD_PER_1K_CHARS = 0.03;

export function llmCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const rate = LLM_RATES[model] ?? UNKNOWN_LLM_RATE;
  return (inputTokens / 1_000_000) * rate.input + (outputTokens / 1_000_000) * rate.output;
}

export const sttCostUsd = (seconds: number): number => (seconds / 60) * STT_USD_PER_MINUTE;

export const ttsCostUsd = (characters: number): number => (characters / 1000) * TTS_USD_PER_1K_CHARS;

/** True when we are guessing this model's price — surfaced in the admin page. */
export const isEstimatedRate = (model: string): boolean => !(model in LLM_RATES);
