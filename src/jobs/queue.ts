import { Queue } from 'bullmq';
import { env } from '@/config/env';

// BullMQ needs its own Redis connection with blocking commands enabled.
export const bullConnection = { url: env.REDIS_URL, maxRetriesPerRequest: null };

export interface ParseJobData {
  resumeId: string;
}

export const parseQueue = new Queue<ParseJobData>('resume-parse', { connection: bullConnection });

export async function enqueueParse(resumeId: string): Promise<void> {
  await parseQueue.add(
    'parse',
    { resumeId },
    { attempts: 2, backoff: { type: 'exponential', delay: 3000 }, removeOnComplete: 100, removeOnFail: 200 },
  );
}
