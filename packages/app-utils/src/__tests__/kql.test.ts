import { describe, expect, it } from 'vitest';
import {
  ANY_DATASET,
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

  describe('ANY_DATASET', () => {
    it('accepts a dataset no allowlist would have named', () => {
      // The point of the mode: a host that explores a workspace can't
      // enumerate the legal datasets up front.
      const query = 'dataset="whatever_they_made" | limit 1';
      expect(assertReadOnlyKql(query, ANY_DATASET)).toBe(query);
      expect(() => assertReadOnlyKql(query, ['otel'])).toThrow(KqlSafetyError);
    });

    it.each([
      'dataset="otel" | send datatype="owned"',
      'dataset="otel" | export to lookup secrets',
      'dataset=dynamic_name | limit 1',
      'dataset="otel"; print x=1',
      'print x=1',
      '.show tables',
      'dataset="otel" | where svc == "x"); drop',
    ])('still rejects non-read query %j', (query) => {
      // Waiving membership must waive NOTHING else — a write is still
      // a write whatever dataset it names.
      expect(() => assertReadOnlyKql(query, ANY_DATASET)).toThrow(KqlSafetyError);
    });

    it('rejects a dataset name that is not a plain identifier', () => {
      // The name reaches a query as-is, so shape is still checked;
      // only the membership test is waived.
      expect(() => assertReadOnlyKql('dataset="a b" | limit 1', ANY_DATASET)).toThrow(
        KqlSafetyError,
      );
      expect(() => assertReadOnlyKql('dataset="a\\" | send x" | limit 1', ANY_DATASET)).toThrow(
        KqlSafetyError,
      );
    });

    it('still allows the virtual results dataset', () => {
      expect(assertReadOnlyKql('dataset="$vt_results" | limit 1', ANY_DATASET)).toContain(
        '$vt_results',
      );
    });
  });
});
