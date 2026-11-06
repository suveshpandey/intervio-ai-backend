import { describe, expect, it } from 'vitest';
import {
  NOT_STARTED_AFTER_SEC,
  REJOIN_WINDOW_SEC,
  EXPIRY_GRACE_SEC,
  returnBy,
} from '@/modules/interview/lifecycle';

const at = (sec: number) => new Date(1_700_000_000_000 + sec * 1000);

describe('returnBy', () => {
  it('a planned interview closes 5 minutes after it was created', () => {
    const d = returnBy({
      status: 'planned',
      createdAt: at(0),
      startedAt: null,
      lastLeftAt: null,
      durationMin: 15,
    });
    expect(d).toEqual(at(NOT_STARTED_AFTER_SEC));
  });

  it('a live interview someone is sitting in has no countdown', () => {
    expect(
      returnBy({
        status: 'live',
        createdAt: at(0),
        startedAt: at(10),
        lastLeftAt: null,
        durationMin: 15,
      }),
    ).toBeNull();
  });

  it('after leaving, the candidate has 10 minutes', () => {
    const d = returnBy({
      status: 'live',
      createdAt: at(0),
      startedAt: at(10),
      lastLeftAt: at(100),
      durationMin: 15,
    });
    expect(d).toEqual(at(100 + REJOIN_WINDOW_SEC));
  });

  it("never outlasts the interview's own time", () => {
    // Left at minute 14 of 15: the clock ends it before 10 minutes are up.
    const d = returnBy({
      status: 'live',
      createdAt: at(0),
      startedAt: at(0),
      lastLeftAt: at(14 * 60),
      durationMin: 15,
    });
    expect(d).toEqual(at(15 * 60 + EXPIRY_GRACE_SEC));
  });

  it('finished interviews have no countdown', () => {
    for (const status of ['completed', 'abandoned', 'not_started']) {
      expect(
        returnBy({
          status,
          createdAt: at(0),
          startedAt: at(1),
          lastLeftAt: at(2),
          durationMin: 15,
        }),
      ).toBeNull();
    }
  });
});
