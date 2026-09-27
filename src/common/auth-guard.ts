import type { NextFunction, Request, Response } from 'express';
import { runWithContext } from '@/common/context';
import { unauthorized } from '@/common/errors';
import { verifyAccessToken } from '@/auth/token.service';
import { ACCESS_COOKIE } from '@/auth/cookies';

/** Rejects the request unless a valid access token cookie is present. */
export function requireAuth(req: Request, _res: Response, next: NextFunction): void {
  const token = req.cookies?.[ACCESS_COOKIE];
  if (!token) throw unauthorized('Not authenticated');

  const { sub } = verifyAccessToken(token);
  req.userId = sub;
  // Everything downstream (including metering) can now tell whose work this is.
  runWithContext({ userId: sub }, next);
}
