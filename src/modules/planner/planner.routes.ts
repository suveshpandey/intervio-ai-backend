import { Router } from 'express';
import { requireAuth } from '@/common/auth-guard';
import { plannerController } from '@/modules/planner/planner.controller';

export const blueprintRouter = Router();

blueprintRouter.use(requireAuth);
// Building a plan is free (rules, no LLM), so it needs no quota; starting the interview does.
blueprintRouter.post('/', plannerController.create);
blueprintRouter.get('/:id', plannerController.detail);
