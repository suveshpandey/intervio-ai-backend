/**
 * Lead-in sounds — "Okay, got it." — spoken right before the next question, the
 * way a person acknowledges an answer before asking the next thing.
 *
 * They play the instant the question text exists, from memory, so they also
 * cover the ~0.5s the question's own audio takes to synthesise: the reply starts
 * sooner. (Played at the start of the wait instead, they left an awkward gap
 * between the filler and the question.)
 *
 * Synthesising a clip live costs ~0.8-1.5s, so every clip is made once per
 * voice, trimmed, and kept in memory (~0.5MB per voice). Until a voice's set is
 * ready, turns simply have no filler.
 */

import { logger } from '@/common/logger';
import { deepgramTts } from '@/modules/voice/deepgram.tts';
import { findVoice } from '@/modules/voice/voices';
import { TTS_SAMPLE_RATE } from '@/modules/voice/types';

/** Chosen by ear with the user, identical for every voice. ("Hmm" variants were dropped — odd in every voice.) */
const NEUTRAL = ['Okay...', 'Alright...'];
/** Only after a real answer — "Makes sense." after "I don't know" sounds absurd. */
const ACKNOWLEDGE = ['Makes sense.', 'Okay, makes sense.', 'Got it.', 'Okay, got it.', 'Understood.'];

/** Question openers that already do a filler's job. */
const ALREADY_ACKNOWLEDGES =
  /^\s*(okay|ok|alright|all right|got it|makes sense|understood|great|nice|thanks|thank you|no worries|sure|right|i see|that makes sense|that sounds)\b/i;

/** Answers at least this long count as "real" enough to acknowledge. */
const ACKNOWLEDGE_MIN_WORDS = 15;

/**
 * Flux voices can pad a clip with 1-2s of leading silence (seen on Marcus at
 * expressivity 2) — which would be MORE dead air. Trim to the speech itself.
 */
const SILENCE_THRESHOLD = 800;
/**
 * A beat of silence after the filler, before the question. Back-to-back
 * ("Got it.How did you…") sounds rushed; a person pauses briefly in between.
 */
const PAUSE_AFTER_MS = 400;
const PAUSE_AFTER = Buffer.alloc(Math.round((PAUSE_AFTER_MS / 1000) * TTS_SAMPLE_RATE) * 2);
const TRIM_PAD_SAMPLES = Math.round(0.04 * TTS_SAMPLE_RATE);

export interface Filler {
  text: string;
  pcm: Buffer;
}

/** In-flight synthesis per voice, so concurrent sessions share one run. */
const pending = new Map<string, Promise<void>>();
/** Finished sets — read synchronously, so picking can never race the next question. */
const ready = new Map<string, Filler[]>();

/** Start (or reuse) synthesis of a voice's fillers. Never throws. */
export function warmFillers(voiceId: string | undefined): void {
  const id = findVoice(voiceId).id;
  if (ready.has(id) || pending.has(id)) return;
  const job = synthesise(id)
    .then((set) => void ready.set(id, set))
    .catch((err: unknown) => {
      logger.warn({ err, voice: id }, 'filler synthesis failed — interviews continue without fillers');
    })
    .finally(() => pending.delete(id)); // on failure the next session retries
  pending.set(id, job);
}

/**
 * A filler for this turn, or null (not ready yet / nothing suitable).
 * Never returns `avoid` — the same sound twice in a row is what makes it robotic.
 */
export function pickFiller(
  voiceId: string | undefined,
  answer: string,
  question: string,
  avoid: string | null,
): Filler | null {
  // The question already acknowledges ("Got it, so…") — a filler would double it.
  if (ALREADY_ACKNOWLEDGES.test(question)) return null;

  // Still synthesising (or failed) — this turn just goes without.
  const set = ready.get(findVoice(voiceId).id);
  if (!set?.length) return null;

  const substantive = answer.split(/\s+/).filter(Boolean).length >= ACKNOWLEDGE_MIN_WORDS;
  const pool = substantive ? [...NEUTRAL, ...ACKNOWLEDGE] : NEUTRAL;
  const options = set.filter((f) => pool.includes(f.text) && f.text !== avoid);
  return options[Math.floor(Math.random() * options.length)] ?? null;
}

async function synthesise(voiceId: string): Promise<Filler[]> {
  const t0 = Date.now();
  // Its own connection, so building the set never delays the interview's real speech.
  const tts = await deepgramTts.openSession({ model: voiceId });
  try {
    const out: Filler[] = [];
    for (const text of [...NEUTRAL, ...ACKNOWLEDGE]) {
      const chunks: Buffer[] = [];
      for await (const chunk of tts.speak(text)) chunks.push(chunk);
      const pcm = trimSilence(Buffer.concat(chunks));
      if (pcm.length) out.push({ text, pcm: Buffer.concat([pcm, PAUSE_AFTER]) });
    }
    logger.info({ voice: voiceId, clips: out.length, ms: Date.now() - t0 }, 'fillers ready');
    return out;
  } finally {
    tts.close();
  }
}

/** Cut leading/trailing near-silence from PCM16, keeping a short natural pad. */
export function trimSilence(pcm: Buffer): Buffer {
  const samples = Math.floor(pcm.length / 2);
  let first = -1;
  let last = -1;
  for (let i = 0; i < samples; i++) {
    if (Math.abs(pcm.readInt16LE(i * 2)) > SILENCE_THRESHOLD) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) return Buffer.alloc(0);
  const start = Math.max(0, first - TRIM_PAD_SAMPLES);
  const end = Math.min(samples, last + TRIM_PAD_SAMPLES);
  return pcm.subarray(start * 2, end * 2);
}
