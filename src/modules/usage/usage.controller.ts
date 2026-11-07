import type { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '@/db/prisma';
import { isEstimatedRate } from '@/config/pricing';
import { getUsdToInr } from './fx';

/** Shown in this order; any other provider that appears in the data is appended. */
const KNOWN_PROVIDERS = ['euri', 'deepgram'] as const;

/**
 * The window to report on. The browser sends it, already worked out in the
 * admin's own timezone ("today" is their midnight, not the server's). Omitted =
 * all time.
 */
const rangeQuery = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export const usageController = {
  /**
   * Everything the admin page needs for one time window: totals, spend per
   * provider with its models and steps, a per-day series, live-turn latency, and
   * the biggest spenders. All computed in SQL — there can be a lot of rows.
   */
  async summary(req: Request, res: Response) {
    const q = rangeQuery.parse(req.query);
    const from = q.from ?? new Date(0);
    const to = q.to ?? new Date(Date.now() + 60_000);
    const inWindow = { gte: from, lt: to };

    const [models, tasks, daily, topUsers, interviews, latency] = await Promise.all([
      prisma.usageEvent.groupBy({
        by: ['provider', 'kind', 'model'],
        where: { createdAt: inWindow },
        _sum: { costUsd: true, inputTokens: true, outputTokens: true, units: true },
        _count: true,
      }),

      prisma.usageEvent.groupBy({
        by: ['provider', 'kind', 'task'],
        where: { createdAt: inWindow },
        _sum: { costUsd: true },
        _count: true,
      }),

      prisma.$queryRaw<{ day: Date; provider: string; cost: number; calls: bigint }[]>`
        SELECT date_trunc('day', created_at) AS day,
               provider,
               SUM(cost_usd)::float8         AS cost,
               COUNT(*)                      AS calls
        FROM usage_events
        WHERE created_at >= ${from} AND created_at < ${to}
        GROUP BY 1, 2
        ORDER BY 1
      `,

      prisma.$queryRaw<{ userId: string | null; email: string | null; cost: number; calls: bigint }[]>`
        SELECT u.user_id                AS "userId",
               usr.email                AS email,
               SUM(u.cost_usd)::float8  AS cost,
               COUNT(*)                 AS calls
        FROM usage_events u
        LEFT JOIN users usr ON usr.id = u.user_id
        WHERE u.created_at >= ${from} AND u.created_at < ${to}
        GROUP BY 1, 2
        ORDER BY cost DESC
        LIMIT 5
      `,

      prisma.interview.count({ where: { createdAt: inWindow } }),

      // The number a candidate actually feels: how long a live turn's model call took.
      prisma.$queryRaw<{ p50: number | null; p95: number | null; max: number | null }[]>`
        SELECT
          percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms)::float8  AS p50,
          percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)::float8 AS p95,
          MAX(duration_ms)::float8                                          AS max
        FROM usage_events
        WHERE kind = 'llm' AND task IN ('evaluate', 'question')
          AND created_at >= ${from} AND created_at < ${to}
      `,
    ]);

    const seen = new Set(models.map((m) => m.provider));
    const providerIds = [
      ...KNOWN_PROVIDERS,
      ...[...seen].filter((p) => !(KNOWN_PROVIDERS as readonly string[]).includes(p)).sort(),
    ];

    const costOf = (id: string) =>
      models.filter((m) => m.provider === id).reduce((sum, m) => sum + (m._sum.costUsd ?? 0), 0);
    const callsOf = (id: string) =>
      models.filter((m) => m.provider === id).reduce((sum, m) => sum + m._count, 0);
    const totalUsd = providerIds.reduce((sum, id) => sum + costOf(id), 0);
    const totalCalls = providerIds.reduce((sum, id) => sum + callsOf(id), 0);

    const providers = providerIds.map((id) => {
      const idModels = models.filter((m) => m.provider === id);
      const usd = costOf(id);
      return {
        provider: id,
        usd,
        calls: callsOf(id),
        /** Share of all spend in the window, 0–1. */
        share: totalUsd > 0 ? usd / totalUsd : 0,
        models: idModels
          .map((m) => ({
            kind: m.kind,
            model: m.model,
            calls: m._count,
            inputTokens: m._sum.inputTokens ?? 0,
            outputTokens: m._sum.outputTokens ?? 0,
            units: m._sum.units ?? 0,
            costUsd: m._sum.costUsd ?? 0,
            /** True when we're guessing this model's rate — shown as a caveat. */
            estimated: id === 'euri' && isEstimatedRate(m.model),
          }))
          .sort((a, b) => b.costUsd - a.costUsd),
        tasks: tasks
          .filter((t) => t.provider === id)
          .map((t) => ({
            kind: t.kind,
            task: t.task ?? t.kind,
            calls: t._count,
            costUsd: t._sum.costUsd ?? 0,
          }))
          .sort((a, b) => b.costUsd - a.costUsd),
      };
    });

    // Fold the (day, provider) rows into one entry per day, split by provider.
    const days = new Map<string, { costUsd: number; calls: number; byProvider: Record<string, number> }>();
    for (const row of daily) {
      const key = row.day.toISOString().slice(0, 10);
      const entry = days.get(key) ?? { costUsd: 0, calls: 0, byProvider: {} };
      entry.costUsd += row.cost ?? 0;
      entry.calls += Number(row.calls);
      entry.byProvider[row.provider] = (entry.byProvider[row.provider] ?? 0) + (row.cost ?? 0);
      days.set(key, entry);
    }

    res.json({
      currency: await getUsdToInr(),
      totals: {
        usd: totalUsd,
        calls: totalCalls,
        interviews,
        perInterviewUsd: interviews ? totalUsd / interviews : 0,
      },
      providers,
      byDay: [...days.entries()].map(([day, entry]) => ({ day, ...entry })),
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
