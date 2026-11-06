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
 *
 * Two shorter rules sit beside it (see lifecycle.ts): an interview nobody joined
 * is closed as "not started" after 5 minutes, and one whose candidate left is
 * ended if they don't come back within 10.
 */

import { logger } from '@/common/logger';
import { interviewRepository } from '@/modules/interview/interview.repository';
import { stateStore } from '@/modules/interview/state.store';
import { clearPrefetch } from '@/modules/interview/engine/prefetch';
import { enqueueReport } from '@/jobs/queue';
import { closeVoiceSession } from '@/modules/interview/gateway/ws';
import { MIN_ANSWERS_FOR_REPORT } from '@/modules/report/scoring';
import {
  EXPIRY_GRACE_SEC,
  NOT_STARTED_AFTER_SEC,
  REJOIN_WINDOW_SEC,
} from '@/modules/interview/lifecycle';

export { EXPIRY_GRACE_SEC };

/** Closes out every interview past its time, or abandoned. @returns how many were finished. */
export async function expireFinishedInterviews(): Promise<number> {
  const timedOut = await expireTimedOut();
  const unstarted = await closeUnstarted();
  const left = await closeLeft();
  return timedOut + unstarted + left;
}

async function expireTimedOut(): Promise<number> {
  const expired = await interviewRepository.findExpired(EXPIRY_GRACE_SEC);
  let finished = 0;

  for (const interview of expired) {
    const endedAt = new Date(
      interview.startedAt!.getTime() + interview.blueprint.durationMin * 60_000,
    );
    // Scoped to `live`, so an interview that finished properly in the meantime wins.
    if (!(await interviewRepository.expire(interview.id, endedAt))) continue;
    finished++;

    await stateStore.clear(interview.id).catch(() => {});
    clearPrefetch(interview.id);
    // The row is closed; the socket and its two paid Deepgram streams must go too.
    closeVoiceSession(interview.id);

    const answered = await interviewRepository.countAnswered(interview.id);
    if (answered >= MIN_ANSWERS_FOR_REPORT) {
      await enqueueReport(interview.id, interview.userId).catch((err: unknown) =>
        logger.error(
          { err, interviewId: interview.id },
          'failed to queue report for expired interview',
        ),
      );
    }

    logger.info(
      { interviewId: interview.id, answered, durationMin: interview.blueprint.durationMin },
      'interview expired — time was up',
    );
  }

  return finished;
}

/** Created but never joined: close as "not started". No report, nothing to score. */
async function closeUnstarted(): Promise<number> {
  let closed = 0;
  for (const interview of await interviewRepository.findUnstarted(NOT_STARTED_AFTER_SEC)) {
    if (!(await interviewRepository.markNotStarted(interview.id))) continue;
    closed++;
    await stateStore.clear(interview.id).catch(() => {});
    clearPrefetch(interview.id);
    logger.info({ interviewId: interview.id }, 'interview never joined — closed as not started');
  }
  return closed;
}

/** The candidate left a running interview and didn't return in time: end it. */
async function closeLeft(): Promise<number> {
  let closed = 0;
  for (const interview of await interviewRepository.findLeft(REJOIN_WINDOW_SEC)) {
    // Scoped to `live`, so one that finished or was rejoined in the meantime wins.
    if (!(await interviewRepository.abandon(interview.id))) continue;
    closed++;
    await stateStore.clear(interview.id).catch(() => {});
    clearPrefetch(interview.id);
    closeVoiceSession(interview.id);

    const answered = await interviewRepository.countAnswered(interview.id);
    if (answered >= MIN_ANSWERS_FOR_REPORT) {
      await enqueueReport(interview.id, interview.userId).catch((err: unknown) =>
        logger.error(
          { err, interviewId: interview.id },
          'failed to queue report for abandoned interview',
        ),
      );
    }
    logger.info(
      { interviewId: interview.id, answered },
      'candidate did not rejoin — interview ended',
    );
  }
  return closed;
}
