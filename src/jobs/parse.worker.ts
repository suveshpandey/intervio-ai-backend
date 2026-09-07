import { Worker } from 'bullmq';
import { bullConnection, type ParseJobData } from '@/jobs/queue';
import { logger } from '@/common/logger';
import { getObject } from '@/storage/r2';
import { resumeRepository } from '@/modules/resume/resume.repository';
import { claimRepository } from '@/modules/intelligence/claim.repository';
import { extractResumeText, type ResumeFileType } from '@/modules/resume/text-extract';
import { extractResume, extractClaims } from '@/modules/intelligence/extraction';

/**
 * Resume parse pipeline:
 * R2 download → text extract → LLM extraction + claims → save.
 */
export function startParseWorker(): Worker<ParseJobData> {
  const worker = new Worker<ParseJobData>(
    'resume-parse',
    async (job) => {
      const { resumeId } = job.data;
      const resume = await resumeRepository.findByIdUnscoped(resumeId);
      if (!resume) throw new Error(`Resume ${resumeId} not found`);

      await resumeRepository.setStatus(resumeId, 'processing');

      const buffer = await getObject(resume.fileUrl);
      const type: ResumeFileType = resume.fileName.toLowerCase().endsWith('.pdf') ? 'pdf' : 'docx';
      const text = await extractResumeText(buffer, type);

      // Extraction + claims run against the same text.
      const [extracted, claims] = await Promise.all([extractResume(text), extractClaims(text)]);

      await claimRepository.replaceForResume(resumeId, claims);
      await resumeRepository.setExtracted(resumeId, extracted);

      logger.info({ resumeId, skills: extracted.skills.length, claims: claims.length }, 'Resume parsed');
    },
    { connection: bullConnection, concurrency: 3 },
  );

  worker.on('failed', async (job, err) => {
    logger.error({ jobId: job?.id, err }, 'Parse job failed');
    if (job?.data.resumeId && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      await resumeRepository.setStatus(job.data.resumeId, 'failed', err.message).catch(() => {});
    }
  });

  logger.info('Resume parse worker started');
  return worker;
}
