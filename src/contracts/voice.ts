/**
 * Live-interview WebSocket protocol (PRD §9), shared with the frontend.
 *
 * Binary frames carry audio in both directions (PCM16 mono).
 * JSON frames carry everything else.
 */

/** Browser → server. */
export type ClientMessage =
  /** Mic is live; start listening. */
  | { type: 'start' }
  | { type: 'mute' }
  | { type: 'unmute' }
  /** Candidate ended the interview early. */
  | { type: 'end' }
  /** DEV ONLY: submit a typed answer instead of speaking (no mic needed). */
  | { type: 'text_answer'; text: string };

/** Server → browser. */
export type ServerMessage =
  /** Live caption of the candidate. `isFinal` text is what we act on. */
  | { type: 'transcript'; text: string; isFinal: boolean }
  /** The interviewer's question — caption arrives before/with the audio. */
  | { type: 'question'; text: string; turnIdx: number; sectionKey: string }
  /** Audio for the current question is finished; the mic may reopen (half-duplex). */
  | { type: 'speech_end' }
  /** Progress for the header. */
  | { type: 'state'; sectionKey: string; turnIdx: number; secondsLeft: number }
  /** The engine is evaluating — lets the UI show a pause. */
  | { type: 'thinking' }
  | { type: 'done' }
  | { type: 'error'; code: string; message: string };

/** Audio format on the wire, both directions. */
export const VOICE_AUDIO = {
  encoding: 'linear16',
  micSampleRate: 16_000,
  ttsSampleRate: 24_000,
} as const;
