import { nanoid } from 'nanoid';
import { redis } from '@/db/redis';

// Password-reset tokens: single-use, short-lived. Key: pwreset:<token> -> userId.
const TTL_SECONDS = 60 * 60; // 1 hour
const key = (token: string) => `pwreset:${token}`;

export const resetStore = {
  /** Mint a single-use reset token for a user. */
  async create(userId: string): Promise<string> {
    const token = nanoid(48);
    await redis.set(key(token), userId, 'EX', TTL_SECONDS);
    return token;
  },

  /** Return the userId for a token and immediately invalidate it (single use). */
  async consume(token: string): Promise<string | null> {
    const k = key(token);
    const userId = await redis.get(k);
    if (userId) await redis.del(k);
    return userId;
  },
};
