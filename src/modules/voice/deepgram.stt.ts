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
/** Backstop: fires UtteranceEnd if endpointing misses a pause this long. */
const UTTERANCE_END_MS = 1000;

interface DeepgramMessage {
  type?: string;
  is_final?: boolean;
  channel?: { alternatives?: { transcript?: string }[] };
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

    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) return;
      let msg: DeepgramMessage;
      try {
        msg = JSON.parse(data.toString()) as DeepgramMessage;
      } catch {
        return;
      }
      if (msg.type === 'Results') {
        const text = msg.channel?.alternatives?.[0]?.transcript ?? '';
        if (text.trim()) opts.onTranscript({ text, isFinal: Boolean(msg.is_final) });
      } else if (msg.type === 'UtteranceEnd') {
        opts.onUtteranceEnd?.();
      }
    });

    ws.on('error', (err: Error) => {
      logger.error({ err }, 'Deepgram STT error');
      opts.onError?.(err);
    });
    ws.on('close', () => opts.onClose?.());

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
        sendJson({ type: 'CloseStream' });
        ws.close();
      },
    };
  },
};
