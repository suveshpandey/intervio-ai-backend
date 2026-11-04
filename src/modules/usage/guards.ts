/**
 * Service-wide emergency brake (off by default): once today's metered spend
 * passes DAILY_SPEND_LIMIT_USD, new costly work is refused; interviews already
 * running carry on. Per-person allowances live in common/quota.ts.
 */

import type { NextFunction, Request, Response } from 'express';
import { prisma } from '@/db/prisma';
import { redis } from '@/db/redis';
import { env } from '@/config/env';
import { AppError } from '@/common/errors';
import { logger } from '@/common/logger';

/** Today's spend is re-summed at most this often; the sum is a small indexed scan. */
const SPEND_CACHE_SEC = 60;

/** Metered spend since 00:00 UTC, in dollars. Cached briefly in Redis. */
export async function spendToday(): Promise<number> {
  const key = 'guard:spend-today';
  try {
    const cached = await redis.get(key);
    if (cached !== null) return Number(cached);
  } catch {
    /* fall through to the database */
  }

  const midnight = new Date();
  midnight.setUTCHours(0, 0, 0, 0);
  const { _sum } = await prisma.usageEvent.aggregate({
    where: { createdAt: { gte: midnight } },
    _sum: { costUsd: true },
  });
  const total = _sum.costUsd ?? 0;

  await redis.set(key, String(total), 'EX', SPEND_CACHE_SEC).catch(() => undefined);
  return total;
}

/** Refuse new costly work once the service's daily budget is spent. */
export async function assertDailyBudget(): Promise<void> {
  const limit = env.DAILY_SPEND_LIMIT_USD;
  if (limit <= 0) return;

  const spent = await spendToday();
  if (spent < limit) return;

  logger.warn({ spent, limit }, 'daily spend limit reached — refusing new work');
  throw new AppError(
    503,
    'Intervio is at capacity for today. Please try again tomorrow.',
    'daily_capacity_reached',
  );
}

/** Route middleware form of assertDailyBudget. */
export async function requireDailyBudget(
  _req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    await assertDailyBudget();
    next();
  } catch (err) {
    next(err);
  }
}
