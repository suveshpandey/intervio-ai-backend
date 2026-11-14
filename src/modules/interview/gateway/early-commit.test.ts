import { describe, expect, it } from 'vitest';
import {
  earlyCommitHoldMs,
  endsUnfinished,
  looksFinished,
} from '@/modules/interview/gateway/early-commit';

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

describe('endsUnfinished', () => {
  it('flags text that stops mid-thought', () => {
    expect(endsUnfinished('The main delay was in, I think, the')).toBe(true);
    expect(endsUnfinished("I'm I'm I'm, you know,")).toBe(true);
    expect(endsUnfinished('the the')).toBe(true);
  });
  it('lets finished sentences through', () => {
    expect(endsUnfinished('It was working fine.')).toBe(false);
    expect(endsUnfinished('Who are you?')).toBe(false);
    expect(endsUnfinished('')).toBe(false);
  });
});
