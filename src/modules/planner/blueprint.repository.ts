import type { Blueprint, Prisma } from '@prisma/client';
import { prisma } from '@/db/prisma';
import type { PlanSection } from '@/modules/planner/schema';

interface CreateBlueprint {
  userId: string;
  resumeId: string;
  jdId: string | null;
  role: string;
  level: string;
  difficulty: string;
  durationMin: number;
  sections: PlanSection[];
  probeClaimIds: string[];
}

export const blueprintRepository = {
  create(data: CreateBlueprint): Promise<Blueprint> {
    return prisma.blueprint.create({
      data: { ...data, sections: data.sections as unknown as Prisma.InputJsonValue },
    });
  },

  findById(id: string, userId: string): Promise<Blueprint | null> {
    return prisma.blueprint.findFirst({ where: { id, userId } });
  },
};
