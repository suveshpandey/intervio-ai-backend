import type { Request, Response } from 'express';
import { prisma } from '@/db/prisma';
import { isEstimatedRate } from '@/config/pricing';
import { getUsdToInr } from './fx';

/** Rows older than this aren't shown; the admin view is about what's happening now. */
const WINDOW_DAYS = 30;

const since = (days: number) => new Date(Date.now() - days * 86_400_000);

/** Shown in this order; any other provider that appears in the data is appended. */
const KNOWN_PROVIDERS = ['euri', 'deepgram'] as const;

interface Period {
  usd: number;
  calls: number;
}

const emptyPeriod = (): Period => ({ usd: 0, calls: 0 });

export const usageController = {
  /**
   * Everything the admin page needs, in one request: overall totals, a per-day
   * series, spend split by provider (euri = LLM, deepgram = voice) with each
   * provider's own models and steps, live-turn latency, and the biggest
   * spenders. All computed in SQL — there can be a lot of rows.
   */
  async summary(_req: Request, res: Response) {
    const from = since(WINDOW_DAYS);
    const dayAgo = since(1);
    const weekAgo = since(7);

    const [periods, models, tasks, daily, topUsers, interviews, latency] = await Promise.all([
      // One pass per provider for all four periods.
      prisma.$queryRaw<
        {
          provider: string;
          todayUsd: number;
          todayCalls: bigint;
          weekUsd: number;
          weekCalls: bigint;
          windowUsd: number;
          windowCalls: bigint;
          allUsd: number;
          allCalls: bigint;
        }[]
      >`
        SELECT provider,
               COALESCE(SUM(cost_usd) FILTER (WHERE created_at >= ${dayAgo}), 0)::float8  AS "todayUsd",
               COUNT(*) FILTER (WHERE created_at >= ${dayAgo})                            AS "todayCalls",
               COALESCE(SUM(cost_usd) FILTER (WHERE created_at >= ${weekAgo}), 0)::float8 AS "weekUsd",
               COUNT(*) FILTER (WHERE created_at >= ${weekAgo})                           AS "weekCalls",
               COALESCE(SUM(cost_usd) FILTER (WHERE created_at >= ${from}), 0)::float8    AS "windowUsd",
               COUNT(*) FILTER (WHERE created_at >= ${from})                              AS "windowCalls",
               COALESCE(SUM(cost_usd), 0)::float8                                         AS "allUsd",
               COUNT(*)                                                                   AS "allCalls"
        FROM usage_events
        GROUP BY provider
      `,

      prisma.usageEvent.groupBy({
        by: ['provider', 'kind', 'model'],
        where: { createdAt: { gte: from } },
        _sum: { costUsd: true, inputTokens: true, outputTokens: true, units: true },
        _count: true,
      }),

      prisma.usageEvent.groupBy({
        by: ['provider', 'kind', 'task'],
        where: { createdAt: { gte: from } },
        _sum: { costUsd: true },
        _count: true,
      }),

      prisma.$queryRaw<{ day: Date; provider: string; cost: number; calls: bigint }[]>`
        SELECT date_trunc('day', created_at) AS day,
               provider,
               SUM(cost_usd)::float8         AS cost,
               COUNT(*)                      AS calls
        FROM usage_events
        WHERE created_at >= ${from}
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

    const seen = new Set<string>([
      ...periods.map((r) => r.provider),
      ...models.map((r) => r.provider),
    ]);
    const providerIds = [
      ...KNOWN_PROVIDERS,
      ...[...seen].filter((p) => !(KNOWN_PROVIDERS as readonly string[]).includes(p)).sort(),
    ];

    const windowTotalUsd = periods.reduce((sum, r) => sum + r.windowUsd, 0);

    const providers = providerIds.map((id) => {
      const row = periods.find((r) => r.provider === id);
      const idModels = models.filter((m) => m.provider === id);

      const sumUnits = (kind: string) =>
        idModels.filter((m) => m.kind === kind).reduce((sum, m) => sum + (m._sum.units ?? 0), 0);

      const windowUsd = row?.windowUsd ?? 0;

      return {
        provider: id,
        today: row ? { usd: row.todayUsd, calls: Number(row.todayCalls) } : emptyPeriod(),
        week: row ? { usd: row.weekUsd, calls: Number(row.weekCalls) } : emptyPeriod(),
        window: row ? { usd: windowUsd, calls: Number(row.windowCalls) } : emptyPeriod(),
        allTime: row ? { usd: row.allUsd, calls: Number(row.allCalls) } : emptyPeriod(),
        /** Share of all spend in the window, 0–1. */
        share: windowTotalUsd > 0 ? windowUsd / windowTotalUsd : 0,
        /** Raw volume in the window, so each provider's cost can be sanity-checked. */
        volume: {
          inputTokens: idModels.reduce((sum, m) => sum + (m._sum.inputTokens ?? 0), 0),
          outputTokens: idModels.reduce((sum, m) => sum + (m._sum.outputTokens ?? 0), 0),
          sttSeconds: sumUnits('stt'),
          ttsChars: sumUnits('tts'),
        },
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

    const sum = (pick: (p: (typeof providers)[number]) => Period) =>
      providers.reduce(
        (acc, p) => ({ usd: acc.usd + pick(p).usd, calls: acc.calls + pick(p).calls }),
        emptyPeriod(),
      );
    const allTime = sum((p) => p.allTime);

    res.json({
      currency: await getUsdToInr(),
      windowDays: WINDOW_DAYS,
      totals: {
        allTimeUsd: allTime.usd,
        allTimeCalls: allTime.calls,
        todayUsd: sum((p) => p.today).usd,
        weekUsd: sum((p) => p.week).usd,
        interviews,
        perInterviewUsd: interviews ? windowTotalUsd / interviews : 0,
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
