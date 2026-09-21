import { describe, it, expect } from 'vitest';
import { storePrefetch, takePrefetch, clearPrefetch } from '@/modules/interview/engine/prefetch';
import type { Decision } from '@/modules/interview/types';

const MOVE: Decision = {
  action: 'MOVE_ON',
  objective: 'Probe the next claim',
  claimId: 'c2',
  overrode: true,
  rationale: 'x',
};

describe('question prefetch', () => {
  it('is used for the exact turn and move it was prepared for', async () => {
    storePrefetch('i1', 3, MOVE, Promise.resolve('Walk me through c2?'));
    expect(await takePrefetch('i1', 3, { ...MOVE, rationale: 'different wording is fine' })).toBe(
      'Walk me through c2?',
    );
  });

  it('is consumed once', async () => {
    storePrefetch('i1', 3, MOVE, Promise.resolve('Q'));
    await takePrefetch('i1', 3, MOVE);
    expect(await takePrefetch('i1', 3, MOVE)).toBeNull();
  });

  it('never answers a follow-up, a different claim, a section jump or a stale turn', async () => {
    const cases: [number, Decision][] = [
      [3, { ...MOVE, action: 'PROBE' }],
      [3, { ...MOVE, claimId: 'c3' }],
      [3, { ...MOVE, gotoSectionIdx: 2 }],
      [3, { ...MOVE, finished: true }],
      [4, MOVE],
    ];
    for (const [turn, decision] of cases) {
      storePrefetch('i1', 3, MOVE, Promise.resolve('Q'));
      expect(await takePrefetch('i1', turn, decision)).toBeNull();
    }
  });

  it('is gone after clear', async () => {
    storePrefetch('i1', 3, MOVE, Promise.resolve('Q'));
    clearPrefetch('i1');
    expect(await takePrefetch('i1', 3, MOVE)).toBeNull();
  });
});
