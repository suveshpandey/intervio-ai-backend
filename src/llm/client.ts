import { env } from '@/config/env';
import { AppError } from '@/common/errors';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  /** Ask the gateway for a JSON object response (ignored gracefully if unsupported). */
  json?: boolean;
  /** Model "thinking" budget. 'none' cuts latency ~5x — use it for live-interview turns. */
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high';
  signal?: AbortSignal;
}

export interface ChatResult {
  content: string;
  usage: { input: number; output: number };
  model: string;
  /** True when the model hit the max_tokens cap — the content is cut off, not malformed. */
  truncated: boolean;
}

/** Low-level call to euri's OpenAI-compatible chat/completions endpoint. */
export async function callEuri(
  model: string,
  messages: ChatMessage[],
  opts: ChatOptions = {},
): Promise<ChatResult> {
  if (!env.EURI_API_KEY) throw new AppError(503, 'LLM is not configured', 'llm_disabled');

  const res = await fetch(`${env.EURI_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.EURI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: opts.temperature ?? 0.2,
      max_tokens: opts.maxTokens ?? 2048,
      ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
      ...(opts.reasoningEffort ? { reasoning_effort: opts.reasoningEffort } : {}),
    }),
    signal: opts.signal,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new AppError(502, `LLM call failed (${res.status}): ${detail.slice(0, 200)}`, 'llm_error');
  }

  const data = (await res.json()) as {
    choices?: { message?: { content?: string }; finish_reason?: string }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };

  const choice = data.choices?.[0];
  return {
    content: choice?.message?.content ?? '',
    usage: { input: data.usage?.prompt_tokens ?? 0, output: data.usage?.completion_tokens ?? 0 },
    model,
    truncated: choice?.finish_reason === 'length',
  };
}
