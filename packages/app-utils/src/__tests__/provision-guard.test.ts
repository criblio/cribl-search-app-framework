/**
 * The plan guard. Each rule is a failure that shipped through a
 * provisioner reporting success at every step: `dataset=""` in 17 saved
 * searches, overwrite exports of zero rows deleting lookups, a `(?i)`
 * regex writing an unjoinable CSV, names Cribl 400s on in the browser.
 */
import { describe, expect, it } from 'vitest';
import {
  ProvisionPlanError,
  validateProvisionPlan,
  validateProvisionQuery,
  validateSavedSearchName,
} from '../provision-guard.js';
import type { ProvisionedSearch } from '../provisioner.js';

const rules = (id: string, q: string) => validateProvisionQuery(id, q).map((p) => p.rule);

function search(id: string, query: string, name = 'Plain name'): ProvisionedSearch {
  return {
    id,
    name,
    description: '',
    query,
    earliest: '-1h',
    latest: 'now',
    schedule: { enabled: true, cronSchedule: '*/5 * * * *', tz: 'UTC', keepLastN: 2 },
  };
}

describe('validateProvisionQuery', () => {
  it('passes a healthy read query', () => {
    expect(rules('q', 'dataset="otel" | summarize count() by svc')).toEqual([]);
  });

  it('passes a sentinel-first overwrite export', () => {
    const q = `print svc="__sentinel__", n=tolong(0)
      | union (dataset="otel" | summarize n=count() by svc)
      | export mode=overwrite description="x" to lookup my_lookup`;
    expect(rules('q', q)).toEqual([]);
  });

  it('flags dataset="" (the 17-search outage)', () => {
    expect(rules('q', 'dataset="" | limit 1')).toEqual(['dataset-empty']);
  });

  it('flags dataset="" even when a later stage names a dataset', () => {
    expect(rules('q', 'dataset="" | project dataset="otel"')).toContain('dataset-empty');
  });

  it('flags dataset="" inside a sentinel-first union', () => {
    const q = `print k="__s__" | union (dataset="" | summarize by k) | export mode=overwrite to lookup l`;
    expect(rules('q', q)).toEqual(['dataset-empty']);
  });

  it('flags a missing dataset clause', () => {
    expect(rules('q', '| limit 1')).toEqual(['dataset-missing']);
  });

  it('accepts $vt_results and bare dataset ids', () => {
    expect(rules('q', 'dataset="$vt_results" | where jobName == "a"')).toEqual([]);
    expect(rules('q', 'dataset=otel | limit 1')).toEqual([]);
  });

  it('flags (?i) upstream of export-to-lookup', () => {
    const q = `print _raw="__sentinel__"
      | union (dataset="otel" | where _raw matches regex "(?i)consume")
      | export mode=overwrite to lookup my_lookup`;
    expect(rules('q', q)).toEqual(['case-insensitive-regex-before-export']);
  });

  it('allows (?i) without an export', () => {
    expect(rules('q', 'dataset="otel" | where _raw matches regex "(?i)consume"')).toEqual([]);
  });

  it('flags mv-expand upstream of export-to-lookup', () => {
    const q = `print k="__sentinel__"
      | union (dataset="otel" | extend k=bag_keys(attributes) | mv-expand k)
      | export mode=overwrite to lookup my_lookup`;
    expect(rules('q', q)).toEqual(['mv-expand-before-export']);
  });

  it('allows mv-expand without an export', () => {
    expect(rules('q', 'dataset="otel" | extend k=bag_keys(attributes) | mv-expand k')).toEqual([]);
  });

  it('ignores (?i) and mv-expand mentioned only in // comment lines', () => {
    const q = `print _raw="__sentinel__"
      | union (
          dataset="otel"
          // we use [Cc]onsume instead of (?i) here; mv-expand is avoided
          | where _raw matches regex "[Cc]onsume"
        )
      | export mode=overwrite to lookup my_lookup`;
    expect(rules('q', q)).toEqual([]);
  });

  it('flags an overwrite export with no leading sentinel (empty overwrite deletes the lookup)', () => {
    const q = `dataset="otel" | summarize n=count() by svc | export mode=overwrite to lookup my_lookup`;
    expect(rules('q', q)).toEqual(['overwrite-without-sentinel']);
  });

  it('flags the wrong-order union (real first, sentinel branch) — verified to skip the export', () => {
    const q = `dataset="otel" | summarize n=count() by svc
      | union (print svc="__sentinel__", n=tolong(0))
      | export mode=overwrite to lookup my_lookup`;
    expect(rules('q', q)).toEqual(['overwrite-without-sentinel']);
  });

  it('treats an export with no mode= as an overwrite', () => {
    expect(rules('q', 'dataset="otel" | summarize by svc | export to lookup l')).toEqual([
      'overwrite-without-sentinel',
    ]);
  });

  it('does not require a sentinel for an append export', () => {
    expect(rules('q', 'dataset="otel" | summarize by svc | export mode=append to lookup l')).toEqual([]);
  });

  it('accepts a print-only seed query', () => {
    expect(rules('q', 'print svc="__init__", n=tolong(0) | export mode=overwrite to lookup l')).toEqual([]);
  });

  it('flags an empty lookup name at end of query and before a pipe', () => {
    expect(rules('q', 'print a=1 | export mode=overwrite to lookup ')).toEqual(['empty-lookup-name']);
    expect(rules('q', 'print a=1 | export to lookup | limit 1')).toContain('empty-lookup-name');
  });

  it('names the search in every problem', () => {
    const [p] = validateProvisionQuery('app__x', 'dataset="" | limit 1');
    expect(p).toMatchObject({ searchId: 'app__x', rule: 'dataset-empty' });
    expect(p?.message).toContain('dataset=""');
  });
});

