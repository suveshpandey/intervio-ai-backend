import { describe, it, expect } from 'vitest';
import {
  computeReport,
  skillScores,
  dimensionScores,
  auditClaims,
  assessReadiness,
  type ReportTurn,
  type ReportEvidence,
  type PlannedClaim,
} from '@/modules/report/scoring';
import type { EvalResult } from '@/modules/interview/types';

function makeEval(over: Partial<EvalResult> = {}): EvalResult {
  return {
    answerQuality: 0.8,
    technicalDepth: 0.7,
    claimEvidence: 'support',
    issue: 'none',
    actionSuggested: 'MOVE_ON',
    reason: '',
    nextObjective: '',
    answerSummary: '',
    skills: [],
    ...over,
  };
}

function makeTurn(idx: number, over: Partial<ReportTurn> = {}): ReportTurn {
  return {
    id: `t${idx}`,
    idx,
    claimId: 'c1',
    question: `Q${idx}`,
    answer: `A${idx}`,
    eval: makeEval(),
    ...over,
  };
}

const CLAIMS: PlannedClaim[] = [
  { id: 'c1', text: 'Cut API latency from 800ms to 180ms' },
  { id: 'c2', text: 'Led a team of 4' },
];

describe('skill scores', () => {
  it('averages a skill across answers and reports the sample count', () => {
    const turns = [
      makeTurn(0, { eval: makeEval({ skills: [{ skill: 'Caching (Redis)', score: 0.8 }] }) }),
      makeTurn(1, { eval: makeEval({ skills: [{ skill: 'caching_redis', score: 0.4 }] }) }),
    ];
    // Same skill, three spellings the model uses interchangeably.
    expect(skillScores(turns)).toEqual([{ skill: 'caching redis', score: 6, samples: 2 }]);
  });
});

describe('dimensions', () => {
  it('counts vague answers against specificity, not against depth', () => {
    const turns = [
      makeTurn(0, { eval: makeEval({ issue: 'generic', technicalDepth: 0.7 }) }),
      makeTurn(1, { eval: makeEval({ issue: 'none', technicalDepth: 0.7 }) }),
    ];
    const dims = dimensionScores(turns);
    expect(dims.find((d) => d.key === 'specificity')?.score).toBe(5);
    expect(dims.find((d) => d.key === 'depth')?.score).toBe(7);
  });
});

describe('claim audit', () => {
  it('bands a well-supported claim as supported, with its evidence attached', () => {
    const turns = [
      makeTurn(0, { eval: makeEval({ claimEvidence: 'support', answerQuality: 0.9 }) }),
      makeTurn(1, { eval: makeEval({ claimEvidence: 'support', answerQuality: 0.9 }) }),
      makeTurn(2, { eval: makeEval({ claimEvidence: 'support', answerQuality: 0.9 }) }),
    ];
    const evidence: ReportEvidence[] = [
      { claimId: 'c1', turnId: 't1', polarity: 'support', rationale: 'Gave the p95 numbers.' },
    ];
    const [c1] = auditClaims(turns, evidence, CLAIMS);
    expect(c1!.band).toBe('supported');
    expect(c1!.confidence).toBeGreaterThanOrEqual(0.7);
    expect(c1!.evidence).toEqual([
      { turnIdx: 1, polarity: 'support', rationale: 'Gave the p95 numbers.', quote: 'A1' },
    ]);
  });

  it('bands a claim settled in ONE convincing answer as supported', () => {
    // The engine moves on when an answer resolves a claim; the report must not
    // punish that by calling a well-defended claim "partial".
    const turns = [makeTurn(0, { eval: makeEval({ claimEvidence: 'support', answerQuality: 0.9 }) })];
    expect(auditClaims(turns, [], CLAIMS)[0]!.band).toBe('supported');
  });

  it('bands a claim the candidate could not back up as insufficient', () => {
    const turns = [makeTurn(0, { eval: makeEval({ claimEvidence: 'none', issue: 'no_answer', answerQuality: 0.1 }) })];
    expect(auditClaims(turns, [], CLAIMS)[0]!.band).toBe('insufficient');
  });

  it('a claim that was never asked about is "not covered", NOT a failure', () => {
    const audit = auditClaims([makeTurn(0)], [], CLAIMS);
    expect(audit[1]!.band).toBe('not_covered');
    expect(audit[1]!.turnsSpent).toBe(0);
  });

  it('weakening evidence pulls confidence back down', () => {
    const strong = auditClaims([makeTurn(0), makeTurn(1)], [], CLAIMS)[0]!.confidence;
    const withDoubt = auditClaims(
      [makeTurn(0), makeTurn(1), makeTurn(2, { eval: makeEval({ claimEvidence: 'weaken' }) })],
      [],
      CLAIMS,
    )[0]!.confidence;
    expect(withDoubt).toBeLessThan(strong);
  });
});

