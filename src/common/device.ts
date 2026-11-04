/**
 * Identifies the BROWSER making a request, for the daily quotas (common/quota.ts).
 *
 * Two signals, because each one alone is easy to shed:
 *  - Browser ID: a random id in a long-lived httpOnly cookie. Different for every
 *    browser, so people sharing a wifi don't share an allowance. Cleared by
 *    clearing cookies or by an incognito window.
 *  - Fingerprint: a hash the frontend computes from stable traits of the device
 *    (lib/fingerprint.ts), sent as a header. Usually survives cleared cookies and
 *    incognito. It's client-supplied, so a script can fake it; the per-IP
 *    ceiling in quota.ts is what stops scripts.
 *
 * Neither is a secret or an identity; they only key usage counters.
 */

import { randomUUID } from 'node:crypto';
import type { CookieOptions, NextFunction, Request, Response } from 'express';
import { env } from '@/config/env';

export const DEVICE_COOKIE = 'intervio_did';
export const FINGERPRINT_HEADER = 'x-intervio-fp';

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_HEX = /^[0-9a-f]{64}$/;

// Same cross-site rules as the auth cookies (auth/cookies.ts).
const cookieOptions: CookieOptions = {
  httpOnly: true,
  secure: env.COOKIE_SECURE,
  sameSite: env.COOKIE_SECURE ? 'none' : 'lax',
  domain: env.COOKIE_DOMAIN || undefined,
  path: '/',
  maxAge: ONE_YEAR_MS,
};

/** Attaches req.deviceId (issuing the cookie on first sight) and req.fingerprint. */
export function identifyDevice(req: Request, res: Response, next: NextFunction): void {
  const existing: unknown = req.cookies?.[DEVICE_COOKIE];
  if (typeof existing === 'string' && UUID.test(existing)) {
    req.deviceId = existing.toLowerCase();
  } else {
    req.deviceId = randomUUID();
    res.cookie(DEVICE_COOKIE, req.deviceId, cookieOptions);
  }

  const fp = req.get(FINGERPRINT_HEADER)?.toLowerCase();
  req.fingerprint = fp && SHA256_HEX.test(fp) ? fp : undefined;

  next();
}
