import { Router } from 'express';
import { requireAuth } from '@/common/auth-guard';
import { interviewController } from '@/modules/interview/interview.controller';

export const interviewRouter = Router();

interviewRouter.use(requireAuth);
interviewRouter.get('/', interviewController.list);
interviewRouter.post('/', interviewController.create);
interviewRouter.post('/:id/answer', interviewController.answer);
interviewRouter.post('/:id/voice-ticket', interviewController.voiceTicket);
interviewRouter.post('/:id/end', interviewController.end);
interviewRouter.get('/:id', interviewController.detail);
interviewRouter.get('/:id/report', interviewController.report);
