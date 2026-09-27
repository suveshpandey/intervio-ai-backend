import type { Request, Response } from 'express';
import { prisma } from '@/db/prisma';
import { USD_TO_INR, isEstimatedRate } from '@/config/pricing';

/** Rows older than this aren't shown; the admin view is about what's happening now. */
const WINDOW_DAYS = 30;

const since = (days: number) => new Date(Date.now() - days * 86_400_000);

export const usageController = {
  /**
   * Everything the admin page needs, in one request: totals, a per-day series,
   * the breakdown by model and by task, live-turn latency, and the biggest
   * spenders. All computed in SQL — there can be a lot of rows.
   */
  async summary(_req: Request, res: Response) {
    const from = since(WINDOW_DAYS);

    const [totals, today, week, byModel, byTask, byDay, topUsers, interviews, latency] =
      await Promise.all([
        prisma.usageEvent.aggregate({ _sum: { costUsd: true }, _count: true }),
        prisma.usageEvent.aggregate({ where: { createdAt: { gte: since(1) } }, _sum: { costUsd: true } }),
        prisma.usageEvent.aggregate({ where: { createdAt: { gte: since(7) } }, _sum: { costUsd: true } }),

        prisma.usageEvent.groupBy({
          by: ['provider', 'model'],
          where: { createdAt: { gte: from } },
          _sum: { costUsd: true, inputTokens: true, outputTokens: true, units: true },
          _count: true,
        }),

        prisma.usageEvent.groupBy({
          by: ['kind', 'task'],
          where: { createdAt: { gte: from } },
          _sum: { costUsd: true },
          _count: true,
        }),

        prisma.$queryRaw<{ day: Date; cost: number; calls: bigint }[]>`
          SELECT date_trunc('day', created_at) AS day,
                 SUM(cost_usd)::float8        AS cost,
                 COUNT(*)                     AS calls
          FROM usage_events
          WHERE created_at >= ${from}
          GROUP BY 1
          ORDER BY 1
        `,

        prisma.$queryRaw<{ userId: string | null; email: string | null; cost: number; calls: bigint }[]>`
          SELECT u.user_id                AS "userId",
                 usr.email                AS email,
                 SUM(u.cost_usd)::float8  AS cost,
                 COUNT(*)                 AS calls
          FROM usage_events u
          LEFT JOIN users usr ON usr.id = u.user_id
          WHERE u.created_at >= ${from}
          GROUP BY 1, 2
          ORDER BY cost DESC
          LIMIT 10
        `,

        prisma.interview.count({ where: { createdAt: { gte: from } } }),

        // The number a candidate actually feels: how long a live turn's model call took.
        prisma.$queryRaw<{ p50: number; p95: number; max: number }[]>`
          SELECT
            percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms)::float8  AS p50,
            percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)::float8 AS p95,
            MAX(duration_ms)::float8                                          AS max
          FROM usage_events
          WHERE kind = 'llm' AND task IN ('evaluate', 'question') AND created_at >= ${from}
        `,
      ]);

    const spendPerInterview = interviews
      ? (byModel.reduce((sum, row) => sum + (row._sum.costUsd ?? 0), 0) / interviews)
      : 0;

    res.json({
      currency: { usdToInr: USD_TO_INR },
      windowDays: WINDOW_DAYS,
      totals: {
        allTimeUsd: totals._sum.costUsd ?? 0,
        allTimeCalls: totals._count,
        todayUsd: today._sum.costUsd ?? 0,
        weekUsd: week._sum.costUsd ?? 0,
        interviews,
        perInterviewUsd: spendPerInterview,
      },
      byModel: byModel
        .map((row) => ({
          provider: row.provider,
          model: row.model,
          calls: row._count,
          inputTokens: row._sum.inputTokens ?? 0,
          outputTokens: row._sum.outputTokens ?? 0,
          units: row._sum.units ?? 0,
          costUsd: row._sum.costUsd ?? 0,
          /** True when we're guessing this model's rate — shown as a caveat. */
          estimated: row.provider === 'euri' && isEstimatedRate(row.model),
        }))
        .sort((a, b) => b.costUsd - a.costUsd),
      byTask: byTask
        .map((row) => ({
          kind: row.kind,
          task: row.task ?? row.kind,
          calls: row._count,
          costUsd: row._sum.costUsd ?? 0,
        }))
        .sort((a, b) => b.costUsd - a.costUsd),
      byDay: byDay.map((row) => ({
        day: row.day.toISOString().slice(0, 10),
        costUsd: row.cost ?? 0,
        calls: Number(row.calls),
      })),
      topUsers: topUsers.map((row) => ({
        userId: row.userId,
        // A deleted account keeps its spend on the books but loses its name.
        email: row.email ?? 'deleted account',
        costUsd: row.cost ?? 0,
        calls: Number(row.calls),
      })),
      turnLatencyMs: {
        p50: latency[0]?.p50 ?? 0,
        p95: latency[0]?.p95 ?? 0,
        max: latency[0]?.max ?? 0,
      },
    });
  },
};
