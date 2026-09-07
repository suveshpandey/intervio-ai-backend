import type { Claim } from '@prisma/client';
import { prisma } from '@/db/prisma';
import type { ExtractedClaim } from '@/modules/intelligence/schema';

export const claimRepository = {
  /** Replace all claims for a resume (idempotent re-parse). */
  async replaceForResume(resumeId: string, claims: ExtractedClaim[]): Promise<void> {
    await prisma.$transaction([
      prisma.claim.deleteMany({ where: { resumeId } }),
      prisma.claim.createMany({
        data: claims.map((c) => ({
          resumeId,
          text: c.text,
          category: c.category,
          relatedSkills: c.related_skills,
          importance: c.importance,
          priority: c.priority,
        })),
      }),
    ]);
  },

  listByResume(resumeId: string): Promise<Claim[]> {
    return prisma.claim.findMany({
      where: { resumeId },
      orderBy: [{ importance: 'desc' }, { priority: 'desc' }],
    });
  },
};
