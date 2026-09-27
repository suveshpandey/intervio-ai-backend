import { Router } from 'express';
import { requireAuth } from '@/common/auth-guard';
import { jdController } from '@/modules/jd/jd.controller';
import { rateLimit } from '@/common/rate-limit';

export const jdRouter = Router();

jdRouter.use(requireAuth);
jdRouter.post('/', rateLimit({ name: 'jd', limit: 30, windowSec: 60 * 60 }), jdController.create);
jdRouter.get('/:id', jdController.detail);
