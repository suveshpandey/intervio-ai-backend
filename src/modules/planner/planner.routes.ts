import { Router } from 'express';
import { requireAuth } from '@/common/auth-guard';
import { plannerController } from '@/modules/planner/planner.controller';

export const blueprintRouter = Router();

blueprintRouter.use(requireAuth);
blueprintRouter.post('/', plannerController.create);
blueprintRouter.get('/:id', plannerController.detail);
