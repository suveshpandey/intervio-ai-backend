import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { logger } from '@/common/logger';
import { voiceEnabled } from '@/config/env';
import { redeemTicket } from '@/modules/interview/gateway/ticket';
import { VoiceSession } from '@/modules/interview/gateway/session';

export const VOICE_PATH = '/voice';

/**
 * Attaches the voice gateway to the existing HTTP server.
 *
 * Auth happens during the upgrade handshake: the browser passes a single-use
 * ticket in the query string (it can't set headers on a WebSocket). An invalid
 * ticket never becomes a WebSocket at all.
 */
export function attachVoiceGateway(server: Server): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '', `http://${req.headers.host ?? 'localhost'}`);
    if (url.pathname !== VOICE_PATH) return; // not ours — leave it alone

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

  logger.info(`🎙️  voice gateway listening on ws ${VOICE_PATH}`);
  return wss;
}

function onConnection(ws: WebSocket, ticket: { userId: string; interviewId: string }): void {
  const session = new VoiceSession(ws, ticket);
  const log = logger.child({ interviewId: ticket.interviewId });

  ws.on('message', (data: Buffer, isBinary: boolean) => {
    try {
      session.handleMessage(data, isBinary);
    } catch (err) {
      log.error({ err }, 'voice message handling failed');
    }
  });

  ws.on('close', () => {
    log.info('voice session closed');
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
