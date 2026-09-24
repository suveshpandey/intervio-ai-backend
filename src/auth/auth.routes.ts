import { Router } from 'express';
import { requireAuth } from '@/common/auth-guard';
import { googleOAuthEnabled } from '@/config/env';
import { authController } from '@/auth/auth.controller';
import { rateLimit, byIpAndEmail } from '@/common/rate-limit';

/** Guessing a password or spamming reset mail — counted per IP AND per address. */
const authAttempts = rateLimit({
  name: 'auth',
  limit: 10,
  windowSec: 15 * 60,
  by: byIpAndEmail,
  message: 'Too many attempts. Wait a few minutes and try again.',
});

export const authRouter = Router();

authRouter.post('/signup', authAttempts, authController.signup);
authRouter.post('/login', authAttempts, authController.login);
authRouter.post('/refresh', authController.refresh);
authRouter.post('/logout', authController.logout);
authRouter.get('/me', requireAuth, authController.me);
authRouter.patch('/me', requireAuth, authController.updateMe);
authRouter.delete('/me', requireAuth, authController.deleteMe);
authRouter.post('/change-password', requireAuth, authController.changePassword);
authRouter.post('/forgot-password', authAttempts, authController.forgotPassword);
authRouter.post('/reset-password', authAttempts, authController.resetPassword);

if (googleOAuthEnabled) {
  authRouter.get('/google', authController.googleStart);
  authRouter.get('/google/callback', authController.googleCallback);
}
