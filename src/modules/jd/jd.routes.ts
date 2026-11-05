import { Router } from 'express';
import { requireAuth } from '@/common/auth-guard';
import { jdController } from '@/modules/jd/jd.controller';
import { rateLimit } from '@/common/rate-limit';
import { requireDailyBudget } from '@/modules/usage/guards';

export const jdRouter = Router();

jdRouter.use(requireAuth);
jdRouter.post(
  '/',
  rateLimit({ name: 'jd', limit: 20, windowSec: 24 * 60 * 60 }),
  requireDailyBudget,
  jdController.create,
);
jdRouter.get('/:id', jdController.detail);
