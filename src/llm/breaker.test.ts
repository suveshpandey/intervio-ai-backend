import { describe, it, expect, beforeEach } from 'vitest';
import { isOpen, recordFailure, recordSuccess, resetBreakers } from '@/llm/breaker';

const MODEL = 'test-model';

describe('circuit breaker', () => {
  beforeEach(resetBreakers);

  it('keeps calling a model that is merely flaky', () => {
    recordFailure(MODEL);
    recordFailure(MODEL);
    expect(isOpen(MODEL)).toBe(false);
  });

  it('stops calling a model after three failures in a row', () => {
    for (let i = 0; i < 3; i++) recordFailure(MODEL);
    expect(isOpen(MODEL)).toBe(true);
  });

  it('a success in between clears the count', () => {
    recordFailure(MODEL);
    recordFailure(MODEL);
    recordSuccess(MODEL);
    recordFailure(MODEL);
    expect(isOpen(MODEL)).toBe(false);
  });

  it('tries again once the cooldown has passed', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i++) recordFailure(MODEL, t0);
    expect(isOpen(MODEL, t0 + 29_000)).toBe(true);
    expect(isOpen(MODEL, t0 + 31_000)).toBe(false); // half-open: one call gets through
  });

  it('re-opens immediately if that one attempt fails again', () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i++) recordFailure(MODEL, t0);
    isOpen(MODEL, t0 + 31_000); // half-open
    recordFailure(MODEL, t0 + 31_000);
    expect(isOpen(MODEL, t0 + 32_000)).toBe(true);
  });

  it('tracks each model separately', () => {
    for (let i = 0; i < 3; i++) recordFailure(MODEL);
    expect(isOpen('another-model')).toBe(false);
  });
});
