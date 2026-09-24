import { describe, it, expect } from 'vitest';
import { findBannedWord, fallbackNarrative } from '@/modules/report/safe-language';
import type { ComputedReport } from '@/modules/report/scoring';

describe('safe language check', () => {
  it('catches accusations the PRD forbids', () => {
    const accusations = [
      'It looks like you were lying about the latency numbers.',
      'That claim seems fake.',
      'You exaggerated the team size.',
      'The answer was fabricated.',
      'You made it up on the spot.',
    ];
    for (const text of accusations) expect(findBannedWord(text)).not.toBeNull();
  });

  it('allows honest evidence language', () => {
    const fine = [
      "You didn't back that claim up with enough detail.",
      'The answer stayed general, with no specifics from your own work.',
      'There was not enough evidence to confirm the 40% figure.',
      'Insufficient evidence — the interview ran out of time.',
    ];
    for (const text of fine) expect(findBannedWord(text)).toBeNull();
  });

  it('matches whole words, so ordinary technical words survive', () => {
    expect(findBannedWord('You built a deepfake detector, which you explained well.')).toBeNull();
    expect(findBannedWord('You described the fake data generator you wrote for tests.')).toBe('fake');
  });
});

describe('fallback narrative', () => {
  const base: ComputedReport = {
    stats: { answeredTurns: 6, claimsProbed: 3, claimsSupported: 2, claimsNotCovered: 1 },
    skills: [],
    dimensions: [
      { key: 'depth', label: 'Technical depth', score: 7.2, detail: '' },
      { key: 'quality', label: 'Answer quality', score: 7, detail: '' },
      { key: 'specificity', label: 'Specificity', score: 8, detail: '' },
    ],
    claimAudit: [],
    readiness: { verdict: 'almost', reasons: [], gaps: [] },
    improvements: [{ title: 'Go one level deeper', detail: 'Be ready for the follow-up question.' }],
  };

  it('states the real numbers and never accuses', () => {
    const text = fallbackNarrative(base);
    expect(text).toContain('2 of the 3 resume claims');
    expect(text).toContain('7.2/10');
    expect(findBannedWord(text)).toBeNull();
  });

  it('handles an interview where no claim was reached', () => {
    const text = fallbackNarrative({
      ...base,
      stats: { ...base.stats, claimsProbed: 0, claimsSupported: 0 },
      improvements: [],
    });
    expect(text).toContain('No resume claims were covered');
    expect(findBannedWord(text)).toBeNull();
  });
});
