import { Router } from 'express';
import { requireAuth } from '@/common/auth-guard';
import { plannerController } from '@/modules/planner/planner.controller';
import { rateLimit } from '@/common/rate-limit';

export const blueprintRouter = Router();

blueprintRouter.use(requireAuth);
// Each plan is a call to the big model — cap it.
blueprintRouter.post(
  '/',
  rateLimit({ name: 'blueprint', limit: 30, windowSec: 60 * 60 }),
  plannerController.create,
);
blueprintRouter.get('/:id', plannerController.detail);
