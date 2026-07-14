import { describe, expect, it } from 'vitest';
import {
  KqlSafetyError,
  assertKqlPredicate,
  assertReadOnlyKql,
  kqlBracketField,
  kqlDatasetId,
  kqlFiniteNumber,
  kqlInteger,
  kqlStringLiteral,
  kqlTime,
} from '../kql.js';

describe('KQL safety boundary', () => {
  it('escapes quoted, control, and pipeline-looking string data', () => {
    expect(kqlStringLiteral('a"\\\n\u0001| send')).toBe('"a\\"\\\\\\n\\u0001| send"');
  });

  it.each(['', 'otel" | send', '../system', 'a b', 'x'.repeat(129)])(
    'rejects unsafe dataset ID %j',
    (value) => expect(() => kqlDatasetId(value)).toThrow(KqlSafetyError),
  );

  it('accepts conservative field keys and rejects bracket injection', () => {
    expect(kqlBracketField('resource.service/name')).toBe("['resource.service/name']");
    expect(() => kqlBracketField("x'] | send")).toThrow(KqlSafetyError);
  });

  it('bounds numeric values and times', () => {
    expect(kqlFiniteNumber(2.5, { min: 1, max: 3 })).toBe('2.5');
    expect(kqlInteger(20, { min: 1, max: 100 })).toBe('20');
    expect(() => kqlInteger(1.1)).toThrow(KqlSafetyError);
    expect(() => kqlFiniteNumber(Infinity)).toThrow(KqlSafetyError);
    expect(kqlTime('-15m')).toBe('-15m');
    expect(kqlTime('now')).toBe('now');
    expect(() => kqlTime('-1m | send')).toThrow(KqlSafetyError);
  });

  it.each([
    'svc == "checkout" | send',
    'svc == "checkout"; print x=1',
    'join kind=leftouter',
    'lookup secrets',
    'svc == "unterminated',
    '(svc == "x"',
    'svc == "x" // comment',
  ])('rejects non-predicate advanced input %j', (predicate) => {
    expect(() => assertKqlPredicate(predicate)).toThrow(KqlSafetyError);
  });

  it('allows operator-looking text inside predicate string literals', () => {
    expect(assertKqlPredicate('message contains "| send; export"')).toBe(
      'message contains "| send; export"',
    );
  });

  it('allows read-only pipelines scoped to approved datasets', () => {
    const query = 'dataset="otel" | where svc == "api" | summarize count()';
    expect(assertReadOnlyKql(query, ['otel'])).toBe(query);
    expect(assertReadOnlyKql('dataset="$vt_results" | limit 1', ['otel'])).toContain('$vt_results');
  });

  it.each([
    'dataset="otel" | send datatype="owned"',
    'dataset="otel" | export to lookup secrets',
    'dataset="other" | limit 1',
    'dataset=dynamic_name | limit 1',
    'print x=1',
    'dataset="otel"; print x=1',
  ])('rejects unsafe complete query %j', (query) => {
    expect(() => assertReadOnlyKql(query, ['otel'])).toThrow(KqlSafetyError);
  });
});
