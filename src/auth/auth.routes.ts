import { Router } from 'express';
import { requireAuth } from '@/common/auth-guard';
import { googleOAuthEnabled } from '@/config/env';
import { authController } from '@/auth/auth.controller';

export const authRouter = Router();

authRouter.post('/signup', authController.signup);
authRouter.post('/login', authController.login);
authRouter.post('/refresh', authController.refresh);
authRouter.post('/logout', authController.logout);
authRouter.get('/me', requireAuth, authController.me);
authRouter.patch('/me', requireAuth, authController.updateMe);
authRouter.post('/change-password', requireAuth, authController.changePassword);
authRouter.post('/forgot-password', authController.forgotPassword);
authRouter.post('/reset-password', authController.resetPassword);

if (googleOAuthEnabled) {
  authRouter.get('/google', authController.googleStart);
  authRouter.get('/google/callback', authController.googleCallback);
}
