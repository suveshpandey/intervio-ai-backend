import type { AuthProvider, User } from '@prisma/client';
import { prisma } from '@/db/prisma';

/** All reads exclude soft-deleted users. */
export const userRepository = {
  findById(id: string): Promise<User | null> {
    return prisma.user.findFirst({ where: { id, deletedAt: null } });
  },

  findByEmail(email: string): Promise<User | null> {
    return prisma.user.findFirst({ where: { email: email.toLowerCase(), deletedAt: null } });
  },

  create(data: {
    email: string;
    authProvider: AuthProvider;
    passwordHash?: string;
    name?: string;
    avatarUrl?: string;
  }): Promise<User> {
    return prisma.user.create({
      data: { ...data, email: data.email.toLowerCase() },
    });
  },

  updateProfile(id: string, data: { name?: string; avatarUrl?: string }): Promise<User> {
    return prisma.user.update({ where: { id }, data });
  },

  updatePassword(id: string, passwordHash: string): Promise<User> {
    return prisma.user.update({ where: { id }, data: { passwordHash } });
  },

  /** Hard-delete the user row; cascades to their resumes, JDs, claims, blueprints, interviews. */
  hardDelete(id: string): Promise<User> {
    return prisma.user.delete({ where: { id } });
  },
};
