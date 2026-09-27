import { Router } from 'express';
import { requireAuth } from '@/common/auth-guard';
import { requireAdmin } from '@/common/admin-guard';
import { usageController } from '@/modules/usage/usage.controller';

export const adminRouter = Router();

adminRouter.use(requireAuth, requireAdmin);
adminRouter.get('/usage', usageController.summary);
