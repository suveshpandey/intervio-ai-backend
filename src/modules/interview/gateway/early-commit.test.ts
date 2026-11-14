import { describe, expect, it } from 'vitest';
import { earlyCommitHoldMs, looksFinished } from '@/modules/interview/gateway/early-commit';

describe('looksFinished', () => {
  it('accepts a full sentence', () => {
    expect(looksFinished('We moved the reports to a read replica.')).toBe(true);
    expect(looksFinished('Why did you choose that approach?')).toBe(true);
  });
  it('rejects fragments and short replies', () => {
    expect(looksFinished('Yes.')).toBe(false);
    expect(looksFinished('We moved the reports to a read replica and then')).toBe(false);
    expect(looksFinished('We moved the reports to a read replica,')).toBe(false);
  });
});

describe('earlyCommitHoldMs', () => {
  it('is off when the base is 0', () => {
    expect(earlyCommitHoldMs(0, 10, 0)).toBe(0);
  });
  it('uses the cautious base until the speaker is known', () => {
    expect(earlyCommitHoldMs(1200, 0, 0)).toBe(1200);
    expect(earlyCommitHoldMs(1200, 1, 3000)).toBe(1200);
  });
  it('shortens for someone who never pauses long', () => {
    expect(earlyCommitHoldMs(1200, 3, 400)).toBe(800);
  });
  it('lengthens with the pauses seen', () => {
    expect(earlyCommitHoldMs(1200, 3, 1000)).toBe(1400);
  });
  it('disables early commit for someone who pauses a lot', () => {
    expect(earlyCommitHoldMs(1200, 3, 1500)).toBe(0);
    expect(earlyCommitHoldMs(1200, 3, 2500)).toBe(0);
  });
});
