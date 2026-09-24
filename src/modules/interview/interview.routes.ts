import { Router } from 'express';
import { requireAuth } from '@/common/auth-guard';
import { interviewController } from '@/modules/interview/interview.controller';
import { rateLimit } from '@/common/rate-limit';

export const interviewRouter = Router();

interviewRouter.use(requireAuth);
interviewRouter.get('/', interviewController.list);
interviewRouter.post(
  '/',
  rateLimit({
    name: 'interview-start',
    limit: 20,
    windowSec: 24 * 60 * 60,
    message: "You've started a lot of interviews today. Come back tomorrow.",
  }),
  interviewController.create,
);
interviewRouter.post('/:id/answer', interviewController.answer);
interviewRouter.post(
  '/:id/voice-ticket',
  rateLimit({ name: 'voice-ticket', limit: 60, windowSec: 60 * 60 }),
  interviewController.voiceTicket,
);
interviewRouter.post('/:id/end', interviewController.end);
interviewRouter.get('/:id', interviewController.detail);
interviewRouter.get('/:id/report', interviewController.report);
interviewRouter.delete('/:id', interviewController.remove);
