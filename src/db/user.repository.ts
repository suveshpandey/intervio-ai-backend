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
};
