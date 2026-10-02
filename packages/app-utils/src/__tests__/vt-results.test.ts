/**
 * The batched `$vt_results` reader. Pins the three things the reference
 * app learned the hard way: the `jobName=[...]` array form does not
 * parse, `$vt_results` keeps several runs per search (mixing them shows a
 * flapping row twice), and `runQuery`'s default limit of 200 truncates a
 * batched read.
 */
import { describe, expect, it } from 'vitest';
import { latestRunRows, readVtResults, runStartedMs, vtResultsQuery, type VtRunQuery } from '../vt-results.js';

function recorder(rows: Record<string, unknown>[]) {
  const calls: { kql: string; earliest: string; latest: string; limit: number; signal?: AbortSignal }[] = [];
  const runQuery: VtRunQuery = async (kql, earliest, latest, limit, signal) => {
    calls.push({ kql, earliest, latest, limit, signal });
    return rows;
  };
  return { runQuery, calls };
}

describe('vtResultsQuery', () => {
  it('uses `where jobName in (...)` with quoted, de-duplicated names', () => {
    expect(vtResultsQuery(['a', 'b c', 'a'])).toBe('dataset="$vt_results" | where jobName in ("a", "b c")');
  });

  it('never emits the jobName=[...] array form', () => {
    expect(vtResultsQuery(['a'])).not.toContain('jobName=[');
  });

  it('escapes a hostile name instead of splicing it', () => {
    expect(vtResultsQuery(['x") | send group="search" | where ("'])).toContain('"x\\") | send');
  });
});

describe('latestRunRows', () => {
  it('keeps only the newest run (fixed-width epoch-ms jobId, string max)', () => {
    const rows = [
      { jobId: '1704236905683.aaaaaa', svc: 'api', status: 'firing' },
      { jobId: '1704237205683.bbbbbb', svc: 'api', status: 'ok' },
      { jobId: '1704237205683.bbbbbb', svc: 'db', status: 'ok' },
    ];
    expect(latestRunRows(rows)).toEqual(rows.slice(1));
  });

  it('returns rows unchanged when none carry a jobId', () => {
    const rows = [{ svc: 'api' }];
    expect(latestRunRows(rows)).toBe(rows);
  });
});

describe('runStartedMs', () => {
  it('reads the epoch-ms component of either jobId shape', () => {
    expect(runStartedMs('1704236905683.wgocax')).toBe(1704236905683);
    expect(runStartedMs('app__summary.1776006001058.GcsS5w')).toBe(1776006001058);
  });

  it('returns null for anything else', () => {
    expect(runStartedMs(undefined)).toBeNull();
    expect(runStartedMs('adhoc')).toBeNull();
    expect(runStartedMs('17042369056830.x')).toBeNull();
  });
});

describe('readVtResults', () => {
  it('reads every job in ONE query with a batch-sized limit', async () => {
    const { runQuery, calls } = recorder([]);
    await readVtResults(['a', 'b'], { runQuery });
    expect(calls).toEqual([
      { kql: 'dataset="$vt_results" | where jobName in ("a", "b")', earliest: '-1h', latest: 'now', limit: 10_000, signal: undefined },
    ]);
  });

  it('partitions by jobName, keeps each job\'s newest run, and leaves missing jobs absent', async () => {
    const { runQuery } = recorder([
      { jobName: 'a', jobId: '1700000000000.x', v: 'stale' },
      { jobName: 'a', jobId: '1700000300000.y', v: 'fresh' },
      { jobName: 'b', jobId: '1700000000000.z', v: 'only' },
      { jobName: 'unasked', jobId: '1700000000000.q', v: 'ignored' },
    ]);
    const out = await readVtResults(['a', 'b', 'never_ran'], { runQuery });
    expect([...out.keys()]).toEqual(['a', 'b']);
    expect(out.get('a')?.map((r) => r.v)).toEqual(['fresh']);
    expect(out.get('b')?.map((r) => r.v)).toEqual(['only']);
    expect(out.has('never_ran')).toBe(false);
  });

  it('can keep every retained run', async () => {
    const { runQuery } = recorder([
      { jobName: 'a', jobId: '1700000000000.x' },
      { jobName: 'a', jobId: '1700000300000.y' },
    ]);
    expect((await readVtResults(['a'], { runQuery, latestRunOnly: false })).get('a')).toHaveLength(2);
  });

  it('passes window, limit and signal through', async () => {
    const { runQuery, calls } = recorder([]);
    const signal = new AbortController().signal;
    await readVtResults(['a'], { runQuery, earliest: '-24h', latest: '-5m', limit: 500, signal });
    expect(calls[0]).toMatchObject({ earliest: '-24h', latest: '-5m', limit: 500, signal });
  });

  it('issues no query for an empty list', async () => {
    const { runQuery, calls } = recorder([]);
    expect((await readVtResults([], { runQuery })).size).toBe(0);
    expect(calls).toEqual([]);
  });
});
