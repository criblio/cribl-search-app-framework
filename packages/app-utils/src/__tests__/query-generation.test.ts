import { describe, expect, it } from 'vitest';
import {
  newQueryGeneration,
  currentQuerySignal,
  withGenerationSignal,
  captureQueryGeneration,
} from '../query-generation.js';

describe('query-generation', () => {
  it('withGenerationSignal prefers an explicit signal, else the current generation', () => {
    const explicit = new AbortController().signal;
    expect(withGenerationSignal(explicit)).toBe(explicit);
    expect(withGenerationSignal()).toBe(currentQuerySignal());
  });

  it('newQueryGeneration aborts the prior signal and installs a fresh one', () => {
    const prior = currentQuerySignal();
    expect(prior.aborted).toBe(false);
    newQueryGeneration();
    expect(prior.aborted).toBe(true);
    const next = currentQuerySignal();
    expect(next).not.toBe(prior);
    expect(next.aborted).toBe(false);
  });

  it('captureQueryGeneration reports staleness once superseded', () => {
    newQueryGeneration();
    const isLive = captureQueryGeneration();
    expect(isLive()).toBe(true);
    newQueryGeneration();
    expect(isLive()).toBe(false);
  });
});
