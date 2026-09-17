import WebSocket from 'ws';
import { env } from '@/config/env';
import { AppError } from '@/common/errors';
import { logger } from '@/common/logger';
import {
  AUDIO_ENCODING,
  TTS_SAMPLE_RATE,
  type TextToSpeechProvider,
  type TtsOptions,
  type TtsSession,
} from '@/modules/voice/types';
import { findVoice } from '@/modules/voice/voices';

/**
 * Direct socket API — see the note in deepgram.stt.ts about the v5 SDK.
 *
 * All our voices are `flux-*` on Deepgram's v2 speak API. Note that v2 signals
 * end-of-audio with "SpeechMetadata", NOT "Flushed" (which fires early, while
 * audio is still streaming) — using v1's signal here truncates every question.
 * v1 `aura-*` models are not supported; they reject flux ids and use the other
 * end signal, so mixing generations needs a deliberate branch here.
 */
const SPEAK_URL = 'wss://api.deepgram.com/v2/speak';
const DONE_MESSAGE = 'SpeechMetadata';

/** Safety net so a stalled socket can never hang an interview turn. */
const SPEAK_TIMEOUT_MS = 15_000;

/**
 * Deepgram drops an idle Speak socket. A candidate answering for a minute is
 * completely normal, and that was long enough to lose the connection — after
 * which every question threw "TTS session is closed" and the interview carried
 * on in total silence. So the session reconnects on demand instead of failing.
 */

export const deepgramTts: TextToSpeechProvider = {
  async openSession(sessionOpts: TtsOptions = {}): Promise<TtsSession> {
    if (!env.DEEPGRAM_API_KEY) throw new AppError(503, 'Voice is not configured', 'voice_disabled');

    // Each voice carries its own speed/expressivity — they don't sit right at the same settings.
    const voice = findVoice(sessionOpts.model ?? env.DEEPGRAM_TTS_MODEL);

    const params = new URLSearchParams({
      model: voice.id,
      encoding: AUDIO_ENCODING,
      sample_rate: String(TTS_SAMPLE_RATE),
      speed: String(voice.speed),
      expressivity: String(voice.expressivity),
    });

    const url = `${SPEAK_URL}?${params}`;
    let ws: WebSocket;
    let socketError: Error | null = null;
    let closedDeliberately = false;

    async function connect(reason: 'open' | 'reconnect'): Promise<void> {
      socketError = null;
      ws = new WebSocket(url, { headers: { Authorization: `Token ${env.DEEPGRAM_API_KEY}` } });
      ws.on('error', (err: Error) => {
        logger.error({ err, model: voice.id }, 'Deepgram TTS error');
        socketError = err;
      });
      ws.on('close', (code: number) => {
        if (!closedDeliberately) {
          logger.warn({ code, model: voice.id }, 'Deepgram TTS socket closed (will reconnect)');
        }
      });
      await new Promise<void>((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      });
      logger.debug(
        { model: voice.id, speed: voice.speed, expressivity: voice.expressivity, reason },
        'TTS session open',
      );
    }

    await connect('open');

    return {
      /**
       * One utterance on the shared socket. Chunks are yielded as they arrive —
       * time-to-first-chunk is what makes the interview feel conversational.
       */
      async *speak(text: string, opts: TtsOptions = {}): AsyncIterable<Buffer> {
        // Deepgram drops idle sockets; a long candidate answer is enough to lose it.
        if (ws.readyState !== WebSocket.OPEN) await connect('reconnect');

        const chunks: Buffer[] = [];
        let done = false;
        let failure: Error | null = socketError;
        let wake: (() => void) | null = null;
        const signal = () => {
          wake?.();
          wake = null;
        };

        const onMessage = (data: Buffer, isBinary: boolean) => {
          if (isBinary) {
            chunks.push(data);
          } else {
            try {
              if ((JSON.parse(data.toString()) as { type?: string }).type === DONE_MESSAGE) done = true;
            } catch {
              /* ignore non-JSON control frames */
            }
          }
          signal();
        };
        const onError = (err: Error) => {
          failure = err;
          done = true;
          signal();
        };
        const onClose = () => {
          done = true;
          signal();
        };

        ws.on('message', onMessage);
        ws.once('error', onError);
        ws.once('close', onClose);

        ws.send(JSON.stringify({ type: 'Speak', text }));
        ws.send(JSON.stringify({ type: 'Flush' }));

        const deadline = setTimeout(() => {
          failure = new Error('TTS timed out');
          done = true;
          signal();
        }, SPEAK_TIMEOUT_MS);

        try {
          while (true) {
            while (chunks.length) yield chunks.shift()!;
            if (done || opts.signal?.aborted) break;
            // Re-check *inside* the executor: if a chunk landed between the check
            // above and registering `wake`, signal() would have found no waiter and
            // the generator would sleep until the timeout. Classic missed wakeup.
            await new Promise<void>((resolve) => {
              wake = resolve;
              if (chunks.length || done) {
                wake = null;
                resolve();
              }
            });
          }
          while (chunks.length) yield chunks.shift()!;
          if (failure) throw failure;
        } finally {
          clearTimeout(deadline);
          // Leave the socket open for the next turn — only detach this utterance.
          ws.off('message', onMessage);
          ws.off('error', onError);
          ws.off('close', onClose);
        }
      },

      close() {
        closedDeliberately = true;
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'Close' }));
        ws.close();
      },
    };
  },
};
