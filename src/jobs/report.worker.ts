import { Worker } from 'bullmq';
import { bullConnection, type ReportJobData } from '@/jobs/queue';
import { logger } from '@/common/logger';
import { generateReport, hasEnoughAnswers } from '@/modules/report/report.service';

/** Builds the report for an interview that just ended. */
export function startReportWorker(): Worker<ReportJobData> {
  const worker = new Worker<ReportJobData>(
    'interview-report',
    async (job) => {
      const { interviewId, userId } = job.data;
      // An interview ended after a question or two is not a failure to retry.
      if (!(await hasEnoughAnswers(interviewId))) {
        logger.info({ interviewId }, 'report skipped — interview too short');
        return;
      }
      await generateReport(userId, interviewId);
    },
    { connection: bullConnection, concurrency: 2 },
  );

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, interviewId: job?.data.interviewId, err }, 'Report job failed');
  });

  return worker;
}
