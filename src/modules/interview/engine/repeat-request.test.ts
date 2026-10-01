import { describe, it, expect } from 'vitest';
import { detectRepeatRequest } from '@/modules/interview/engine/repeat-request';

describe('detectRepeatRequest — fast path', () => {
  it('catches the ways people ask to hear it again', () => {
    for (const reply of [
      'Sorry, can you repeat that?',
      'Could you repeat the question?',
      'Can you say that again?',
      "Sorry, I didn't catch that.",
      "I couldn't hear you.",
      'Come again?',
      'Pardon?',
      'One more time please',
      'What?',
      'Sorry?',
      "Sorry I didn't get that",
      'phir se bolo',
    ]) {
      expect(detectRepeatRequest(reply), reply).toBe('repeat');
    }
  });

  it('tells "I didn\'t understand" apart from "I didn\'t hear"', () => {
    for (const reply of [
      "I don't understand the question.",
      'Sorry, what do you mean?',
      'Can you rephrase that?',
      "I'm not sure what you're asking.",
      'Can you explain the question?',
      'That was confusing, sorry.',
      'Could you say it in simpler words?',
    ]) {
      expect(detectRepeatRequest(reply), reply).toBe('clarify');
    }
  });

  it('never mistakes a real answer for a request, even one containing the words', () => {
    for (const reply of [
      'I had to repeat that test three times before it finally passed in CI.',
      "We didn't catch that bug until production because our staging data was too clean.",
      "Honestly the architecture was confusing at first, so I drew out every service and how they talked.",
      'We used Redis with a five minute TTL for the session data.',
      'Yes.',
      'I led the migration.',
    ]) {
      expect(detectRepeatRequest(reply), reply).toBeNull();
    }
  });

  it('ignores empty input', () => {
    expect(detectRepeatRequest('   ')).toBeNull();
  });
});
