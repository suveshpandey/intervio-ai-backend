import { redis } from '@/db/redis';
import { refreshTtlSeconds } from '@/auth/token.service';

// Refresh tokens are tracked by jti so they can be rotated and revoked.
// Key: refresh:<userId>:<jti> -> "1", expiring with the token.
const key = (userId: string, jti: string) => `refresh:${userId}:${jti}`;
/** Index of a user's live jtis, so revoke-all never has to scan the keyspace. */
const indexKey = (userId: string) => `refresh:index:${userId}`;

export const refreshStore = {
  async add(userId: string, jti: string): Promise<void> {
    await redis
      .multi()
      .set(key(userId, jti), '1', 'EX', refreshTtlSeconds)
      .sadd(indexKey(userId), jti)
      .expire(indexKey(userId), refreshTtlSeconds)
      .exec();
  },

  async exists(userId: string, jti: string): Promise<boolean> {
    return (await redis.exists(key(userId, jti))) === 1;
  },

  async remove(userId: string, jti: string): Promise<void> {
    await redis.multi().del(key(userId, jti)).srem(indexKey(userId), jti).exec();
  },

  /**
   * Revoke every session for a user (reuse detection, logout-all, password
   * change/reset, account deletion).
   *
   * Was `KEYS refresh:<user>:*` — an O(keyspace) command that blocks the single
   * threaded Redis shared by rate limiting, interview state, tickets and queues,
   * and it was reachable on demand by replaying one stale refresh token.
   */
  async removeAll(userId: string): Promise<void> {
    const jtis = await redis.smembers(indexKey(userId));
    const keys = jtis.map((jti) => key(userId, jti));
    await redis.del(indexKey(userId), ...keys);
  },
};
