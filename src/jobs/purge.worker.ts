import { Worker } from 'bullmq';
import { bullConnection, type PurgeJobData } from '@/jobs/queue';
import { logger } from '@/common/logger';
import { resumeRepository } from '@/modules/resume/resume.repository';
import { deleteObject } from '@/storage/s3';

/**
 * Removes the stored file for an upload we refused. The row stays so the user
 * still sees why it was rejected — only the file goes.
 */
export function startPurgeWorker(): Worker<PurgeJobData> {
  const worker = new Worker<PurgeJobData>(
    'resume-purge',
    async (job) => {
      const resume = await resumeRepository.findByIdUnscoped(job.data.resumeId);
      if (!resume) return; // already deleted by the user — nothing to purge
      await deleteObject(resume.fileUrl);
      logger.info({ resumeId: resume.id }, 'rejected upload purged from storage');
    },
    { connection: bullConnection, concurrency: 2 },
  );

  worker.on('failed', (job, err) =>
    logger.error({ jobId: job?.id, resumeId: job?.data.resumeId, err }, 'Purge job failed'),
  );
  return worker;
}
