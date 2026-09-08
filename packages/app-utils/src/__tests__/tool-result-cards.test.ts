/**
 * Rendering contracts for tool-result cards.
 *
 * The cards themselves need a DOM this package does not carry a harness
 * for, so the decisions worth locking down — what counts as a gutter,
 * when an escaped body is safe to decode, which columns a sparse table
 * keeps — live in pure helpers and are tested here.
 */
import { describe, expect, it } from 'vitest';
import {
  codeResultTitle,
  decodeCodeBody,
  parseCodeLines,
} from '../investigator/codeResult.js';
import { formatCell, inferColumns } from '../investigator/ResultTable.js';

describe('decodeCodeBody', () => {
  it('decodes a body that arrived with its escapes intact', () => {
    expect(decodeCodeBody('1\\tfoo\\n2\\tbar')).toBe('1\tfoo\n2\tbar');
  });

  it('leaves a body that already has real newlines alone', () => {
    // The decisive case: a file containing the literal two characters
    // backslash-n (a Go format string, a JS template) must survive.
    const source = 'fmt.Printf("%s\\n", x)\nreturn nil';
    expect(decodeCodeBody(source)).toBe(source);
  });

  it('does not double-decode an escaped backslash', () => {
    expect(decodeCodeBody('C:\\\\new')).toBe('C:\\new');
  });

  it('passes through a single line with nothing to decode', () => {
    expect(decodeCodeBody('package main')).toBe('package main');
  });
});

describe('parseCodeLines', () => {
  it('lifts the line-number gutter into its own field', () => {
    expect(parseCodeLines('1\t# title\n2\tbody')).toEqual([
      { no: 1, text: '# title' },
      { no: 2, text: 'body' },
    ]);
  });

  it('keeps text verbatim when only some lines look numbered', () => {
    // TSV content: stripping a "number-tab" prefix here would silently
    // delete a real column.
    const body = '1\tapples\nnot a line number\t3';
    expect(parseCodeLines(body)).toEqual([
      { text: '1\tapples' },
      { text: 'not a line number\t3' },
    ]);
  });

  it('treats a trailing newline as a terminator, not a blank line', () => {
    expect(parseCodeLines('1\ta\n2\tb\n')).toHaveLength(2);
  });

  it('decodes before splitting, so an escaped body still yields lines', () => {
    expect(parseCodeLines('1\\tfoo\\n2\\tbar')).toEqual([
      { no: 1, text: 'foo' },
      { no: 2, text: 'bar' },
    ]);
  });

  it('returns no lines for an empty body', () => {
    expect(parseCodeLines('')).toEqual([]);
  });
});

describe('codeResultTitle', () => {
  it('lifts the path out of JSON-encoded args', () => {
    expect(
      codeResultTitle({ kind: 'code', tool: 'read_file', args: '{"path":"src/app.ts"}' }),
    ).toBe('src/app.ts');
  });

  it('accepts args that already arrived as an object', () => {
    expect(codeResultTitle({ kind: 'code', args: { path: 'a/b.md' } })).toBe('a/b.md');
  });

  it('falls back to the tool name when args are unparseable', () => {
    expect(codeResultTitle({ kind: 'code', tool: 'read_file', args: 'not json' })).toBe(
      'read_file',
    );
  });

  it('falls back to a generic label when there is nothing to name it', () => {
    expect(codeResultTitle({ kind: 'code' })).toBe('Result');
  });
});

describe('inferColumns', () => {
  it('orders columns by how many rows carry them', () => {
    const rows = [
      { name: 'a', activeSeries: 1 },
      { name: 'b', activeSeries: 2 },
      { name: 'c' },
    ];
    expect(inferColumns(rows)).toEqual(['name', 'activeSeries']);
  });

  it('breaks ties alphabetically so the header does not shuffle', () => {
    expect(inferColumns([{ b: 1, a: 1 }])).toEqual(['a', 'b']);
  });

  it('caps the column count', () => {
    const wide = Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`k${String(i).padStart(2, '0')}`, i]),
    );
    expect(inferColumns([wide], 8)).toHaveLength(8);
  });
});

describe('formatCell', () => {
  it('renders nullish as empty rather than "null"', () => {
    expect(formatCell(null)).toBe('');
    expect(formatCell(undefined)).toBe('');
  });

  it('stringifies a nested label set instead of dropping it', () => {
    expect(formatCell({ job: 'api' })).toBe('{"job":"api"}');
  });

  it('keeps zero and false visible', () => {
    expect(formatCell(0)).toBe('0');
    expect(formatCell(false)).toBe('false');
  });
});
