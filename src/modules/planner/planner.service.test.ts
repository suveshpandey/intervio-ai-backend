import { describe, it, expect } from 'vitest';
import { claimCapacity, normalizeSections, selectClaims } from '@/modules/planner/planner.service';
import { SECTION_KEYS, SECTION_WEIGHTS } from '@/modules/planner/schema';
import type { Claim } from '@prisma/client';

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

  it('honours the capacity cap', () => {
    const out = selectClaims(['a', 'b', 'c', 'd'], claims, [], 2);
    expect(out).toEqual(['a', 'b']);
  });

  it('drops ids the model invented', () => {
    const out = selectClaims(['ghost', 'b'], claims, [], 3);
    expect(out).toContain('b');
    expect(out).not.toContain('ghost');
  });

  it('tops up by importance × priority when the model under-picks', () => {
    const out = selectClaims([], claims, [], 2);
    expect(out).toEqual(['a', 'b']); // highest scores first
  });

  it('JD relevance can outrank a slightly stronger claim', () => {
    // x = 2×4 = 8 (+2 for the Redis match = 10) · y = 3×3 = 9
    const withSkills = [claim('x', 2, 4, ['Redis']), claim('y', 3, 3, [])];

    // Without a JD, the raw score wins.
    expect(selectClaims([], withSkills, [], 1)).toEqual(['y']);
    // With a matching JD skill, the boost flips it (case-insensitively).
    expect(selectClaims([], withSkills, ['redis'], 1)).toEqual(['x']);
  });
});
