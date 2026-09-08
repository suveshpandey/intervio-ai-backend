import { redis } from '@/db/redis';
import type { InterviewState } from '@/modules/interview/types';

/** Live state outlives a long interview but not forever — 4h is plenty. */
const TTL_SECONDS = 4 * 60 * 60;

const key = (interviewId: string) => `interview:${interviewId}:state`;

export const stateStore = {
  async save(state: InterviewState): Promise<void> {
    await redis.set(key(state.interviewId), JSON.stringify(state), 'EX', TTL_SECONDS);
  },

  async load(interviewId: string): Promise<InterviewState | null> {
    const raw = await redis.get(key(interviewId));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as InterviewState;
    } catch {
      return null;
    }
  },

  async clear(interviewId: string): Promise<void> {
    await redis.del(key(interviewId));
  },
};
