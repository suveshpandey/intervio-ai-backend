import type { Interview, Prisma, Turn } from '@prisma/client';
import { prisma } from '@/db/prisma';
import type { EvalResult } from '@/modules/interview/types';

export const interviewRepository = {
  /** A new interview waits as `planned`; the clock starts when the room is first joined. */
  create(userId: string, blueprintId: string): Promise<Interview> {
    return prisma.interview.create({ data: { userId, blueprintId, status: 'planned' } });
  },

  /** The user's interview that is still open (waiting to be joined, or running), if any. */
  findOpenForUser(userId: string) {
    return prisma.interview.findFirst({
      where: { userId, status: { in: ['planned', 'live'] } },
      orderBy: { createdAt: 'desc' },
      include: { blueprint: true },
    });
  },

  /**
   * Someone is entering the room. The first time, this starts the clock
   * (planned → live). A rejoin just clears the "left" mark.
   * @returns when the clock started, or null if the interview can't be joined
   * (finished, or it was never started in time).
   */
  async markJoined(id: string): Promise<Date | null> {
    const now = new Date();
    const first = await prisma.interview.updateMany({
      where: { id, status: 'planned' },
      data: { status: 'live', startedAt: now, lastLeftAt: null },
    });
    if (first.count > 0) return now;

    const row = await prisma.interview.findUnique({
      where: { id },
      select: { status: true, startedAt: true },
    });
    if (row?.status !== 'live' || !row.startedAt) return null;
    await prisma.interview.update({ where: { id }, data: { lastLeftAt: null } });
    return row.startedAt;
  },

  /** The voice connection dropped on a running interview: start the rejoin window. */
  async markLeft(id: string): Promise<void> {
    await prisma.interview.updateMany({
      where: { id, status: 'live' },
      data: { lastLeftAt: new Date() },
    });
  },

  /** Never joined in time (or replaced by a new one). No report, nothing to score. */
  async markNotStarted(id: string): Promise<boolean> {
    const { count } = await prisma.interview.updateMany({
      where: { id, status: 'planned' },
      data: { status: 'not_started', endedAt: new Date() },
    });
    return count > 0;
  },

  /** Planned interviews nobody joined within `olderThanSec`. */
  findUnstarted(olderThanSec: number, take = 50) {
    return prisma.interview.findMany({
      where: { status: 'planned', createdAt: { lte: new Date(Date.now() - olderThanSec * 1000) } },
      take,
      select: { id: true, userId: true },
    });
  },

  /** Live interviews whose candidate left and didn't come back within `olderThanSec`. */
  findLeft(olderThanSec: number, take = 50) {
    return prisma.interview.findMany({
      where: { status: 'live', lastLeftAt: { lte: new Date(Date.now() - olderThanSec * 1000) } },
      take,
      select: { id: true, userId: true },
    });
  },

  findById(id: string, userId: string) {
    return prisma.interview.findFirst({
      where: { id, userId },
      include: { blueprint: true },
    });
  },

  /**
   * Every interview this user has run, newest first — the sidebar's history.
   * Carries just enough per row to label it without a second request.
   */
  listForUser(userId: string, take = 50) {
    return prisma.interview.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take,
      select: {
        id: true,
        status: true,
        createdAt: true,
        startedAt: true,
        endedAt: true,
        lastLeftAt: true,
        blueprint: { select: { role: true, level: true, durationMin: true, resumeId: true } },
        report: { select: { verdict: true, stats: true } },
        _count: { select: { turns: true } },
      },
    });
  },

  /** Hard delete, user-scoped. Cascades to turns, evidence and the report. */
  async remove(id: string, userId: string): Promise<boolean> {
    const { count } = await prisma.interview.deleteMany({ where: { id, userId } });
    return count > 0;
  },

  /** A clarified question replaces the wording on its own turn, so the transcript matches what was said. */
  async updateQuestion(turnId: string, questionText: string): Promise<void> {
    await prisma.turn.update({ where: { id: turnId }, data: { questionText } });
  },

  countAnswered(interviewId: string): Promise<number> {
    return prisma.turn.count({ where: { interviewId, answerTranscript: { not: null } } });
  },

  async startedAt(id: string): Promise<Date | null> {
    const row = await prisma.interview.findUnique({ where: { id }, select: { startedAt: true } });
    return row?.startedAt ?? null;
  },

  /**
   * Interviews whose time is up but that are still marked live — almost always a
   * closed tab. Returned with what the finaliser needs to decide on a report.
   */
  findExpired(graceSec: number, take = 50) {
    return prisma.interview
      .findMany({
        where: { status: 'live', startedAt: { not: null } },
        orderBy: { startedAt: 'asc' },
        take,
        select: {
          id: true,
          userId: true,
          startedAt: true,
          blueprint: { select: { durationMin: true } },
          _count: { select: { turns: true } },
        },
      })
      .then((rows) =>
        rows.filter((r) => {
          const endsAt = r.startedAt!.getTime() + (r.blueprint.durationMin * 60 + graceSec) * 1000;
          return endsAt <= Date.now();
        }),
      );
  },

  /** Close out an interview whose clock ran out. Scoped to `live` so it can't undo a real finish. */
  async expire(id: string, endedAt: Date): Promise<boolean> {
    const { count } = await prisma.interview.updateMany({
      where: { id, status: 'live' },
      data: { status: 'completed', endedAt },
    });
    return count > 0;
  },

  createTurn(data: {
    interviewId: string;
    idx: number;
    sectionKey: string;
    objective: string;
    questionText: string;
    claimId: string | null;
  }): Promise<Turn> {
    return prisma.turn.create({ data });
  },

  /** Record the answer + the model's judgement, and what the engine decided. */
  async answerTurn(
    turnId: string,
    answer: string,
    evaluation: EvalResult,
    chosenAction: string,
  ): Promise<void> {
    await prisma.turn.update({
      where: { id: turnId },
      data: {
        answerTranscript: answer,
        eval: evaluation as unknown as Prisma.InputJsonValue,
        chosenAction,
        answeredAt: new Date(),
      },
    });
  },

  async addEvidence(data: {
    interviewId: string;
    claimId: string;
    turnId: string;
    polarity: 'support' | 'weaken';
    weight: number;
    rationale: string;
  }): Promise<void> {
    await prisma.evidence.create({ data });
  },

  /**
   * Ended early by the candidate (or the tab closed).
   *
   * Scoped to `status: 'live'` on purpose: a socket closing right after a normal
   * finish must NOT downgrade a 'completed' interview to 'abandoned'.
   * @returns true if this call is what ended it.
   */
  async abandon(id: string): Promise<boolean> {
    const { count } = await prisma.interview.updateMany({
      where: { id, status: 'live' },
      data: { status: 'abandoned', endedAt: new Date() },
    });
    if (count > 0) return true;
    // Ended before ever joining: nothing happened, so it is "not started", not abandoned.
    await this.markNotStarted(id);
    return false;
  },

  async complete(id: string): Promise<void> {
    await prisma.interview.update({
      where: { id },
      data: { status: 'completed', endedAt: new Date() },
    });
  },

  listTurns(interviewId: string): Promise<Turn[]> {
    return prisma.turn.findMany({ where: { interviewId }, orderBy: { idx: 'asc' } });
  },
};
