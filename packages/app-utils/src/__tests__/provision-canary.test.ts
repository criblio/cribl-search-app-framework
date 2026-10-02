/**
 * Decision tree for the post-reconcile canary. The failures it exists for
 * reported success in every API layer: a sentinel search wiped to
 * `dataset=""` that ran on schedule and wrote nothing, and a lookup
 * written through a `(?i)` regex that nothing could join against.
 */
import { describe, expect, it } from 'vitest';
import { runProvisionCanary } from '../provision-canary.js';
import type { SearchHttpClient } from '../search-job.js';

/** Scripts result rows by a substring of the job's query. */
function fakeSearch(
  rowsByNeedle: Record<string, Record<string, unknown>[]>,
  opts: { failOn?: string } = {},
): { http: SearchHttpClient; queries: { query: string; earliest: string }[] } {
  const queries: { query: string; earliest: string }[] = [];
  const jobs = new Map<string, string>();
  const http: SearchHttpClient = {
    post: async (_path, body) => {
      const { query, earliest } = body as { query: string; earliest: string };
      queries.push({ query, earliest });
      if (opts.failOn && query.includes(opts.failOn)) throw new Error('POST failed (400): bad query');
      const id = `job-${jobs.size}`;
      jobs.set(id, query);
      return { items: [{ id, status: 'completed' }] };
    },
    get: async (path) => {
      const id = /\/jobs\/([^/?]+)/.exec(path)?.[1] ?? '';
      if (!path.includes('/results?')) return { items: [{ id, status: 'completed' }] };
      const query = jobs.get(id) ?? '';
      const rows = Object.entries(rowsByNeedle).find(([needle]) => query.includes(needle))?.[1] ?? [];
      return ['{"isFinished":true}', ...rows.map((r) => JSON.stringify(r))].join('\n') + '\n';
    },
  };
  return { http, queries };
}

const SENTINEL = 'app__summary';
const lookupProbe = { name: 'app_owners', kql: 'dataset="otel" | take 50 | lookup app_owners on svc | summarize total=count(), joined=countif(isnotnull(owner))' };

describe('runProvisionCanary — sentinel', () => {
  it('passes when the sentinel has $vt_results rows', async () => {
    const { http, queries } = fakeSearch({ [SENTINEL]: [{ jobName: SENTINEL }] });
    const report = await runProvisionCanary(http, { sentinelSearchId: SENTINEL });
    expect(report).toEqual({
      ok: true,
      probes: [expect.objectContaining({ name: `sentinel ${SENTINEL}`, ok: true, tolerated: false, rowCount: 1 })],
    });
    expect(queries[0]).toEqual({
      query: `dataset="$vt_results" | where jobName == "${SENTINEL}" | limit 1`,
      earliest: '-2h',
    });
  });

  it('FAILS on zero rows — the dataset="" search that runs and writes nothing', async () => {
    const { http } = fakeSearch({});
    const report = await runProvisionCanary(http, { sentinelSearchId: SENTINEL });
    expect(report.ok).toBe(false);
    expect(report.probes[0]?.message).toContain('ZERO');
  });

  it('tolerates zero rows on first install, and says so', async () => {
    const { http } = fakeSearch({});
    const report = await runProvisionCanary(http, { sentinelSearchId: SENTINEL, firstInstall: true });
    expect(report.ok).toBe(true);
    expect(report.probes[0]).toMatchObject({ ok: true, tolerated: true });
  });

  it('a failing sentinel query fails even on first install', async () => {
    const { http } = fakeSearch({}, { failOn: '$vt_results' });
    const report = await runProvisionCanary(http, { sentinelSearchId: SENTINEL, firstInstall: true });
    expect(report.probes[0]).toMatchObject({ ok: false, tolerated: false });
    expect(report.probes[0]?.message).toContain('sentinel query failed');
  });

  it('quotes the sentinel id rather than splicing it', async () => {
    const { http, queries } = fakeSearch({});
    await runProvisionCanary(http, { sentinelSearchId: 'a" or true or "', sentinelWindow: '-6h' });
    expect(queries[0]?.query).toContain('jobName == "a\\" or true or \\""');
    expect(queries[0]?.earliest).toBe('-6h');
  });
});

describe('runProvisionCanary — lookup join', () => {
  const sentinel = { [SENTINEL]: [{ jobName: SENTINEL }] };

  it('passes when sampled keys join', async () => {
    const { http } = fakeSearch({ ...sentinel, 'lookup app_owners': [{ total: 50, joined: 12 }] });
    const report = await runProvisionCanary(http, { sentinelSearchId: SENTINEL, lookupProbe });
    expect(report.ok).toBe(true);
    expect(report.probes[1]?.message).toContain('12/50');
  });

  it('FAILS when sampled keys join zero times — the unjoinable-CSV shape', async () => {
    const { http } = fakeSearch({ ...sentinel, 'lookup app_owners': [{ total: 50, joined: 0 }] });
    const report = await runProvisionCanary(http, { sentinelSearchId: SENTINEL, lookupProbe });
    expect(report.ok).toBe(false);
    expect(report.probes[1]).toMatchObject({ name: 'lookup app_owners', ok: false });
    expect(report.probes[1]?.message).toContain('ZERO joined');
  });

  it('tolerates zero joined on first install', async () => {
    const { http } = fakeSearch({ ...sentinel, 'lookup app_owners': [{ total: 50, joined: 0 }] });
    const report = await runProvisionCanary(http, { sentinelSearchId: SENTINEL, lookupProbe, firstInstall: true });
    expect(report.probes[1]).toMatchObject({ ok: true, tolerated: true });
  });

  it('FAILS when there are no keys to sample, and tolerates it on first install', async () => {
    const empty = fakeSearch({ ...sentinel, 'lookup app_owners': [{ total: 0, joined: 0 }] });
    expect((await runProvisionCanary(empty.http, { sentinelSearchId: SENTINEL, lookupProbe })).ok).toBe(false);
    const none = fakeSearch({ ...sentinel });
    const report = await runProvisionCanary(none.http, { sentinelSearchId: SENTINEL, lookupProbe, firstInstall: true });
    expect(report.probes[1]).toMatchObject({ ok: true, tolerated: true });
  });

  it('a failing probe query is a failure, not a throw', async () => {
    const { http } = fakeSearch(sentinel, { failOn: 'lookup app_owners' });
    const report = await runProvisionCanary(http, { sentinelSearchId: SENTINEL, lookupProbe });
    expect(report.probes[1]?.message).toContain('lookup probe query failed');
  });
});

describe('runProvisionCanary — extra probes', () => {
  it('runs app probes with the shared query helper and contains their throws', async () => {
    const { http } = fakeSearch({ [SENTINEL]: [{ jobName: SENTINEL }], 'my_check': [{ n: 3 }] });
    const report = await runProvisionCanary(http, {
      sentinelSearchId: SENTINEL,
      extraProbes: [
        {
          name: 'round trip',
          run: async ({ query, firstInstall }) => {
            const rows = await query('dataset="otel" | my_check');
            return { ok: rows.length === 1 && !firstInstall, tolerated: false, rowCount: rows.length, message: 'ok' };
          },
        },
        {
          name: 'broken',
          run: async () => {
            throw new Error('boom');
          },
        },
      ],
    });
    expect(report.probes.slice(1)).toEqual([
      { name: 'round trip', ok: true, tolerated: false, rowCount: 1, message: 'ok' },
      { name: 'broken', ok: false, tolerated: false, rowCount: 0, message: 'probe failed: boom' },
    ]);
    expect(report.ok).toBe(false);
  });
});
