import { describe, it, expect } from 'vitest';
import { DeafDetector, frameRms, type DeafDetectorOptions } from '@/modules/interview/gateway/deaf-detector';

const OPTS: DeafDetectorOptions = { voicedMsThreshold: 3000, cooldownMs: 20_000, voicedRms: 800 };
const LOUD = 3000;
const QUIET = 100;

function setup() {
  let t = 1_000_000;
  const d = new DeafDetector(OPTS, () => t);
  return { d, advance: (ms: number) => (t += ms) };
}

/** Feed `ms` of audio in 100ms frames. */
const talk = (d: DeafDetector, ms: number, rms = LOUD) => {
  for (let i = 0; i < ms / 100; i++) d.onAudio(rms, 100);
};

describe('DeafDetector', () => {
  it('fires when speech was heard but seconds of loud audio brought no words', () => {
    const { d } = setup();
    d.onSpeechStarted();
    talk(d, 3000);
    expect(d.shouldRecover()).toBe(true);
    expect(d.consecutiveFailures).toBe(1);
  });

  it('a cough followed by silent thinking never trips it', () => {
    const { d } = setup();
    d.onSpeechStarted();
    talk(d, 300); // the cough
    talk(d, 8000, QUIET); // thinking
    expect(d.shouldRecover()).toBe(false);
  });

  it('loud audio without Deepgram ever hearing speech is not deafness (e.g. room noise)', () => {
    const { d } = setup();
    talk(d, 6000);
    expect(d.shouldRecover()).toBe(false);
  });

  it('any words coming back reset it — a working stream is never reconnected', () => {
    const { d } = setup();
    d.onSpeechStarted();
    talk(d, 2500);
    d.onWords();
    talk(d, 2500);
    expect(d.shouldRecover()).toBe(false);
  });

  it('ignores time when the candidate is not meant to be talking', () => {
    const { d } = setup();
    d.onSpeechStarted();
    talk(d, 2500);
    d.pause(); // interviewer started speaking
    talk(d, 1000);
    expect(d.shouldRecover()).toBe(false);
  });

  it('respects the cooldown so a noisy room cannot cause a reconnect loop', () => {
    const { d, advance } = setup();
    d.onSpeechStarted();
    talk(d, 3000);
    expect(d.shouldRecover()).toBe(true);

    advance(5000);
    d.onSpeechStarted();
    talk(d, 3000);
    expect(d.shouldRecover()).toBe(false); // too soon

    advance(20_000);
    expect(d.shouldRecover()).toBe(true);
    expect(d.consecutiveFailures).toBe(2);
  });

  it('counts failures in a row, and words clear the streak', () => {
    const { d, advance } = setup();
    for (let i = 0; i < 3; i++) {
      d.onSpeechStarted();
      talk(d, 3000);
      d.shouldRecover();
      advance(21_000);
    }
    expect(d.consecutiveFailures).toBe(3);
    d.onWords();
    expect(d.consecutiveFailures).toBe(0);
  });
});

describe('frameRms', () => {
  it('measures loudness of a PCM16 frame', () => {
    const silent = Buffer.alloc(3200);
    expect(frameRms(silent)).toBe(0);

    const tone = Buffer.alloc(3200);
    for (let i = 0; i < 1600; i++) tone.writeInt16LE(i % 2 ? 4000 : -4000, i * 2);
    expect(frameRms(tone)).toBe(4000);
  });
});
