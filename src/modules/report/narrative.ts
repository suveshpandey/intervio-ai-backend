/**
 * The report's prose (PRD §12 Phase 5). The ONLY part of the report an LLM writes,
 * and it may not produce a single number — it explains numbers already computed.
 *
 * Two hard gates before anything is saved:
 *  1. Safe language: a candidate is never called a liar. The PRD is explicit —
 *     verdicts are "supported / partial / insufficient evidence", never an
 *     accusation. One retry, then a written fallback.
 *  2. If the LLM is unavailable, the report still ships with the fallback text.
 *     A missing paragraph must never cost someone their report.
 */

import { z } from 'zod';
import { logger } from '@/common/logger';
import { completeJson } from '@/llm/router';
import { reportNarrativePrompt } from '@/llm/prompts/report';
import { findBannedWord, fallbackNarrative } from '@/modules/report/safe-language';
import type { ComputedReport } from '@/modules/report/scoring';

const narrativeSchema = z.object({ narrative: z.string().default('') });

/** Prose is short by design; this is well clear of it. */
const MAX_TOKENS = 400;

/** The narrative for a computed report. Never throws — always returns shippable text. */
export async function writeNarrative(
  report: ComputedReport,
  role: string,
  level: string,
): Promise<{ text: string; source: 'llm' | 'fallback' }> {
  const messages = reportNarrativePrompt(report, role, level);

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { data } = await completeJson('report', narrativeSchema, messages, { maxTokens: MAX_TOKENS });
      const text = data.narrative.trim();
      if (!text) continue;

      const banned = findBannedWord(text);
      if (banned) {
        // Not a model failure to shrug at: this is the one thing the PRD forbids.
        logger.warn({ banned, attempt }, 'report narrative used accusing language — regenerating');
        continue;
      }
      return { text, source: 'llm' };
    } catch (err) {
      logger.error({ err, attempt }, 'report narrative generation failed');
    }
  }

  logger.warn('falling back to the computed narrative');
  return { text: fallbackNarrative(report), source: 'fallback' };
}
