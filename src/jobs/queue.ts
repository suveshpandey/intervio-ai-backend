import { Queue } from 'bullmq';
import { env } from '@/config/env';

// BullMQ needs its own Redis connection with blocking commands enabled.
export const bullConnection = { url: env.REDIS_URL, maxRetriesPerRequest: null };

export interface ParseJobData {
  resumeId: string;
}

export interface ReportJobData {
  interviewId: string;
  userId: string;
}

export const parseQueue = new Queue<ParseJobData>('resume-parse', { connection: bullConnection });

export async function enqueueParse(resumeId: string): Promise<void> {
  await parseQueue.add(
    'parse',
    { resumeId },
    { attempts: 2, backoff: { type: 'exponential', delay: 3000 }, removeOnComplete: 100, removeOnFail: 200 },
  );
}

export interface PurgeJobData {
  resumeId: string;
}

export const purgeQueue = new Queue<PurgeJobData>('resume-purge', { connection: bullConnection });

/**
 * Drop a rejected upload's file from storage shortly after we refuse it. Delayed
 * rather than immediate so the row and its error message settle first, and so a
 * burst of bad uploads doesn't turn into a burst of S3 calls.
 */
export async function enqueueResumePurge(resumeId: string, delayMs = 120_000): Promise<void> {
  await purgeQueue.add(
    'purge',
    { resumeId },
    { jobId: `purge:${resumeId}`, delay: delayMs, attempts: 3, backoff: { type: 'exponential', delay: 10_000 }, removeOnComplete: 100, removeOnFail: 200 },
  );
}

export const sweepQueue = new Queue('interview-sweep', { connection: bullConnection });

/** Finish interviews whose time ran out. Repeats forever; safe to call on every boot. */
export async function scheduleInterviewSweep(everyMs = 60_000): Promise<void> {
  await sweepQueue.add('sweep', {}, { repeat: { every: everyMs }, removeOnComplete: 20, removeOnFail: 50 });
}

export const reportQueue = new Queue<ReportJobData>('interview-report', { connection: bullConnection });

/**
 * Build the report in the background the moment an interview ends, so it is
 * usually ready by the time the candidate opens the page. Opening it earlier
 * still works — the route builds it on demand.
 */
export async function enqueueReport(interviewId: string, userId: string): Promise<void> {
  await reportQueue.add(
    'report',
    { interviewId, userId },
    {
      jobId: `report:${interviewId}`, // one per interview, even if it ends twice
      attempts: 2,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 100,
      removeOnFail: 200,
    },
  );
}