describe('validateSavedSearchName', () => {
  it('accepts letters, digits, spaces, underscores and dashes', () => {
    expect(validateSavedSearchName('q', 'My App - 6-day per-service history_1')).toEqual([]);
  });

  it('rejects the names Cribl answered 400 to', () => {
    const [slash] = validateSavedSearchName('q', 'My App - deploy/change events');
    expect(slash?.rule).toBe('invalid-name');
    expect(slash?.message).toContain('"/"');
    const [parens] = validateSavedSearchName('q', 'alert noise budget (per-svc, per-day)');
    expect(parens?.message).toContain('"("');
    expect(parens?.message).toContain('","');
  });

  it('rejects an empty name', () => {
    expect(validateSavedSearchName('q', '')[0]?.message).toContain('is empty');
  });
});

describe('validateProvisionPlan', () => {
  it('passes a healthy plan', () => {
    expect(validateProvisionPlan([search('app__a', 'dataset="otel" | limit 1')], { prefix: 'app__' })).toEqual({
      ok: true,
      problems: [],
    });
  });

  it('aggregates problems across searches, with ids', () => {
    const { ok, problems } = validateProvisionPlan([
      search('app__good', 'dataset="otel" | limit 1'),
      search('app__bad', 'dataset="" | limit 1', 'bad/name'),
    ]);
    expect(ok).toBe(false);
    expect(problems.map((p) => [p.searchId, p.rule])).toEqual([
      ['app__bad', 'dataset-empty'],
      ['app__bad', 'invalid-name'],
    ]);
  });

  it('flags duplicate ids and ids outside the prefix', () => {
    const { problems } = validateProvisionPlan(
      [search('app__a', 'dataset="otel"'), search('app__a', 'dataset="otel"'), search('other', 'dataset="otel"')],
      { prefix: 'app__' },
    );
    expect(problems.map((p) => p.rule)).toEqual(['duplicate-id', 'id-prefix']);
  });

  it('validates seed-lookup queries under seed:<name>', () => {
    const { problems } = validateProvisionPlan([], {
      seedLookups: [
        { name: 'ok_lookup', seedQuery: 'print k="__init__" | export mode=overwrite to lookup ok_lookup' },
        { name: 'bad_lookup', seedQuery: 'dataset="otel" | export mode=overwrite to lookup bad_lookup' },
        { name: ' ', seedQuery: 'print k=1 | export to lookup ' },
      ],
    });
    expect(problems.map((p) => [p.searchId, p.rule])).toEqual([
      ['seed:bad_lookup', 'overwrite-without-sentinel'],
      ['seed: ', 'empty-lookup-name'],
      ['seed: ', 'empty-lookup-name'],
    ]);
  });

  it('skips disabled rules only', () => {
    const { ok, problems } = validateProvisionPlan(
      [search('app__a', 'dataset="otel" | export to lookup l', 'bad/name')],
      { disableRules: ['overwrite-without-sentinel'] },
    );
    expect(ok).toBe(false);
    expect(problems.map((p) => p.rule)).toEqual(['invalid-name']);
  });
});

describe('ProvisionPlanError', () => {
  it('carries the problems and lists them in the message', () => {
    const { problems } = validateProvisionPlan([search('app__a', 'dataset=""')]);
    const err = new ProvisionPlanError(problems);
    expect(err.problems).toBe(problems);
    expect(err.message).toContain('app__a [dataset-empty]');
  });
});
