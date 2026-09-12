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

/** Direct socket API — see the note in deepgram.stt.ts about the v5 SDK. */
const TTS_URL = 'wss://api.deepgram.com/v1/speak';

/** Safety net so a stalled socket can never hang an interview turn. */
const SPEAK_TIMEOUT_MS = 15_000;

export const deepgramTts: TextToSpeechProvider = {
  async openSession(sessionOpts: TtsOptions = {}): Promise<TtsSession> {
    if (!env.DEEPGRAM_API_KEY) throw new AppError(503, 'Voice is not configured', 'voice_disabled');

    const params = new URLSearchParams({
      model: sessionOpts.model ?? env.DEEPGRAM_TTS_MODEL,
      encoding: AUDIO_ENCODING,
      sample_rate: String(TTS_SAMPLE_RATE),
    });

    const ws = new WebSocket(`${TTS_URL}?${params}`, {
      headers: { Authorization: `Token ${env.DEEPGRAM_API_KEY}` },
    });

    let socketError: Error | null = null;
    ws.on('error', (err: Error) => {
      logger.error({ err }, 'Deepgram TTS error');
      socketError = err;
    });

    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });

    return {
      /**
       * One utterance on the shared socket. Chunks are yielded as they arrive —
       * time-to-first-chunk is what makes the interview feel conversational.
       */
      async *speak(text: string, opts: TtsOptions = {}): AsyncIterable<Buffer> {
        if (ws.readyState !== WebSocket.OPEN) throw new Error('TTS session is closed');

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
            // "Flushed" = every audio frame for THIS utterance has been sent.
            try {
              if ((JSON.parse(data.toString()) as { type?: string }).type === 'Flushed') done = true;
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
            await new Promise<void>((resolve) => {
              wake = resolve;
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
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'Close' }));
        ws.close();
      },
    };
  },
};
