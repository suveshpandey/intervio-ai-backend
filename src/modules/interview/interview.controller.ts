import type { Request, Response } from 'express';
import { z } from 'zod';
import { param } from '@/common/http';
import { issueTicket } from '@/modules/interview/gateway/ticket';
import { interviewRepository } from '@/modules/interview/interview.repository';
import { stateStore } from '@/modules/interview/state.store';
import { clearPrefetch } from '@/modules/interview/engine/prefetch';
import { enqueueReport } from '@/jobs/queue';
import { getOrCreateReport } from '@/modules/report/report.service';
import { logger } from '@/common/logger';
import {
  startInterview,
  submitAnswer,
  getTranscript,
  ESTIMATED_TURN_SECONDS,
} from '@/modules/interview/engine/orchestrator';

const startInput = z.object({ blueprintId: z.string().uuid() });

const answerInput = z.object({
  // A spoken answer transcript. Capped: it is untrusted text headed for an LLM.
  answer: z.string().trim().min(1, 'Answer cannot be empty').max(5000),
  /**
   * How long the exchange actually took. Phase 4 (voice) sends the real value;
   * clamped because a client could otherwise send 0 and never run out of time.
   */
  turnSeconds: z.coerce.number().min(5).max(300).optional(),
});

export const interviewController = {
  async create(req: Request, res: Response) {
    const { blueprintId } = startInput.parse(req.body);
    const result = await startInterview(req.userId!, blueprintId);
    res.status(201).json(result);
  },

  async answer(req: Request, res: Response) {
    const { answer, turnSeconds } = answerInput.parse(req.body);
    const result = await submitAnswer(
      req.userId!,
      param(req, 'id'),
      answer,
      turnSeconds ?? ESTIMATED_TURN_SECONDS,
    );
    res.json(result);
  },

  /**
   * Exchanges the cookie session for a single-use, 60s ticket that opens the
   * voice WebSocket (browsers can't send auth headers on a WS handshake).
   */
  async voiceTicket(req: Request, res: Response) {
    const interviewId = param(req, 'id');
    const { interview } = await getTranscript(req.userId!, interviewId); // 404s if not theirs
    const ticket = await issueTicket({ userId: req.userId!, interviewId: interview.id });
    res.json({ ticket, expiresInSeconds: 60 });
  },

  /**
   * Stop an interview part-way through.
   *
   * Deliberately an HTTP route, not only the WebSocket 'end' message: this has to
   * work when the socket is already gone, which is precisely when an interview
   * would otherwise stay stuck on `live` forever.
   */
  async end(req: Request, res: Response) {
    const interviewId = param(req, 'id');
    const { interview } = await getTranscript(req.userId!, interviewId); // 404s if not theirs

    const ended = await interviewRepository.abandon(interview.id);
    await stateStore.clear(interview.id);
    clearPrefetch(interview.id);
    if (ended) {
      logger.info({ interviewId: interview.id }, 'interview ended early by candidate');
      // A part-finished interview still earns a report, if enough was answered.
      await enqueueReport(interview.id, req.userId!).catch((err: unknown) =>
        logger.error({ err, interviewId: interview.id }, 'failed to queue report'),
      );
    }

    res.json({ status: ended ? 'abandoned' : interview.status });
  },

  async detail(req: Request, res: Response) {
    const { interview, turns } = await getTranscript(req.userId!, param(req, 'id'));
    res.json({
      interview: {
        id: interview.id,
        status: interview.status,
        startedAt: interview.startedAt,
        endedAt: interview.endedAt,
        blueprintId: interview.blueprintId,
      },
      turns: turns.map((t) => ({
        idx: t.idx,
        sectionKey: t.sectionKey,
        objective: t.objective,
        question: t.questionText,
        answer: t.answerTranscript,
        chosenAction: t.chosenAction,
      })),
    });
  },

  /**
   * The report for a finished interview. Normally the background job has already
   * built it; if not (job still running, or Redis was down), this builds it now
   * so the page is never a dead end.
   */
  async report(req: Request, res: Response) {
    const report = await getOrCreateReport(req.userId!, param(req, 'id'));
    res.json({ report });
  },
};
