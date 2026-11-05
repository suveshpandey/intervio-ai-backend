import { describe, it, expect } from 'vitest';
import {
  claimCapacity,
  claimTier,
  normalizeSections,
  rememberTarget,
  selectClaims,
  targetFor,
  targetsFor,
  MAX_TARGETS,
} from '@/modules/planner/planner.service';
import { SECTION_KEYS, SECTION_WEIGHTS } from '@/modules/planner/schema';
import type { Claim } from '@prisma/client';
import type { ClaimAttempts } from '@/modules/planner/claim-history';

const claim = (id: string, importance: number, priority: number, skills: string[] = []): Claim =>
  ({
    id,
    resumeId: 'r1',
    text: `claim ${id}`,
    category: 'impact',
    relatedSkills: skills,
    importance,
    priority,
    status: 'pending',
    confidence: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  }) as unknown as Claim;

describe('claimCapacity', () => {
  it('sizes the plan to the clock', () => {
    // 15min → claim_verification 40% = 6min → 8 turns / 2.5 ≈ 3 claims
    expect(claimCapacity(15 * SECTION_WEIGHTS.claim_verification)).toBe(3);
    // 30min → 12min → 16 turns / 2.5 ≈ 6 claims
    expect(claimCapacity(30 * SECTION_WEIGHTS.claim_verification)).toBe(6);
  });

  it('never promises fewer than 3 or more than 8', () => {
    expect(claimCapacity(0)).toBe(3);
    expect(claimCapacity(1)).toBe(3);
    expect(claimCapacity(999)).toBe(8);
  });
});

describe('normalizeSections', () => {
  it('always sums exactly to the duration', () => {
    for (const duration of [5, 10, 15, 20, 30, 45, 60]) {
      const out = normalizeSections([], duration);
      expect(out.reduce((a, s) => a + s.budgetMin, 0)).toBe(duration);
    }
  });

  it('keeps canonical order and drops unknown keys from the model', () => {
    const out = normalizeSections(
      [
        { key: 'wrap', budgetMin: 5 },
        { key: 'nonsense', budgetMin: 99 },
        { key: 'intro', budgetMin: 3 },
      ],
      20,
    );
    expect(out.map((s) => s.key)).toEqual([...SECTION_KEYS]);
    expect(out.reduce((a, s) => a + s.budgetMin, 0)).toBe(20);
  });

  it('every section gets at least a minute', () => {
    const out = normalizeSections([], 5);
    expect(out.every((s) => s.budgetMin >= 1)).toBe(true);
  });
});

describe('selectClaims', () => {
  const claims = [claim('a', 5, 5), claim('b', 4, 4), claim('c', 3, 3), claim('d', 2, 2)];

  it('takes the highest importance × priority first, up to the capacity', () => {
    expect(selectClaims(claims, [], 2)).toEqual(['a', 'b']);
  });

  it('gives the same plan every time for the same inputs', () => {
    const first = selectClaims(claims, [], 3);
    for (let i = 0; i < 5; i++) expect(selectClaims([...claims].reverse(), [], 3)).toEqual(first);
  });

  it('never returns more claims than exist', () => {
    expect(selectClaims(claims, [], 8)).toHaveLength(4);
  });

  it('JD relevance can outrank a slightly stronger claim', () => {
    // x = 2×4 = 8 (+2 for the Redis match = 10) · y = 3×3 = 9
    const withSkills = [claim('x', 2, 4, ['Redis']), claim('y', 3, 3, [])];
    expect(selectClaims(withSkills, [], 1)).toEqual(['y']);
    expect(selectClaims(withSkills, ['redis'], 1)).toEqual(['x']);
  });

  it('asks again about a claim that failed last time, even if it ranks low', () => {
    const history = new Map<string, ClaimAttempts>([['d', ['insufficient']]]);
    expect(selectClaims(claims, [], 2, history)).toEqual(['d', 'a']);
  });

  it('keeps a claim that held up once, but drops one that held up twice running', () => {
    const once = new Map<string, ClaimAttempts>([['a', ['supported']]]);
    expect(selectClaims(claims, [], 2, once)).toEqual(['a', 'b']);

    const twice = new Map<string, ClaimAttempts>([['a', ['supported', 'supported']]]);
    expect(selectClaims(claims, [], 2, twice)).toEqual(['b', 'c']);
  });

  it('a claim that passed then failed is asked again', () => {
    const history = new Map<string, ClaimAttempts>([['c', ['supported', 'partial']]]);
    expect(selectClaims(claims, [], 1, history)).toEqual(['c']);
  });

  it('still fills the plan with twice-solid claims when nothing else is left', () => {
    const all = new Map<string, ClaimAttempts>(
      claims.map((c) => [c.id, ['supported', 'supported'] as ClaimAttempts]),
    );
    expect(selectClaims(claims, [], 3, all)).toEqual(['a', 'b', 'c']);
  });
});

describe('claimTier', () => {
  it('ranks failed, then untested or held-once, then held-twice', () => {
    expect(claimTier([])).toBe(1);
    expect(claimTier(['supported'])).toBe(1);
    expect(claimTier(['partial'])).toBe(0);
    expect(claimTier(['supported', 'insufficient'])).toBe(0);
    expect(claimTier(['partial', 'supported'])).toBe(1);
    expect(claimTier(['supported', 'supported'])).toBe(2);
  });
});

describe('saved targets (one per role)', () => {
  const t = (role: string, durationMin = 15) => ({
    role,
    level: 'mid' as const,
    difficulty: 'standard' as const,
    durationMin,
    voice: 'flux-marcus-en',
  });

  it('remembers several roles, most recently used first', () => {
    let list = rememberTarget([], t('Software Engineer'));
    list = rememberTarget(list, t('AI Engineer'));
    expect(list.map((x) => x.role)).toEqual(['AI Engineer', 'Software Engineer']);
  });

  it('re-saving a role updates it and moves it to the front, ignoring case', () => {
    const list = rememberTarget(
      [t('AI Engineer'), t('Software Engineer')],
      t('software engineer', 30),
    );
    expect(list.map((x) => x.role)).toEqual(['software engineer', 'AI Engineer']);
    expect(list[0]!.durationMin).toBe(30);
  });

  it('forgets the oldest role past the limit', () => {
    let list: ReturnType<typeof rememberTarget> = [];
    for (let i = 0; i < MAX_TARGETS + 2; i++) list = rememberTarget(list, t(`Role ${i}`));
    expect(list).toHaveLength(MAX_TARGETS);
    expect(list[0]!.role).toBe(`Role ${MAX_TARGETS + 1}`);
  });

  it('falls back to a default target when nothing valid is saved', () => {
    const resume = { extracted: { experience: [{ role: 'Backend Dev' }] }, targets: null };
    expect(targetsFor(resume)).toHaveLength(1);
    expect(targetFor(resume).role).toBe('Backend Dev');
    expect(targetFor({ ...resume, targets: { role: 'old single object' } }).role).toBe(
      'Backend Dev',
    );
  });

  it('start uses the role used last', () => {
    const resume = { extracted: null, targets: [t('AI Engineer'), t('Software Engineer')] };
    expect(targetFor(resume).role).toBe('AI Engineer');
  });
});
