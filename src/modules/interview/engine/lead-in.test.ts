import { describe, it, expect } from 'vitest';
import { stripLeadIn } from '@/modules/interview/engine/lead-in';

describe('stripLeadIn', () => {
  it('removes the opener a repeat should not replay', () => {
    const cases: [string, string][] = [
      // The bug as reported.
      [
        'Okay, thanks. Can you walk me through how you approach writing automated unit tests?',
        'Can you walk me through how you approach writing automated unit tests?',
      ],
      ['Thanks, can you walk me through the rollout?', 'Can you walk me through the rollout?'],
      ['That sounds interesting, but how did you measure the latency?', 'How did you measure the latency?'],
      ["That's impressive — so what broke first under load?", 'What broke first under load?'],
      ['Got it — so which part did you own personally?', 'Which part did you own personally?'],
      ['Great! Now, how did you handle retries there?', 'How did you handle retries there?'],
      ['Thanks for sharing that. How did you test it?', 'How did you test it?'],
      [
        'No worries at all, let us keep it simple: what projects have you worked on recently?',
        'What projects have you worked on recently?',
      ],
    ];
    for (const [input, expected] of cases) expect(stripLeadIn(input), input).toBe(expected);
  });

  it('leaves a question with no opener alone', () => {
    for (const q of [
      'Can you walk me through how you measured that latency improvement?',
      'How did you decide between Redis and an in-process cache?',
      "Let's switch to your payments work — what did you own end to end?",
    ]) {
      expect(stripLeadIn(q), q).toBe(q);
    }
  });

  it('only touches the start — the same words mid-sentence are part of the question', () => {
    const q = 'What made the cache great for that load, and what would break it?';
    expect(stripLeadIn(q)).toBe(q);
    const q2 = 'How did you know the rollout was okay before going to everyone?';
    expect(stripLeadIn(q2)).toBe(q2);
  });

  it('never reduces a short question to a fragment', () => {
    expect(stripLeadIn('Okay, why?')).toBe('Okay, why?');
    expect(stripLeadIn('Thanks. And then?')).toBe('Thanks. And then?');
  });
});
