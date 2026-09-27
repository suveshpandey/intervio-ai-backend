import { prisma } from '@/db/prisma';
import { logger } from '@/common/logger';
import { currentContext } from '@/common/context';
import { llmCostUsd, sttCostUsd, ttsCostUsd } from '@/config/pricing';

export interface UsageRecord {
  kind: 'llm' | 'stt' | 'tts';
  provider: 'euri' | 'deepgram';
  model: string;
  task?: string;
  inputTokens?: number;
  outputTokens?: number;
  units?: number;
  costUsd: number;
  durationMs?: number;
}

/**
 * Metering must never break the thing it measures: this swallows its own errors
 * and callers do not await it.
 */
async function record(entry: UsageRecord): Promise<void> {
  const { userId, interviewId } = currentContext();
  try {
    await prisma.usageEvent.create({
      data: {
        userId: userId ?? null,
        interviewId: interviewId ?? null,
        kind: entry.kind,
        provider: entry.provider,
        model: entry.model,
        task: entry.task ?? null,
        inputTokens: entry.inputTokens ?? 0,
        outputTokens: entry.outputTokens ?? 0,
        units: entry.units ?? 0,
        costUsd: entry.costUsd,
        durationMs: entry.durationMs ?? 0,
      },
    });
  } catch (err) {
    logger.error({ err, kind: entry.kind }, 'failed to record usage');
  }
}

export const usage = {
  llm(model: string, task: string | undefined, inputTokens: number, outputTokens: number, durationMs: number): void {
    void record({
      kind: 'llm',
      provider: 'euri',
      model,
      task,
      inputTokens,
      outputTokens,
      costUsd: llmCostUsd(model, inputTokens, outputTokens),
      durationMs,
    });
  },

  /** @param seconds of audio streamed to Deepgram over a whole session. */
  stt(model: string, seconds: number): void {
    if (seconds <= 0) return;
    void record({ kind: 'stt', provider: 'deepgram', model, units: seconds, costUsd: sttCostUsd(seconds) });
  },

  /** @param characters spoken over a whole session. */
  tts(model: string, characters: number): void {
    if (characters <= 0) return;
    void record({
      kind: 'tts',
      provider: 'deepgram',
      model,
      units: characters,
      costUsd: ttsCostUsd(characters),
    });
  },
};
