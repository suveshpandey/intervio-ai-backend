/**
 * Per-user (or per-IP) rate limiting, in Redis.
 *
 * The expensive routes here don't just cost CPU — an upload is two LLM calls, an
 * interview is a live Deepgram session. Without a cap, one person with a loop
 * can run up a real bill, and the auth routes can be brute-forced.
 *
 * Fixed window, because it is one command and easy to reason about; a sliding
 * window would be more precise than this problem needs.
 */

import type { NextFunction, Request, Response } from 'express';
import { redis } from '@/db/redis';
import { AppError } from '@/common/errors';
import { logger } from '@/common/logger';
import { env, isProd } from '@/config/env';

export interface RateLimitOptions {
  /** Short name; also the Redis key prefix. */
  name: string;
  limit: number;
  windowSec: number;
  /**
   * What to count per. Defaults to the signed-in user, falling back to IP.
   * Returning null skips the limit for this request (see byClientIp).
   */
  by?: (req: Request) => string | null;
  /** Shown to the user when they hit the cap. */
  message?: string;
}

const identify = (req: Request): string => req.userId ?? req.ip ?? 'unknown';

export function rateLimit({ name, limit, windowSec, by = identify, message }: RateLimitOptions) {
  return async function rateLimiter(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const id = by(req);
    if (id === null) return next();
    const key = `rl:${name}:${id}`;

    try {
      const count = await redis.incr(key);
      // First hit in this window starts the clock.
      if (count === 1) await redis.expire(key, windowSec);

      if (count > limit) {
        const ttl = await redis.ttl(key);
        const retryAfter = ttl > 0 ? ttl : windowSec;
        res.setHeader('Retry-After', String(retryAfter));
        logger.warn({ name, id, count }, 'rate limit hit');
        throw new AppError(
          429,
          message ?? `Too many requests. Try again in ${Math.ceil(retryAfter / 60)} minute(s).`,
          'rate_limited',
        );
      }
    } catch (err) {
      if (err instanceof AppError) return next(err);
      // Redis down: log it, but never lock people out of the product.
      logger.error({ err, name }, 'rate limiter unavailable — allowing the request');
    }

    next();
  };
}

/**
 * Auth routes are counted per IP AND per submitted email, so one attacker can't
 * spread attempts across accounts, and one account can't be hammered from
 * many addresses.
 */
export const byIpAndEmail = (req: Request): string => {
  const email = typeof req.body?.email === 'string' ? req.body.email.toLowerCase().trim() : '';
  return `${req.ip ?? 'unknown'}:${email}`;
};

/**
 * Count per client network, for limits that must hold across accounts.
 *
 * Behind a proxy (Render) req.ip is only the real client when TRUST_PROXY_HOPS
 * is set; otherwise every user shares the proxy's address and one shared counter
 * would lock everybody out. So in production without it, IP-only limits stand
 * down (and say so once) rather than block the whole service.
 */
let warnedNoProxy = false;
export const byClientIp = (req: Request): string | null => {
  if (isProd && env.TRUST_PROXY_HOPS === 0) {
    if (!warnedNoProxy) {
      warnedNoProxy = true;
      logger.warn('TRUST_PROXY_HOPS is 0 in production — per-IP limits are disabled');
    }
    return null;
  }
  return req.ip ?? 'unknown';
};
