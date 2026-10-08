/**
 * Notices when the speech-to-text stream has gone deaf.
 *
 * Seen in real interviews: mid-session, Deepgram keeps receiving loud audio and
 * its own voice detector keeps firing "speech started" — but every result comes
 * back with no words, for good. Half-deaf, it ends turns mid-sentence (no words
 * for 2s looks like "they stopped"); fully deaf, it never ends the turn at all.
 * A fresh stream fixes it, so the session reconnects when this says so.
 *
 * Deliberately conservative, because a false alarm interrupts a real answer:
 *   - Deepgram must have heard speech start, AND
 *   - we must have sent several seconds of genuinely loud audio, AND
 *   - no words may have come back over that whole stretch.
 * A cough (one "speech started", ~0.3s loud) then a silent think never trips it.
 *
 * PURE: the clock is injected, so it is fully unit-tested.
 */

export interface DeafDetectorOptions {
  /** Loud audio, with no words back, before we call the stream deaf. */
  voicedMsThreshold: number;
  /** Minimum gap between two reconnects — a noisy room must not cause a loop. */
  cooldownMs: number;
  /** Frame RMS (int16 scale) that counts as someone actually speaking. */
  voicedRms: number;
}

export const DEFAULT_DEAF_OPTIONS: DeafDetectorOptions = {
  voicedMsThreshold: 3000,
  cooldownMs: 20_000,
  voicedRms: 800,
};

export class DeafDetector {
  /** Loud audio sent since the last word came back. */
  private voicedMs = 0;
  /** Deepgram heard speech start since the last word came back. */
  private speechSeen = false;
  private lastRecoveryAt = Number.NEGATIVE_INFINITY;
  /** Deaf episodes in a row with no words in between. */
  private failures = 0;

  constructor(
    private readonly opts: DeafDetectorOptions = DEFAULT_DEAF_OPTIONS,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** One mic frame sent to the STT stream. */
  onAudio(rms: number, frameMs: number): void {
    if (rms >= this.opts.voicedRms) this.voicedMs += frameMs;
  }

  onSpeechStarted(): void {
    this.speechSeen = true;
  }

  /** Words came back — the stream works. Clears everything, including the failure streak. */
  onWords(): void {
    this.voicedMs = 0;
    this.speechSeen = false;
    this.failures = 0;
  }

  /** The candidate isn't meant to be talking (interviewer speaking, turn being processed, muted). */
  pause(): void {
    this.voicedMs = 0;
    this.speechSeen = false;
  }

  /**
   * Call on a tick while listening. True means: reconnect now.
   * Records the attempt, so the caller just acts on it.
   */
  shouldRecover(): boolean {
    if (!this.speechSeen || this.voicedMs < this.opts.voicedMsThreshold) return false;

    const t = this.now();
    if (t - this.lastRecoveryAt < this.opts.cooldownMs) return false;

    this.lastRecoveryAt = t;
    this.failures += 1;
    this.voicedMs = 0;
    this.speechSeen = false;
    return true;
  }

  /** How many recoveries in a row haven't brought words back. */
  get consecutiveFailures(): number {
    return this.failures;
  }
}

/** Root-mean-square level of a PCM16 frame (0–32767). */
export function frameRms(frame: Buffer): number {
  const samples = Math.floor(frame.length / 2);
  if (samples === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const v = frame.readInt16LE(i * 2);
    sum += v * v;
  }
  return Math.sqrt(sum / samples);
}
