import { redis } from '@/db/redis';
import { refreshTtlSeconds } from '@/auth/token.service';

// Refresh tokens are tracked by jti so they can be rotated and revoked.
// Key: refresh:<userId>:<jti> -> "1", expiring with the token.
const key = (userId: string, jti: string) => `refresh:${userId}:${jti}`;

export const refreshStore = {
  async add(userId: string, jti: string): Promise<void> {
    await redis.set(key(userId, jti), '1', 'EX', refreshTtlSeconds);
  },

  async exists(userId: string, jti: string): Promise<boolean> {
    return (await redis.exists(key(userId, jti))) === 1;
  },

  async remove(userId: string, jti: string): Promise<void> {
    await redis.del(key(userId, jti));
  },

  /** Revoke every session for a user (used on refresh-token reuse detection + logout-all). */
  async removeAll(userId: string): Promise<void> {
    const keys = await redis.keys(`refresh:${userId}:*`);
    if (keys.length) await redis.del(...keys);
  },
};
