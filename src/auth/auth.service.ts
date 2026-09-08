import bcrypt from 'bcryptjs';
import type { User } from '@prisma/client';
import { userRepository } from '@/db/user.repository';
import { badRequest, conflict, unauthorized } from '@/common/errors';
import { logger } from '@/common/logger';
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from '@/auth/token.service';
import { refreshStore } from '@/auth/refresh-store';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

/** Public shape of a user returned to the client — never includes the password hash. */
export function toPublicUser(user: User) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    avatarUrl: user.avatarUrl,
    authProvider: user.authProvider,
  };
}

async function issueTokens(userId: string): Promise<TokenPair> {
  const accessToken = signAccessToken(userId);
  const { token: refreshToken, jti } = signRefreshToken(userId);
  await refreshStore.add(userId, jti);
  return { accessToken, refreshToken };
}

export const authService = {
  async signup(email: string, password: string, name?: string): Promise<{ user: User; tokens: TokenPair }> {
    const existing = await userRepository.findByEmail(email);
    if (existing) throw conflict('An account with this email already exists', 'email_taken');

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await userRepository.create({ email, authProvider: 'email', passwordHash, name });
    const tokens = await issueTokens(user.id);
    return { user, tokens };
  },

  async login(email: string, password: string): Promise<{ user: User; tokens: TokenPair }> {
    const user = await userRepository.findByEmail(email);
    if (!user || !user.passwordHash) throw unauthorized('Invalid email or password');

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) throw unauthorized('Invalid email or password');

    const tokens = await issueTokens(user.id);
    return { user, tokens };
  },

  /** Rotate a refresh token. Detects reuse of an already-rotated token and revokes all sessions. */
  async refresh(refreshToken: string): Promise<TokenPair> {
    const { sub: userId, jti } = verifyRefreshToken(refreshToken);

    const valid = await refreshStore.exists(userId, jti);
    if (!valid) {
      // Token was well-formed but its jti is gone → already used or revoked → assume theft.
      logger.warn({ userId }, 'Refresh token reuse detected — revoking all sessions');
      await refreshStore.removeAll(userId);
      throw unauthorized('Refresh token no longer valid');
    }

    await refreshStore.remove(userId, jti);
    return issueTokens(userId);
  },

  async logout(refreshToken?: string): Promise<void> {
    if (!refreshToken) return;
    try {
      const { sub: userId, jti } = verifyRefreshToken(refreshToken);
      await refreshStore.remove(userId, jti);
    } catch {
      // Already invalid — nothing to revoke.
    }
  },

  /** Update editable profile fields (currently just the display name). */
  async updateProfile(userId: string, data: { name?: string }): Promise<User> {
    return userRepository.updateProfile(userId, data);
  },

  /** Change password for an email/password account after verifying the current one. */
  async changePassword(userId: string, currentPassword: string, newPassword: string): Promise<void> {
    const user = await userRepository.findById(userId);
    if (!user) throw unauthorized('Not authenticated');
    if (!user.passwordHash)
      throw badRequest('Password change is not available for Google sign-in accounts', 'no_password');

    const ok = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!ok) throw badRequest('Current password is incorrect', 'wrong_password');

    const passwordHash = await bcrypt.hash(newPassword, 12);
    await userRepository.updatePassword(userId, passwordHash);
  },

  /** Find-or-create a user from a verified Google identity, then issue tokens. */
  async loginWithGoogle(profile: {
    email: string;
    name?: string;
    avatarUrl?: string;
  }): Promise<{ user: User; tokens: TokenPair }> {
    let user = await userRepository.findByEmail(profile.email);
    user ??= await userRepository.create({
      email: profile.email,
      authProvider: 'google',
      name: profile.name,
      avatarUrl: profile.avatarUrl,
    });
    const tokens = await issueTokens(user.id);
    return { user, tokens };
  },
};
