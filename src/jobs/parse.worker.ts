import { Worker } from 'bullmq';
import { bullConnection, type ParseJobData } from '@/jobs/queue';
import { logger } from '@/common/logger';
import { getObject } from '@/storage/s3';
import { resumeRepository } from '@/modules/resume/resume.repository';
import { claimRepository } from '@/modules/intelligence/claim.repository';
import { extractResumeText, type ResumeFileType } from '@/modules/resume/text-extract';
import { extractResume, extractClaims } from '@/modules/intelligence/extraction';
import { looksLikeResume, extractionIsEmpty, NOT_A_RESUME } from '@/modules/resume/validate';
import { enqueueResumePurge } from '@/jobs/queue';

/**
 * Refuse a file that isn't a resume: tell the user plainly, and bin the upload.
 * Returning normally (not throwing) matters — a retry would fail identically and
 * only burn LLM calls.
 */
async function reject(resumeId: string, reason: string, why: string): Promise<void> {
  await resumeRepository.setStatus(resumeId, 'failed', reason);
  await enqueueResumePurge(resumeId);
  logger.info({ resumeId, why }, 'upload rejected — not a resume');
}

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
      // From the server-generated S3 key, not the user-supplied filename: those
      // two disagreeing is how arbitrary bytes reach a chosen parser.
      const type: ResumeFileType = resume.fileUrl.toLowerCase().endsWith('.pdf') ? 'pdf' : 'docx';
      const text = await extractResumeText(buffer, type);

      // Cheap deterministic gate first — no LLM spend on a menu or keyboard mash.
      const check = looksLikeResume(text);
      if (!check.ok) return reject(resumeId, check.reason, 'failed text checks');

      // Extraction + claims run against the same text.
      const [extracted, claims] = await Promise.all([extractResume(text), extractClaims(text)]);

      // Passed the text checks but yielded nothing a resume contains: a real
      // document that simply isn't a CV.
      if (extractionIsEmpty(extracted) && claims.length === 0) {
        return reject(resumeId, NOT_A_RESUME, 'extraction came back empty');
      }

      await claimRepository.replaceForResume(resumeId, claims);
      await resumeRepository.setExtracted(resumeId, extracted);

      logger.info({ resumeId, skills: extracted.skills.length, claims: claims.length }, 'Resume parsed');
    },
    { connection: bullConnection, concurrency: 3 },
  );

  worker.on('failed', async (job, err) => {
    logger.error({ jobId: job?.id, err }, 'Parse job failed');
    if (job?.data.resumeId && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      // A generic message: err.message here is library/S3/LLM internals, and it
      // is shown to whoever uploaded the file.
      await resumeRepository
        .setStatus(job.data.resumeId, 'failed', "We couldn't read that file. Try a text-based PDF or DOCX.")
        .catch(() => {});
      // Bin the upload too — only the validation path used to do this, so
      // anything that failed mid-parse kept its file in the bucket forever.
      await enqueueResumePurge(job.data.resumeId).catch(() => {});
    }
  });

  logger.info('Resume parse worker started');
  return worker;
}
