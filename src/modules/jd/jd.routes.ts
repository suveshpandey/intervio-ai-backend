import { Router } from 'express';
import { requireAuth } from '@/common/auth-guard';
import { jdController } from '@/modules/jd/jd.controller';

export const jdRouter = Router();

jdRouter.use(requireAuth);
jdRouter.post('/', jdController.create);
jdRouter.get('/:id', jdController.detail);
