import type { Prisma, Resume } from '@prisma/client';
import { prisma } from '@/db/prisma';

export const resumeRepository = {
  create(data: {
    userId: string;
    fileUrl: string;
    fileName: string;
    fileHash: string;
  }): Promise<Resume> {
    return prisma.resume.create({ data });
  },

  findById(id: string, userId: string): Promise<Resume | null> {
    return prisma.resume.findFirst({ where: { id, userId } });
  },

  /** Internal lookup (worker) — not user-scoped. */
  findByIdUnscoped(id: string): Promise<Resume | null> {
    return prisma.resume.findUnique({ where: { id } });
  },

  listByUser(userId: string): Promise<Resume[]> {
    return prisma.resume.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } });
  },

  /** Every stored file for a user — so account deletion can purge S3 too. */
  listFileKeys(userId: string): Promise<{ fileUrl: string }[]> {
    return prisma.resume.findMany({ where: { userId }, select: { fileUrl: true } });
  },

  setStatus(id: string, parseStatus: Prisma.ResumeUpdateInput['parseStatus'], parseError?: string) {
    return prisma.resume.update({ where: { id }, data: { parseStatus, parseError: parseError ?? null } });
  },

  setExtracted(id: string, extracted: Prisma.InputJsonValue) {
    return prisma.resume.update({
      where: { id },
      data: { extracted, parseStatus: 'done', parseError: null },
    });
  },

  /**
   * Hard delete, user-scoped. Cascades to claims, blueprints, interviews, turns,
   * evidence and reports — a soft delete would leave the CV's contents behind,
   * which is exactly what someone deleting it wants gone.
   */
  async hardDelete(id: string, userId: string): Promise<boolean> {
    const { count } = await prisma.resume.deleteMany({ where: { id, userId } });
    return count > 0;
  },
};
