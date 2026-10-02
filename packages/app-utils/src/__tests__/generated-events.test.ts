import { describe, expect, it, vi } from 'vitest';
import {
  STORED_DATATYPE_EXPR,
  defineGeneratedEvents,
  eventIdExpr,
  exportToSearchClause,
  runGeneratedEventCanary,
  storedDatatypePredicate,
} from '../generated-events.js';
import { KqlSafetyError } from '../kql.js';

const events = defineGeneratedEvents({
  datatypes: ['myapp_alert', 'myapp_deploy'],
  schemaVersion: 1,
  canaryProducer: 'myapp_contract_canary',
  canaryFields: {
    myapp_alert: { record_kind: 'evaluation', alert_status: 'ok', fire_count: 0 },
    myapp_deploy: { version: 'canary', ratio: 0.5, active: false },
  },
});

describe('stored datatype', () => {
  it('reads both the export column and the legacy send column', () => {
    expect(STORED_DATATYPE_EXPR).toBe('coalesce(tostring(data_datatype), tostring(datatype))');
    expect(storedDatatypePredicate('a_b')).toBe(`${STORED_DATATYPE_EXPR} == "a_b"`);
    expect(storedDatatypePredicate(['a', 'b'])).toBe(`${STORED_DATATYPE_EXPR} in ("a", "b")`);
  });

  it('rejects datatype names that would break out of the literal', () => {
    expect(() => storedDatatypePredicate('x" or true or "')).toThrow(KqlSafetyError);
    expect(() => storedDatatypePredicate([])).toThrow(KqlSafetyError);
  });

  it('a bound contract only accepts its own datatypes', () => {
    expect(events.predicate('myapp_alert')).toBe(`${STORED_DATATYPE_EXPR} == "myapp_alert"`);
    // @ts-expect-error — not in the contract
    expect(() => events.predicate('other_alert')).toThrow(/unsupported generated-event datatype/);
  });
});

describe('eventIdExpr', () => {
  it('prefers event_id and falls back to a legacy composite key', () => {
    expect(eventIdExpr(['alert_id', 'evaluated_at'])).toBe(
      'coalesce(tostring(event_id), strcat("legacy:", tostring(alert_id), ":", tostring(evaluated_at)))',
    );
    expect(eventIdExpr(['a'], 'uid')).toBe('coalesce(tostring(uid), strcat("legacy:", tostring(a)))');
  });

  it('only accepts plain column names', () => {
    expect(() => eventIdExpr([])).toThrow(KqlSafetyError);
    expect(() => eventIdExpr(['a) | send group="x'])).toThrow(KqlSafetyError);
  });
});

describe('write boundary', () => {
  it('writes with export tee=true, never send group="search" (which silently stopped persisting)', () => {
    expect(exportToSearchClause('otel')).toBe('| export tee=true to search "otel"');
    const send = events.canarySend('c1', 'otel');
    expect(send).toContain('| export tee=true to search "otel"');
    expect(send).not.toMatch(/\bsend\b/);
    expect(() => exportToSearchClause('otel" | send')).toThrow(KqlSafetyError);
  });

  it('emits one canary row per datatype, shaped like a real event', () => {
    expect(events.canarySend('c1', 'otel')).toMatchInlineSnapshot(`
      "print datatype="myapp_alert", schema_version=tolong(1), event_id="c1:myapp_alert", producer="myapp_contract_canary", dataset="otel", is_canary=true, record_kind="evaluation", alert_status="ok", fire_count=tolong(0)
      | union (print datatype="myapp_deploy", schema_version=tolong(1), event_id="c1:myapp_deploy", producer="myapp_contract_canary", dataset="otel", is_canary=true, version="canary", ratio=toreal(0.5), active=false)
      | export tee=true to search "otel""
    `);
  });

  it('reads the canaries back through the consumers’ predicate', () => {
    expect(events.canaryRead('c1', 'otel')).toMatchInlineSnapshot(`
      "dataset="otel"
      | where event_id in ("c1:myapp_alert", "c1:myapp_deploy")
      | where coalesce(tostring(data_datatype), tostring(datatype)) in ("myapp_alert", "myapp_deploy")
      | summarize rows=count(), types=dcount(coalesce(tostring(data_datatype), tostring(datatype))), versions=dcount(tolong(schema_version)), canaries=countif(tostring(is_canary)=="true")"
    `);
  });

  it('rejects unsafe ids, datasets and canary fields', () => {
    expect(() => events.canarySend('a b', 'otel')).toThrow(KqlSafetyError);
    expect(() => events.canaryRead('c1', '../x')).toThrow(KqlSafetyError);
    expect(() => defineGeneratedEvents({ datatypes: ['a'], schemaVersion: 1, canaryProducer: 'p', canaryFields: { a: { event_id: 'x' } } }))
      .toThrow(/set by the contract/);
    expect(() => defineGeneratedEvents({ datatypes: ['a'], schemaVersion: 1, canaryProducer: 'p', canaryFields: { a: { 'x=1|': 'y' } } }))
      .toThrow(KqlSafetyError);
    expect(() => defineGeneratedEvents({ datatypes: ['a', 'a'], schemaVersion: 1, canaryProducer: 'p' })).toThrow(/unique/);
    expect(() => defineGeneratedEvents({ datatypes: ['a'], schemaVersion: 0, canaryProducer: 'p' })).toThrow(KqlSafetyError);
  });
});

describe('canary verdict and runner', () => {
  it('passes only when every datatype is back at one schema version', () => {
    expect(events.canaryVerdict([{ rows: 2, types: 2, versions: 1, canaries: 2 }]).ok).toBe(true);
    // Rows landed but the stored datatype of one was renamed or reclassified.
    expect(events.canaryVerdict([{ rows: 2, types: 1, versions: 1, canaries: 2 }])).toMatchObject({ ok: false, types: 1 });
    expect(events.canaryVerdict([{ rows: 2, types: 2, versions: 2, canaries: 2 }]).ok).toBe(false);
    expect(events.canaryVerdict([]).ok).toBe(false);
  });

  it('writes once, polls until the rows are searchable, then stops', async () => {
    const reads = [[{ rows: 0 }], [{ rows: 1, types: 1, versions: 1, canaries: 1 }], [{ rows: 2, types: 2, versions: 1, canaries: 2 }]];
    const run = vi.fn(async (kql: string, _earliest: string, _latest: string) => (kql.includes('export tee=true') ? [] : reads.shift() ?? []));
    const verdict = await runGeneratedEventCanary(events, run, { dataset: 'otel', canaryId: 'c9', pollMs: 0 });
    expect(verdict).toMatchObject({ ok: true, canaryId: 'c9' });
    expect(run).toHaveBeenCalledTimes(4);
    expect(run.mock.calls[0][1]).toBe('-1m');
  });

  it('reports drift as a verdict, not an exception, after the attempts run out', async () => {
    const run = vi.fn(async () => [{ rows: 0 }]);
    const verdict = await runGeneratedEventCanary(events, run, { dataset: 'otel', attempts: 3, pollMs: 0 });
    expect(verdict.ok).toBe(false);
    expect(verdict.message).toMatch(/contract drift/);
    expect(run).toHaveBeenCalledTimes(4);
  });
});
