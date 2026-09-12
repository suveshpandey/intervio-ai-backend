/**
 * Provider-agnostic voice interfaces (PRD §9).
 *
 * The gateway only ever talks to these, so swapping Deepgram for another vendor
 * means writing one new file — nothing in the interview flow changes.
 */

/** Audio format we use everywhere on the wire: raw PCM, 16-bit signed, mono. */
export const AUDIO_ENCODING = 'linear16' as const;
/** Mic → STT. 16k captures speech consonants (up to 8kHz) at minimum bandwidth. */
export const STT_SAMPLE_RATE = 16_000;
/** TTS → browser. Higher rate costs nothing extra and sounds noticeably better. */
export const TTS_SAMPLE_RATE = 24_000;

export interface TranscriptChunk {
  text: string;
  /** false = interim (live caption), true = settled text we can act on. */
  isFinal: boolean;
}

export interface SttCallbacks {
  onTranscript(chunk: TranscriptChunk): void;
  /** Deepgram decided the speaker stopped — our primary turn-end signal. */
  onUtteranceEnd?(): void;
  onError?(err: Error): void;
  onClose?(): void;
}

export interface SttStreamOptions extends SttCallbacks {
  /** Domain terms to bias recognition toward (we pass the candidate's own skills). */
  keyterms?: string[];
  sampleRate?: number;
}

export interface SttStream {
  /** Push a PCM16 frame. */
  send(chunk: Buffer): void;
  /** Ask for any buffered audio to be transcribed now. */
  finalize(): void;
  close(): void;
}

export interface SpeechToTextProvider {
  openStream(opts: SttStreamOptions): Promise<SttStream>;
}

export interface TtsOptions {
  /** Override the configured voice. */
  model?: string;
  signal?: AbortSignal;
}

/**
 * A TTS connection held open for a whole interview.
 *
 * Measured: opening a Deepgram socket costs 2–4s, while synthesising on an
 * already-open one returns first audio in ~400–700ms (and speeds up with reuse).
 * So we pay the handshake once per interview, never per turn.
 */
export interface TtsSession {
  /** Streams PCM16 chunks for one utterance as they are synthesised. */
  speak(text: string, opts?: TtsOptions): AsyncIterable<Buffer>;
  close(): void;
}

export interface TextToSpeechProvider {
  openSession(opts?: TtsOptions): Promise<TtsSession>;
}
