import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { AppError } from '@/common/errors';
import { logger } from '@/common/logger';

/** Central error handler. Express 5 forwards async throws here automatically. */
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof AppError) {
    res.status(err.status).json({ error: err.message, code: err.code });
    return;
  }

  if (err instanceof ZodError) {
    res.status(400).json({ error: 'Validation failed', details: err.flatten().fieldErrors });
    return;
  }

  logger.error({ err }, 'Unhandled error');
  res.status(500).json({ error: 'Internal server error' });
}

/** 404 for unmatched routes. */
export function notFoundHandler(_req: Request, res: Response) {
  res.status(404).json({ error: 'Not found' });
}

/** Read a required route param as a string (Express 5 types params as string | string[]). */
export function param(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== 'string') throw new AppError(400, `Missing route parameter: ${name}`, 'bad_param');
  return value;
}
