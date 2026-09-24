import { Worker } from 'bullmq';
import { bullConnection } from '@/jobs/queue';
import { logger } from '@/common/logger';
import { expireFinishedInterviews } from '@/modules/interview/expire';

/** Closes out interviews whose clock ran out (usually a closed tab). */
export function startSweepWorker(): Worker {
  const worker = new Worker(
    'interview-sweep',
    async () => {
      const finished = await expireFinishedInterviews();
      if (finished) logger.info({ finished }, 'sweep finished expired interviews');
    },
    { connection: bullConnection },
  );

  worker.on('failed', (job, err) => logger.error({ jobId: job?.id, err }, 'Interview sweep failed'));
  return worker;
}
