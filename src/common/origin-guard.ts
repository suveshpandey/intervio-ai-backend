import type { NextFunction, Request, Response } from 'express';
import { corsOrigins } from '@/config/env';
import { forbidden } from '@/common/errors';
import { logger } from '@/common/logger';

/** Requests that can't change anything don't need checking. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defence for state-changing requests.
 *
 * Session cookies are SameSite=none in production (the API and the app are on
 * different origins), so the browser attaches them to cross-site requests. A
 * POST that carries a JSON body is protected by CORS preflight, but a body-less
 * one — logout, end-interview — is a "simple request": no preflight, cookies
 * included, and any page on the internet could fire it at a logged-in visitor.
 *
 * CORS decides who may READ the response; it does not stop the request landing.
 * This does.
 */
export function checkOrigin(req: Request, _res: Response, next: NextFunction): void {
  if (SAFE_METHODS.has(req.method)) return next();

  const origin = req.headers.origin;
  // Same-origin and server-to-server callers (curl, health checks) send no Origin.
  if (!origin) return next();

  if (!corsOrigins.includes(origin)) {
    logger.warn({ origin, path: req.path, method: req.method }, 'blocked cross-origin write');
    throw forbidden('Cross-origin request blocked');
  }
  next();
}
