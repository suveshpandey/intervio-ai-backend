import { USD_TO_INR } from '@/config/pricing';
import { logger } from '@/common/logger';

export interface FxRate {
  usdToInr: number;
  /** Where the number came from — "fallback" means the fixed PRD rate in pricing.ts. */
  source: 'frankfurter' | 'open.er-api' | 'fallback';
  /** ISO timestamp of when we fetched it. */
  fetchedAt: string;
}

const TTL_MS = 6 * 60 * 60 * 1000;
/** After a total failure, retry sooner than the full TTL but not on every request. */
const RETRY_MS = 5 * 60 * 1000;
const TIMEOUT_MS = 4000;

let cached: { rate: FxRate; expiresAt: number } | null = null;
let inflight: Promise<FxRate> | null = null;

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const isRate = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 10 && n < 1000;

/** Both providers are free and keyless. Frankfurter serves ECB reference rates. */
const SOURCES: { name: 'frankfurter' | 'open.er-api'; run: () => Promise<number | undefined> }[] = [
  {
    name: 'frankfurter',
    run: async () =>
      ((await getJson('https://api.frankfurter.dev/v1/latest?base=USD&symbols=INR')) as { rates?: { INR?: number } })
        .rates?.INR,
  },
  {
    name: 'open.er-api',
    run: async () =>
      ((await getJson('https://open.er-api.com/v6/latest/USD')) as { rates?: { INR?: number } }).rates?.INR,
  },
];

async function load(): Promise<FxRate> {
  for (const source of SOURCES) {
    try {
      const value = await source.run();
      if (isRate(value)) {
        return { usdToInr: value, source: source.name, fetchedAt: new Date().toISOString() };
      }
      throw new Error('unexpected response shape');
    } catch (err) {
      logger.warn({ err, source: source.name }, 'FX rate fetch failed');
    }
  }
  return { usdToInr: USD_TO_INR, source: 'fallback', fetchedAt: new Date().toISOString() };
}

/**
 * Live USD→INR for display only. Never throws: cached for 6h, and on failure
 * keeps the last good rate (or the fixed one) so the admin page always renders.
 */
export async function getUsdToInr(): Promise<FxRate> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.rate;

  inflight ??= load()
    .then((rate) => {
      // Don't let a failed refresh replace a real rate we already have.
      const keep = rate.source === 'fallback' && cached && cached.rate.source !== 'fallback';
      const next = keep ? cached!.rate : rate;
      cached = { rate: next, expiresAt: Date.now() + (rate.source === 'fallback' ? RETRY_MS : TTL_MS) };
      return next;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}
