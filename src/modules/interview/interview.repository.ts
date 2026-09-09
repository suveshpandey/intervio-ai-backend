import type { Interview, Prisma, Turn } from '@prisma/client';
import { prisma } from '@/db/prisma';
import type { EvalResult } from '@/modules/interview/types';

export const interviewRepository = {
  create(userId: string, blueprintId: string): Promise<Interview> {
    return prisma.interview.create({
      data: { userId, blueprintId, status: 'live', startedAt: new Date() },
    });
  },

  findById(id: string, userId: string) {
    return prisma.interview.findFirst({
      where: { id, userId },
      include: { blueprint: true },
    });
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
