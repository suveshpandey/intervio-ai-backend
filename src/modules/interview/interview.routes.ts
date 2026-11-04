import { Router } from 'express';
import { requireAuth } from '@/common/auth-guard';
import { interviewController } from '@/modules/interview/interview.controller';
import { rateLimit } from '@/common/rate-limit';
import { requireQuota } from '@/common/quota';

export const interviewRouter = Router();

interviewRouter.use(requireAuth);
interviewRouter.get('/', interviewController.list);
interviewRouter.post('/', requireQuota('interview'), interviewController.create);
interviewRouter.post(
  '/:id/answer',
  rateLimit({ name: 'answer', limit: 150, windowSec: 60 * 60 }),
  interviewController.answer,
);
interviewRouter.post(
  '/:id/voice-ticket',
  rateLimit({ name: 'voice-ticket', limit: 60, windowSec: 60 * 60 }),
  interviewController.voiceTicket,
);
interviewRouter.post('/:id/end', interviewController.end);
interviewRouter.get('/:id', interviewController.detail);
interviewRouter.get('/:id/report', interviewController.report);
interviewRouter.delete('/:id', interviewController.remove);
