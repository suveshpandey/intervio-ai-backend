import type { Request, Response } from 'express';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { env } from '@/config/env';
import { badRequest, unauthorized } from '@/common/errors';
import { userRepository } from '@/db/user.repository';
import { authService, toPublicUser } from '@/auth/auth.service';
import { setAuthCookies, clearAuthCookies, REFRESH_COOKIE } from '@/auth/cookies';
import { exchangeGoogleCode, getGoogleAuthUrl } from '@/auth/google';

const credentialsSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  name: z.string().min(1).max(120).optional(),
});

const updateProfileSchema = z.object({
  name: z.string().trim().min(1, 'Name cannot be empty').max(120),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Enter your current password'),
  newPassword: z.string().min(8, 'New password must be at least 8 characters'),
});

const forgotPasswordSchema = z.object({
  email: z.string().email(),
});

const resetPasswordSchema = z.object({
  token: z.string().min(10),
  newPassword: z.string().min(8, 'New password must be at least 8 characters'),
});

const OAUTH_STATE_COOKIE = 'intervio_oauth_state';

export const authController = {
  async signup(req: Request, res: Response) {
    const { email, password, name } = credentialsSchema.parse(req.body);
    const { user, tokens } = await authService.signup(email, password, name);
    setAuthCookies(res, tokens.accessToken, tokens.refreshToken);
    res.status(201).json({ user: toPublicUser(user) });
  },

  async login(req: Request, res: Response) {
    const { email, password } = credentialsSchema.omit({ name: true }).parse(req.body);
    const { user, tokens } = await authService.login(email, password);
    setAuthCookies(res, tokens.accessToken, tokens.refreshToken);
    res.json({ user: toPublicUser(user) });
  },

  async refresh(req: Request, res: Response) {
    const token = req.cookies?.[REFRESH_COOKIE];
    if (!token) throw unauthorized('No refresh token');
    const tokens = await authService.refresh(token);
    setAuthCookies(res, tokens.accessToken, tokens.refreshToken);
    res.json({ ok: true });
  },

  async logout(req: Request, res: Response) {
    await authService.logout(req.cookies?.[REFRESH_COOKIE]);
    clearAuthCookies(res);
    res.json({ ok: true });
  },

  async me(req: Request, res: Response) {
    const user = req.userId ? await userRepository.findById(req.userId) : null;
    if (!user) throw unauthorized('Not authenticated');
    res.json({ user: toPublicUser(user) });
  },

  async updateMe(req: Request, res: Response) {
    if (!req.userId) throw unauthorized('Not authenticated');
    const { name } = updateProfileSchema.parse(req.body);
    const user = await authService.updateProfile(req.userId, { name });
    res.json({ user: toPublicUser(user) });
  },

  async changePassword(req: Request, res: Response) {
    if (!req.userId) throw unauthorized('Not authenticated');
    const { currentPassword, newPassword } = changePasswordSchema.parse(req.body);
    await authService.changePassword(req.userId, currentPassword, newPassword);
    res.json({ ok: true });
  },

  // ── Password reset (public) ────────────────────────────
  async forgotPassword(req: Request, res: Response) {
    const { email } = forgotPasswordSchema.parse(req.body);
    await authService.requestPasswordReset(email);
    // Always generic — never reveal whether the account exists.
    res.json({ ok: true });
  },

  async resetPassword(req: Request, res: Response) {
    const { token, newPassword } = resetPasswordSchema.parse(req.body);
    await authService.resetPassword(token, newPassword);
    res.json({ ok: true });
  },

  // ── Google OAuth ───────────────────────────────────────
  googleStart(_req: Request, res: Response) {
    const state = nanoid();
    res.cookie(OAUTH_STATE_COOKIE, state, {
      httpOnly: true,
      secure: env.COOKIE_SECURE,
      sameSite: 'lax',
      maxAge: 10 * 60 * 1000,
      path: '/auth',
    });
    res.redirect(getGoogleAuthUrl(state));
  },

  async googleCallback(req: Request, res: Response) {
    const code = typeof req.query.code === 'string' ? req.query.code : undefined;
    const state = typeof req.query.state === 'string' ? req.query.state : undefined;
    const expectedState = req.cookies?.[OAUTH_STATE_COOKIE];

    res.clearCookie(OAUTH_STATE_COOKIE, { path: '/auth' });

    if (!code) throw badRequest('Missing authorization code');
    if (!state || state !== expectedState) throw badRequest('Invalid OAuth state');

    const profile = await exchangeGoogleCode(code);
    const { tokens } = await authService.loginWithGoogle(profile);
    setAuthCookies(res, tokens.accessToken, tokens.refreshToken);
    res.redirect(env.OAUTH_SUCCESS_REDIRECT);
  },
};
