import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Just enough of a Redis sorted set for the quota code. */
const store = new Map<string, Map<string, number>>();
vi.mock('@/db/redis', () => {
  const set = (key: string) => store.get(key) ?? store.set(key, new Map()).get(key)!;
  return {
    redis: {
      zremrangebyscore: async (key: string, min: number, max: number) => {
        for (const [member, score] of set(key))
          if (score >= min && score <= max) set(key).delete(member);
      },
      zcard: async (key: string) => set(key).size,
      zrange: async (key: string) => {
        const [first] = [...set(key)].sort((a, b) => a[1] - b[1]);
        return first ? [first[0], String(first[1])] : [];
      },
      zadd: async (key: string, score: number, member: string) => set(key).set(member, score),
      pexpire: async () => 1,
    },
  };
});

const emails: Record<string, string> = { boss: 'boss@example.com', you: 'you@example.com' };
vi.mock('@/db/user.repository', () => ({
  userRepository: {
    findById: async (id: string) => (emails[id] ? { id, email: emails[id] } : null),
  },
}));
vi.mock('@/common/admin-guard', () => ({
  isAdminEmail: (email: string) => email === 'boss@example.com',
}));

const { requireQuota } = await import('@/common/quota');

const WIFI = '10.0.0.1';

/** Start one interview as this person; returns 'ok' or the refusal message. */
async function start(
  userId: string,
  deviceId: string,
  fingerprint: string,
  ip = WIFI,
): Promise<string> {
  const req = { userId, deviceId, fingerprint, ip } as unknown as Request;
  const res = Object.assign(new EventEmitter(), {
    statusCode: 201,
    locals: {},
  }) as unknown as Response;
  let error: Error | undefined;
  await requireQuota('interview')(req, res, (err?: unknown) => {
    error = err as Error | undefined;
  });
  if (error) return error.message;
  res.emit('finish'); // the route succeeded → the use is recorded
  await new Promise((r) => setTimeout(r, 0));
  return 'ok';
}

describe('daily quota', () => {
  beforeEach(() => store.clear());

  it('allows 3 a day per account, then refuses', async () => {
    for (let i = 0; i < 3; i++) expect(await start('you', 'd1', 'fp1')).toBe('ok');
    expect(await start('you', 'd1', 'fp1')).toMatch(/You've used today's 3 interviews/);
  });

  it('a new email in the same browser does not get a fresh allowance', async () => {
    for (let i = 0; i < 3; i++) await start('you', 'd1', 'fp1');
    expect(await start('alt', 'd1', 'fp1')).toMatch(/in this browser/);
  });

  it('a new email in incognito (new cookie, same device) is still refused', async () => {
    for (let i = 0; i < 3; i++) await start('you', 'd1', 'fp1');
    expect(await start('alt', 'd2', 'fp1')).toMatch(/on this device/);
  });

  it('a friend on the same wifi keeps their own allowance', async () => {
    for (let i = 0; i < 3; i++) await start('you', 'd1', 'fp1');
    expect(await start('friend', 'd3', 'fp3')).toBe('ok');
  });

  it('caps a whole network only at the high ceiling (scripts)', async () => {
    // 20 different "people" on one IP all succeed; the 21st is refused.
    for (let i = 0; i < 20; i++) expect(await start(`u${i}`, `d${i}`, `fp${i}`)).toBe('ok');
    expect(await start('u20', 'd20', 'fp20')).toMatch(/from this network/);
  });

  it('a failed request does not use up the allowance', async () => {
    const req = {
      userId: 'you',
      deviceId: 'd1',
      fingerprint: 'fp1',
      ip: WIFI,
    } as unknown as Request;
    for (let i = 0; i < 5; i++) {
      const res = Object.assign(new EventEmitter(), {
        statusCode: 500,
        locals: {},
      }) as unknown as Response;
      await requireQuota('interview')(req, res, () => undefined);
      res.emit('finish');
    }
    expect(await start('you', 'd1', 'fp1')).toBe('ok');
  });

  it('an admin is never limited and never counted', async () => {
    for (let i = 0; i < 10; i++) expect(await start('boss', 'd9', 'fp9')).toBe('ok');
    expect(store.size).toBe(0);
  });

  it('a non-admin on the same browser as an admin is still limited', async () => {
    for (let i = 0; i < 5; i++) await start('boss', 'd1', 'fp1');
    for (let i = 0; i < 3; i++) expect(await start('you', 'd1', 'fp1')).toBe('ok');
    expect(await start('you', 'd1', 'fp1')).toMatch(/You've used today's 3 interviews/);
  });

  it('a response marked quotaFree (going back into a waiting interview) is not counted', async () => {
    const req = {
      userId: 'you',
      deviceId: 'd1',
      fingerprint: 'fp1',
      ip: WIFI,
    } as unknown as Request;
    for (let i = 0; i < 5; i++) {
      const res = Object.assign(new EventEmitter(), {
        statusCode: 200,
        locals: { quotaFree: true },
      }) as unknown as Response;
      await requireQuota('interview')(req, res, () => undefined);
      res.emit('finish');
    }
    await new Promise((r) => setTimeout(r, 0));
    for (let i = 0; i < 3; i++) expect(await start('you', 'd1', 'fp1')).toBe('ok');
  });
});
