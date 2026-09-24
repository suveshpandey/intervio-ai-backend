/**
 * Finishing interviews whose time ran out.
 *
 * The clock is real time from the moment an interview starts and never pauses,
 * so closing the tab doesn't buy more time and there is no rejoining later. Once
 * the duration is up the interview is closed out with whatever was answered, and
 * its report is built from that — exactly what the candidate would have got had
 * they sat through the silence.
 *
 * Without this, a closed tab left a row marked `live` forever.
 */

import { logger } from '@/common/logger';
import { interviewRepository } from '@/modules/interview/interview.repository';
import { stateStore } from '@/modules/interview/state.store';
import { clearPrefetch } from '@/modules/interview/engine/prefetch';
import { enqueueReport } from '@/jobs/queue';
import { MIN_ANSWERS_FOR_REPORT } from '@/modules/report/scoring';

/**
 * Breathing room past the planned duration. The engine ends an interview on the
 * answer AFTER time runs out, so a candidate mid-sentence at the buzzer should
 * finish their thought rather than be cut off by the sweeper.
 */
export const EXPIRY_GRACE_SEC = 90;

/** Closes out every interview past its time. @returns how many were finished. */
export async function expireFinishedInterviews(): Promise<number> {
  const expired = await interviewRepository.findExpired(EXPIRY_GRACE_SEC);
  let finished = 0;

  for (const interview of expired) {
    const endedAt = new Date(interview.startedAt!.getTime() + interview.blueprint.durationMin * 60_000);
    // Scoped to `live`, so an interview that finished properly in the meantime wins.
    if (!(await interviewRepository.expire(interview.id, endedAt))) continue;
    finished++;

    await stateStore.clear(interview.id).catch(() => {});
    clearPrefetch(interview.id);

    const answered = await interviewRepository.countAnswered(interview.id);
    if (answered >= MIN_ANSWERS_FOR_REPORT) {
      await enqueueReport(interview.id, interview.userId).catch((err: unknown) =>
        logger.error({ err, interviewId: interview.id }, 'failed to queue report for expired interview'),
      );
    }

    logger.info(
      { interviewId: interview.id, answered, durationMin: interview.blueprint.durationMin },
      'interview expired — time was up',
    );
  }

  return finished;
}
