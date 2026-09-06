import jwt from 'jsonwebtoken';
import { nanoid } from 'nanoid';
import { env } from '@/config/env';
import { unauthorized } from '@/common/errors';

export interface AccessPayload {
  sub: string; // user id
}

export interface RefreshPayload {
  sub: string; // user id
  jti: string; // unique id, tracked in Redis for rotation/revocation
}

export const refreshTtlSeconds = env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60;

export function signAccessToken(userId: string): string {
  return jwt.sign({ sub: userId } satisfies AccessPayload, env.JWT_ACCESS_SECRET, {
    expiresIn: env.ACCESS_TOKEN_TTL as jwt.SignOptions['expiresIn'],
  });
}

export function signRefreshToken(userId: string): { token: string; jti: string } {
  const jti = nanoid();
  const token = jwt.sign({ sub: userId, jti } satisfies RefreshPayload, env.JWT_REFRESH_SECRET, {
    expiresIn: `${env.REFRESH_TOKEN_TTL_DAYS}d`,
  });
  return { token, jti };
}

export function verifyAccessToken(token: string): AccessPayload {
  try {
    return jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessPayload;
  } catch {
    throw unauthorized('Invalid or expired access token');
  }
}

export function verifyRefreshToken(token: string): RefreshPayload {
  try {
    return jwt.verify(token, env.JWT_REFRESH_SECRET) as RefreshPayload;
  } catch {
    throw unauthorized('Invalid or expired refresh token');
  }
}