describe('readiness', () => {
  const dims = (depth: number, quality: number) => [
    { key: 'depth' as const, label: '', score: depth, detail: '' },
    { key: 'quality' as const, label: '', score: quality, detail: '' },
    { key: 'specificity' as const, label: '', score: 8, detail: '' },
  ];

  it('is ready when most claims held up and the answers had depth', () => {
    const audit = auditClaims(
      [makeTurn(0), makeTurn(1), makeTurn(2), makeTurn(3, { claimId: 'c2' })],
      [],
      CLAIMS,
    );
    expect(assessReadiness(audit, dims(7, 7), []).verdict).toBe('ready');
  });

  it('is not ready when nothing was backed up, and says exactly which claim', () => {
    const audit = auditClaims(
      [makeTurn(0, { eval: makeEval({ claimEvidence: 'none', answerQuality: 0.2 }) })],
      [],
      CLAIMS,
    );
    const readiness = assessReadiness(audit, dims(3, 3), []);
    expect(readiness.verdict).toBe('not_ready');
    expect(readiness.gaps[0]).toContain('Cut API latency');
  });

  it('never counts an unasked claim against the verdict', () => {
    const oneClaimOnly = auditClaims([makeTurn(0), makeTurn(1), makeTurn(2)], [], CLAIMS);
    const readiness = assessReadiness(oneClaimOnly, dims(7, 7), []);
    expect(readiness.verdict).toBe('ready'); // c2 was never asked
    expect(readiness.gaps.join(' ')).not.toContain('Led a team');
    expect(readiness.reasons.join(' ')).toContain('not reached');
  });

  it('flags a weak skill only once it has enough samples', () => {
    const audit = auditClaims([makeTurn(0)], [], CLAIMS);
    const oneSample = assessReadiness(audit, dims(7, 7), [{ skill: 'kafka', score: 3, samples: 1 }]);
    const twoSamples = assessReadiness(audit, dims(7, 7), [{ skill: 'kafka', score: 3, samples: 2 }]);
    expect(oneSample.gaps.join(' ')).not.toContain('kafka');
    expect(twoSamples.gaps.join(' ')).toContain('kafka');
  });
});

describe('computeReport', () => {
  it('summarises the interview and caps improvements at three', () => {
    const turns = [
      makeTurn(0, { eval: makeEval({ claimEvidence: 'none', issue: 'generic', answerQuality: 0.2, technicalDepth: 0.2, skills: [{ skill: 'redis', score: 0.3 }] }) }),
      makeTurn(1, { eval: makeEval({ claimEvidence: 'none', issue: 'generic', answerQuality: 0.2, technicalDepth: 0.2, skills: [{ skill: 'redis', score: 0.3 }] }) }),
      makeTurn(2, { claimId: 'c2', eval: makeEval({ claimEvidence: 'none', issue: 'no_answer', answerQuality: 0.1, technicalDepth: 0.1 }) }),
    ];
    const report = computeReport(turns, [], CLAIMS);
    expect(report.stats).toEqual({ answeredTurns: 3, claimsProbed: 2, claimsSupported: 0, claimsNotCovered: 0 });
    expect(report.readiness.verdict).toBe('not_ready');
    expect(report.improvements.length).toBe(3);
  });

  it('never repeats the same claim advice — one item covers them all', () => {
    const turns = [0, 1, 2].map((i) =>
      makeTurn(i, {
        claimId: `c${i + 1}`,
        eval: makeEval({ claimEvidence: 'none', issue: 'no_answer', answerQuality: 0.1 }),
      }),
    );
    const claims = [...CLAIMS, { id: 'c3', text: 'Cut infra costs by 40%' }];
    const { improvements } = computeReport(turns, [], claims);
    const claimItems = improvements.filter((i) => /claim|back up/i.test(i.title + i.detail));
    expect(claimItems.length).toBe(1);
    expect(claimItems[0]!.title).toContain('3 claims');
  });

  it('ignores turns that were never answered', () => {
    const report = computeReport([makeTurn(0), makeTurn(1, { answer: '' })], [], CLAIMS);
    expect(report.stats.answeredTurns).toBe(1);
  });
});
