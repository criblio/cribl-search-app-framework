/**
 * Report-card normalization and markdown block segmentation.
 *
 * The fixture is the shape that actually reached a consumer as an escaped
 * JSON blob: a headline plus a markdown report of `##` sections, numbered
 * findings, and indented sub-bullets.
 */
import { describe, expect, it } from 'vitest';
import { reportSections, reportToSummary } from '../investigator/reportResult.js';
import { splitBlocks } from '../investigator/markdownBlocks.js';

const REPORT = [
  '## Scope and method',
  '',
  'Checked the requested one-hour window. Metric discovery found 1,641 active metrics.',
  '',
  '## What the data shows',
  '',
  '### Highest-confidence poor-experience clients',
  '',
  '1. **MacBook-Air-8 — MAC `50:ed:3c:15:60:6e`**',
  '   - AP: **AP Office**, 5 GHz channel 100',
  '   - Satisfaction: **0.89**',
  '',
  '2. **Rosemarysiphone — MAC `9c:fa:76:9c:94:29`**',
  '   - AP: **AP Office**, 5 GHz channel 100',
].join('\n');

describe('reportSections', () => {
  it('splits a report into one finding per heading that has a body', () => {
    // 'What the data shows' is absent on purpose: it is immediately
    // followed by a sub-heading, so it has no prose of its own. See the
    // empty-heading case below.
    const sections = reportSections(REPORT);
    expect(sections.map((f) => f.category)).toEqual([
      'Scope and method',
      'Highest-confidence poor-experience clients',
    ]);
  });

  it('keeps the prose under its heading', () => {
    const [scope] = reportSections(REPORT);
    expect(scope.details).toContain('1,641 active metrics');
    expect(scope.details).not.toContain('Scope and method');
  });

  it('drops a heading that has no body rather than emitting an empty card', () => {
    // "What the data shows" is immediately followed by a sub-heading.
    const sections = reportSections(REPORT);
    expect(sections.find((f) => f.category === 'What the data shows')).toBeUndefined();
  });

  it('keeps a body that opens with no heading at all', () => {
    const sections = reportSections('Just prose, no headings.');
    expect(sections).toEqual([
      { category: 'Investigation findings', details: 'Just prose, no headings.' },
    ]);
  });

  it('returns nothing for an empty report instead of a blank section', () => {
    expect(reportSections('   ')).toEqual([]);
  });
});

describe('reportToSummary', () => {
  it('maps the headline onto the summary conclusion', () => {
    const summary = reportToSummary({ kind: 'report', headline: 'Weak signal on AP Office', report: REPORT });
    expect(summary.kind).toBe('summary');
    expect(summary.conclusion).toBe('Weak signal on AP Office');
    expect(summary.findings.length).toBeGreaterThan(0);
  });

  it('tolerates a payload missing both fields', () => {
    expect(reportToSummary({ kind: 'report' })).toEqual({
      kind: 'summary',
      findings: [],
      conclusion: '',
    });
  });
});

describe('splitBlocks', () => {
  it('recognizes headings instead of leaving literal hashes in prose', () => {
    expect(splitBlocks('## Scope and method')).toEqual([
      { kind: 'heading', level: 2, text: 'Scope and method' },
    ]);
  });

  it('groups an ordered list with its indented children', () => {
    const blocks = splitBlocks(
      ['1. **MacBook-Air-8**', '   - AP: **AP Office**', '   - Satisfaction: **0.89**'].join('\n'),
    );
    expect(blocks).toEqual([
      {
        kind: 'list',
        ordered: true,
        items: [
          {
            text: '**MacBook-Air-8**',
            children: [{ text: 'AP: **AP Office**', children: [] }, { text: 'Satisfaction: **0.89**', children: [] }],
          },
        ],
      },
    ]);
  });

  it('keeps one list across the blank line agents put between items', () => {
    // Splitting here produced a separate list per item, each restarting at "1.".
    const blocks = splitBlocks('1. First\n\n2. Second');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: 'list', ordered: true });
    expect((blocks[0] as { items: unknown[] }).items).toHaveLength(2);
  });

  it('ends a list when prose follows it', () => {
    const blocks = splitBlocks('- a\n- b\n\nBack to prose.');
    expect(blocks.map((b) => b.kind)).toEqual(['list', 'paragraph']);
  });

  it('distinguishes bullets from numbers', () => {
    expect(splitBlocks('- a')).toMatchObject([{ ordered: false }]);
    expect(splitBlocks('1. a')).toMatchObject([{ ordered: true }]);
  });

  it('leaves a table paragraph intact for the table parser', () => {
    const table = '| a | b |\n|---|---|\n| 1 | 2 |';
    expect(splitBlocks(table)).toEqual([{ kind: 'paragraph', text: table }]);
  });

  it('joins a wrapped continuation line onto the item above it', () => {
    const blocks = splitBlocks('- first part\n  continued here');
    expect(blocks).toEqual([
      { kind: 'list', ordered: false, items: [{ text: 'first part continued here', children: [] }] },
    ]);
  });
});
