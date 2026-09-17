import WebSocket from 'ws';
import { env } from '@/config/env';
import { AppError } from '@/common/errors';
import { logger } from '@/common/logger';
import {
  AUDIO_ENCODING,
  STT_SAMPLE_RATE,
  type SpeechToTextProvider,
  type SttStream,
  type SttStreamOptions,
} from '@/modules/voice/types';

/**
 * We talk to Deepgram's socket API directly rather than through @deepgram/sdk:
 * the v5 SDK's socket layer is browser-oriented and never opens under Node.
 */
const STT_URL = 'wss://api.deepgram.com/v1/listen';

/** Silence after speech before Deepgram emits a final. Lower = snappier turns. */
const ENDPOINTING_MS = 300;
/**
 * How long a silence means "they stopped talking".
 *
 * 1000ms was too eager in real use — people pause about that long mid-sentence
 * while thinking ("...and then, for the index, I used..."), and the interviewer
 * would cut them off. The gateway adds a short grace window on top of this, so
 * see TURN_GRACE_MS there for the real total.
 */
const UTTERANCE_END_MS = 2000;

/**
 * Deepgram closes a Listen socket that receives no audio for ~10s. Our worklet
 * deliberately stops sending during long silences to save cost, so without this
 * the stream dies mid-interview and every later frame vanishes into a closed
 * socket — audio keeps flowing, no transcript ever comes back, silent hang.
 */
const KEEPALIVE_MS = 5000;

interface DeepgramMessage {
  type?: string;
  is_final?: boolean;
  channel?: { alternatives?: { transcript?: string }[] };
}

/** Diagnostic counters per stream (see the 'STT heartbeat' log). */
interface SttCounters {
  results: number;
  empty: number;
  speechStarted: number;
}

export const deepgramStt: SpeechToTextProvider = {
  async openStream(opts: SttStreamOptions): Promise<SttStream> {
    if (!env.DEEPGRAM_API_KEY) throw new AppError(503, 'Voice is not configured', 'voice_disabled');

    const params = new URLSearchParams({
      model: env.DEEPGRAM_STT_MODEL,
      language: 'en',
      encoding: AUDIO_ENCODING,
      sample_rate: String(opts.sampleRate ?? STT_SAMPLE_RATE),
      channels: '1',
      // Partial results drive both live captions and our turn detection.
      interim_results: 'true',
      endpointing: String(ENDPOINTING_MS),
      utterance_end_ms: String(UTTERANCE_END_MS),
      vad_events: 'true',
      punctuate: 'true',
      smart_format: 'true',
    });
    // Bias recognition toward the candidate's own tech terms so "BullMQ" survives.
    for (const term of opts.keyterms ?? []) params.append('keyterm', term);

    const ws = new WebSocket(`${STT_URL}?${params}`, {
      headers: { Authorization: `Token ${env.DEEPGRAM_API_KEY}` },
    });

    // Without these, an "audio in / nothing out" failure is invisible: empty
    // Results are normal for silence and get filtered, so we log nothing at all.
    const c: SttCounters = { results: 0, empty: 0, speechStarted: 0 };

    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) return;
      let msg: DeepgramMessage;
      try {
        msg = JSON.parse(data.toString()) as DeepgramMessage;
      } catch {
        return;
      }

      if (msg.type === 'Results') {
        c.results++;
        const text = msg.channel?.alternatives?.[0]?.transcript ?? '';
        if (text.trim()) {
          opts.onTranscript({ text, isFinal: Boolean(msg.is_final) });
        } else {
          c.empty++;
          // Proof of life: Deepgram IS processing our audio, it just hears no speech.
          if (c.empty % 25 === 0) logger.debug(c, 'STT heartbeat: processing, no speech heard');
        }
      } else if (msg.type === 'UtteranceEnd') {
        opts.onUtteranceEnd?.();
      } else if (msg.type === 'SpeechStarted') {
        c.speechStarted++;
      } else {
        logger.debug({ type: msg.type }, 'STT message');
      }
    });

    ws.on('error', (err: Error) => {
      logger.error({ err }, 'Deepgram STT error');
      opts.onError?.(err);
    });
    // Keep the socket alive through silences (see KEEPALIVE_MS).
    const keepalive = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'KeepAlive' }));
    }, KEEPALIVE_MS);

    ws.on('close', (code: number, reason: Buffer) => {
      clearInterval(keepalive);
      logger.warn({ code, reason: reason.toString().slice(0, 120) }, 'Deepgram STT socket closed');
      opts.onClose?.();
    });

    await new Promise<void>((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });

    const sendJson = (payload: unknown) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
    };

    return {
      send(chunk: Buffer) {
        if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
      },
      finalize() {
        sendJson({ type: 'Finalize' });
      },
      close() {
        clearInterval(keepalive);
        sendJson({ type: 'CloseStream' });
        ws.close();
      },
      get open() {
        return ws.readyState === WebSocket.OPEN;
      },
    };
  },
};
