/**
 * Daily usage quotas for the costly actions: starting an interview, analysing a
 * resume. (Plans cost nothing now — they're built by rule, not an LLM — so they
 * have no quota.)
 *
 * Each action is counted in several buckets over a rolling 24 hours, and is
 * refused when ANY of them is used up:
 *
 *   account      the signed-in user                        DAILY_* (3)
 *   browser      the browser-id cookie (common/device.ts)   DAILY_* (3)
 *   device       the device fingerprint header              DAILY_* (3)
 *   network      the client IP                              QUOTA_IP_CEILING (20)
 *
 * The browser and device buckets stop "use today's 3, sign up with another
 * email, go again". The network bucket is only a high ceiling against scripts,
 * so people sharing a wifi each keep their own allowance.
 *
 * Only SUCCESSFUL actions count: the check runs before the route, the use is
 * recorded after a 2xx response. A failed upload or a refused start costs nothing.
 *
 * Admins (ADMIN_EMAILS) skip every bucket and are not counted.
 *
 * Rolling window = a Redis sorted set of timestamps per key. Like the rate
 * limiter, this fails OPEN if Redis is down: an outage must not lock people out.
 */

import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { redis } from '@/db/redis';
import { env } from '@/config/env';
import { AppError } from '@/common/errors';
import { logger } from '@/common/logger';
import { byClientIp } from '@/common/rate-limit';
import { isAdminEmail } from '@/common/admin-guard';
import { userRepository } from '@/db/user.repository';

export type QuotaName = 'interview' | 'resume';

const DAY_MS = 24 * 60 * 60 * 1000;

const LIMIT: Record<QuotaName, () => number> = {
  interview: () => env.DAILY_INTERVIEWS,
  resume: () => env.DAILY_RESUMES,
};

const NOUN: Record<QuotaName, [one: string, many: string]> = {
  interview: ['interview', 'interviews'],
  resume: ['resume analysis', 'resume analyses'],
};

type Scope = 'account' | 'browser' | 'device' | 'network';

interface Bucket {
  key: string;
  scope: Scope;
  limit: number;
}

function bucketsFor(name: QuotaName, req: Request): Bucket[] {
  const perPerson = LIMIT[name]();
  const buckets: Bucket[] = [];
  const add = (scope: Scope, id: string | null | undefined, limit: number) => {
    if (id && limit > 0) buckets.push({ key: `quota:${name}:${scope}:${id}`, scope, limit });
  };
  add('account', req.userId, perPerson);
  add('browser', req.deviceId, perPerson);
  add('device', req.fingerprint, perPerson);
  // null when the real client IP isn't known (see byClientIp).
  add('network', byClientIp(req), env.QUOTA_IP_CEILING);
  return buckets;
}

const BLOCKED_WHERE: Record<Exclude<Scope, 'account'>, string> = {
  browser: 'in this browser',
  device: 'on this device',
  network: 'from this network',
};

const hoursUntil = (ms: number) => Math.max(1, Math.ceil(ms / (60 * 60 * 1000)));

/** Throws 429 if any bucket for this request has used today's allowance. */
async function assertQuota(name: QuotaName, req: Request): Promise<void> {
  if (LIMIT[name]() <= 0) return; // 0 = unlimited
  const now = Date.now();

  for (const { key, scope, limit } of bucketsFor(name, req)) {
    await redis.zremrangebyscore(key, 0, now - DAY_MS);
    const used = await redis.zcard(key);
    if (used < limit) continue;

    // The slot frees up 24h after the oldest use still in the window.
    const [, oldest] = await redis.zrange(key, 0, 0, 'WITHSCORES');
    const wait = hoursUntil(Number(oldest ?? now) + DAY_MS - now);
    const inHours = `about ${wait} hour${wait === 1 ? '' : 's'}`;
    const [one, many] = NOUN[name];
    const what = `${limit} ${limit === 1 ? one : many}`;
    logger.warn({ quota: name, scope, used, limit }, 'daily quota reached');
    throw new AppError(
      429,
      scope === 'account'
        ? `You've used today's ${what}. You can do another in ${inHours}.`
        : `Today's ${what} have already been used ${BLOCKED_WHERE[scope]}. Try again in ${inHours}.`,
      'daily_quota_reached',
    );
  }
}

/** Record one use against every bucket for this request. */
async function recordUse(name: QuotaName, req: Request): Promise<void> {
  const now = Date.now();
  for (const { key } of bucketsFor(name, req)) {
    await redis.zadd(key, now, `${now}:${randomUUID()}`);
    await redis.pexpire(key, DAY_MS);
  }
}

/** Admins (the ADMIN_EMAILS allowlist) are exempt; the email comes from the server-side session. */
async function isAdmin(req: Request): Promise<boolean> {
  if (!req.userId) return false;
  const user = await userRepository.findById(req.userId);
  return user ? isAdminEmail(user.email) : false;
}

/**
 * Route middleware: refuse when the allowance is spent; otherwise let the route
 * run and count it only if it succeeded.
 */
export function requireQuota(name: QuotaName) {
  return async function quota(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (await isAdmin(req)) return next();
      await assertQuota(name, req);
    } catch (err) {
      if (err instanceof AppError) return next(err);
      logger.error({ err, quota: name }, 'quota check unavailable — allowing the request');
      return next();
    }

    res.on('finish', () => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        recordUse(name, req).catch((err: unknown) =>
          logger.error({ err, quota: name }, 'failed to record quota use'),
        );
      }
    });
    next();
  };
}
