import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { logger } from '@/common/logger';
import { voiceEnabled, corsOrigins } from '@/config/env';
import { redeemTicket } from '@/modules/interview/gateway/ticket';
import { VoiceSession } from '@/modules/interview/gateway/session';

export const VOICE_PATH = '/voice';

/**
 * A 20ms PCM16 mic frame is ~640 bytes. `ws` defaults to 100MiB, which would let
 * one authenticated client hand us a 100MB frame to scan on the event loop.
 */
const MAX_FRAME_BYTES = 32 * 1024;

/** Silent sockets are still paying for two open Deepgram streams. */
const HEARTBEAT_MS = 30_000;

/** At most this many live sockets per user (a reconnect replaces, not adds). */
const MAX_SESSIONS_PER_USER = 2;

/** Live sessions, so a reconnect can replace the old one and expiry can hang up. */
const live = new Map<string, { session: VoiceSession; userId: string; ws: WebSocket }>();

/** Close the socket for an interview that has just been ended elsewhere. */
export function closeVoiceSession(interviewId: string): void {
  const entry = live.get(interviewId);
  if (!entry) return;
  logger.info({ interviewId }, 'closing live voice session — interview is over');
  entry.session.close();
}

/**
 * Attaches the voice gateway to the existing HTTP server.
 *
 * Auth happens during the upgrade handshake: the browser passes a single-use
 * ticket in the query string (it can't set headers on a WebSocket). An invalid
 * ticket never becomes a WebSocket at all.
 */
export function attachVoiceGateway(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`);
    // Registering an 'upgrade' listener means Node stops destroying unhandled
    // upgrade sockets for us, so anything not ours has to be closed here.
    if (url.pathname !== VOICE_PATH) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    // A WebSocket handshake ignores the same-origin policy, so the API's CORS
    // allowlist does not cover this path unless we check it ourselves.
    const origin = req.headers.origin;
    if (origin && !corsOrigins.includes(origin)) {
      logger.warn({ origin }, 'voice upgrade from a disallowed origin');
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    if (!voiceEnabled) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
      socket.destroy();
      return;
    }

    void (async () => {
      const ticket = await redeemTicket(url.searchParams.get('ticket') ?? '');
      if (!ticket) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, ticket));
    })();
  });

  // Drop sockets that stop answering — otherwise a dead client keeps two paid
  // Deepgram streams open until something else notices.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      const socket = ws as WebSocket & { isAlive?: boolean };
      if (socket.isAlive === false) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();
  wss.on('close', () => clearInterval(heartbeat));

  logger.info(`🎙️  voice gateway listening on ws ${VOICE_PATH}`);
  return wss;
}

function onConnection(ws: WebSocket, ticket: { userId: string; interviewId: string }): void {
  const log = logger.child({ interviewId: ticket.interviewId });

  // A refresh mid-interview should replace its socket, not run two in parallel.
  live.get(ticket.interviewId)?.session.close();

  const mine = [...live.values()].filter((e) => e.userId === ticket.userId).length;
  if (mine >= MAX_SESSIONS_PER_USER) {
    log.warn({ userId: ticket.userId, open: mine }, 'too many live voice sessions — refusing');
    ws.send(JSON.stringify({ type: 'error', code: 'too_many_sessions', message: 'You already have an interview open.' }));
    ws.close();
    return;
  }

  const session = new VoiceSession(ws, ticket);
  live.set(ticket.interviewId, { session, userId: ticket.userId, ws });

  const socket = ws as WebSocket & { isAlive?: boolean };
  socket.isAlive = true;
  ws.on('pong', () => {
    socket.isAlive = true;
  });

  ws.on('message', (data: Buffer, isBinary: boolean) => {
    try {
      session.handleMessage(data, isBinary);
    } catch (err) {
      log.error({ err }, 'voice message handling failed');
    }
  });

  ws.on('close', () => {
    log.info('voice session closed');
    if (live.get(ticket.interviewId)?.session === session) live.delete(ticket.interviewId);
    session.close();
  });

  ws.on('error', (err) => {
    log.error({ err }, 'voice socket error');
    session.close();
  });

  session.start().catch((err) => {
    log.error({ err }, 'voice session failed to start');
    try {
      ws.send(JSON.stringify({ type: 'error', code: 'start_failed', message: 'Could not start voice.' }));
    } catch {
      /* socket already gone */
    }
    session.close();
  });
}
