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
    return prisma.resume.findFirst({ where: { id, userId, deletedAt: null } });
  },

  /** Internal lookup (worker) — not user-scoped. */
  findByIdUnscoped(id: string): Promise<Resume | null> {
    return prisma.resume.findFirst({ where: { id, deletedAt: null } });
  },

  listByUser(userId: string): Promise<Resume[]> {
    return prisma.resume.findMany({
      where: { userId, deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
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

  softDelete(id: string, userId: string) {
    return prisma.resume.updateMany({
      where: { id, userId, deletedAt: null },
      data: { deletedAt: new Date() },
    });
  },
};
