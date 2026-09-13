import { Router } from 'express';
import { requireAuth } from '@/common/auth-guard';
import { interviewController } from '@/modules/interview/interview.controller';

export const interviewRouter = Router();

interviewRouter.use(requireAuth);
interviewRouter.post('/', interviewController.create);
interviewRouter.post('/:id/answer', interviewController.answer);
interviewRouter.post('/:id/voice-ticket', interviewController.voiceTicket);
interviewRouter.get('/:id', interviewController.detail);
