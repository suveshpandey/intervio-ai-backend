import type { CookieOptions, Response } from 'express';
import { env } from '@/config/env';
import { refreshTtlSeconds } from '@/auth/token.service';

export const ACCESS_COOKIE = 'intervio_at';
export const REFRESH_COOKIE = 'intervio_rt';

// SameSite=None is required for cross-site cookies (frontend + backend on different
// origins), but only valid alongside Secure — so local http dev uses Lax.
const base: CookieOptions = {
  httpOnly: true,
  secure: env.COOKIE_SECURE,
  sameSite: env.COOKIE_SECURE ? 'none' : 'lax',
  domain: env.COOKIE_DOMAIN || undefined,
  path: '/',
};

export function setAuthCookies(res: Response, accessToken: string, refreshToken: string): void {
  res.cookie(ACCESS_COOKIE, accessToken, { ...base, maxAge: 15 * 60 * 1000 });
  // Refresh cookie is scoped to /auth so it's sent only to refresh + logout, not every request.
  res.cookie(REFRESH_COOKIE, refreshToken, {
    ...base,
    path: '/auth',
    maxAge: refreshTtlSeconds * 1000,
  });
}

export function clearAuthCookies(res: Response): void {
  res.clearCookie(ACCESS_COOKIE, { ...base });
  res.clearCookie(REFRESH_COOKIE, { ...base, path: '/auth' });
}
