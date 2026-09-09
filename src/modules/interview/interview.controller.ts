import type { Request, Response } from 'express';
import { z } from 'zod';
import { param } from '@/common/http';
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
};
