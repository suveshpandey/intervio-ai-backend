import { randomBytes } from 'node:crypto';
import { redis } from '@/db/redis';

/**
 * Short-lived, single-use ticket for opening a voice WebSocket.
 *
 * The browser's WebSocket API can't send an Authorization header, and putting a
 * real access token in the URL leaks it into logs. So the browser exchanges its
 * cookie session for a ticket that is worthless 60s later and dies on first use.
 */
const TTL_SECONDS = 60;

const key = (token: string) => `voice:ticket:${token}`;

export interface TicketPayload {
  userId: string;
  interviewId: string;
}

export async function issueTicket(payload: TicketPayload): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  await redis.set(key(token), JSON.stringify(payload), 'EX', TTL_SECONDS);
  return token;
}

/** Redeems atomically — a ticket can never be used twice. */
export async function redeemTicket(token: string): Promise<TicketPayload | null> {
  if (!token) return null;
  const raw = await redis.getdel(key(token));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as TicketPayload;
  } catch {
    return null;
  }
}
