import { Router } from 'express';
import { requireAuth } from '@/common/auth-guard';
import { plannerController } from '@/modules/planner/planner.controller';
import { requireQuota } from '@/common/quota';
import { requireDailyBudget } from '@/modules/usage/guards';

export const blueprintRouter = Router();

blueprintRouter.use(requireAuth);
// Each plan is a call to the big model — 3 a day per person (common/quota.ts).
blueprintRouter.post('/', requireQuota('plan'), requireDailyBudget, plannerController.create);
blueprintRouter.get('/:id', plannerController.detail);
