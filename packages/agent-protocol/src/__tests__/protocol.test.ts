import { describe, expect, it } from 'vitest';
import { isTerminalStatus, titleFromPrompt, type SessionStatus } from '../index';

describe('titleFromPrompt', () => {
  it('collapses whitespace to a single-line title', () => {
    expect(titleFromPrompt('why is   checkout\n slow?')).toBe('why is checkout slow?');
  });

  it('truncates long prompts with an ellipsis at 80 chars', () => {
    const long = 'a'.repeat(200);
    const title = titleFromPrompt(long);
    expect(title.length).toBe(80);
    expect(title.endsWith('…')).toBe(true);
  });

  it('keeps short prompts intact', () => {
    expect(titleFromPrompt('payment errors')).toBe('payment errors');
  });

  it('falls back to a default for an empty prompt', () => {
    expect(titleFromPrompt('   ')).toBe('Investigation');
  });
});

describe('isTerminalStatus', () => {
  it('treats concluded/failed/cancelled as terminal', () => {
    for (const s of ['concluded', 'failed', 'cancelled'] as SessionStatus[]) {
      expect(isTerminalStatus(s)).toBe(true);
    }
  });

  it('treats queued/running/idle as live (idle parks, it does not end)', () => {
    for (const s of ['queued', 'running', 'idle'] as SessionStatus[]) {
      expect(isTerminalStatus(s)).toBe(false);
    }
  });
});
