import type { NextFunction, Request, Response } from 'express';
import { env } from '@/config/env';
import { forbidden, unauthorized } from '@/common/errors';
import { userRepository } from '@/db/user.repository';
import { logger } from '@/common/logger';

/**
 * Admin is an env allowlist, not a database flag: there is no UI to grant it, so
 * a compromised account can never promote itself, and an empty list (the
 * default) means nobody gets in.
 */
const admins = new Set(
  env.ADMIN_EMAILS.split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean),
);

export async function requireAdmin(req: Request, _res: Response, next: NextFunction): Promise<void> {
  if (!req.userId) throw unauthorized('Not authenticated');

  const user = await userRepository.findById(req.userId);
  if (!user || !admins.has(user.email.toLowerCase())) {
    logger.warn({ userId: req.userId }, 'non-admin tried to open the admin page');
    throw forbidden('Not allowed');
  }
  next();
}

/** So the frontend can hide the nav entry rather than link people to a 403. */
export const isAdminEmail = (email: string): boolean => admins.has(email.toLowerCase());
