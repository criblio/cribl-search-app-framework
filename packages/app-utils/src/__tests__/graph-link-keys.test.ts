/**
 * `linkKeys` — NetworkGraph edge identity.
 *
 * Two defects: parallel edges both keyed `source>target` (a React key
 * collision that dropped one edge), and data-only updates that copied link
 * metrics by array index, so a reordered links array painted each edge with
 * another edge's traffic.
 */
import { describe, expect, it } from 'vitest';
import { linkKeys } from '../graph/linkKeys.js';

describe('linkKeys', () => {
  it('keeps the historical source>target key for a single edge', () => {
    expect(linkKeys([{ source: 'a', target: 'b' }])).toEqual(['a>b']);
  });

  it('gives parallel edges distinct keys', () => {
    const keys = linkKeys([
      { source: 'a', target: 'b' },
      { source: 'a', target: 'b' },
      { source: 'b', target: 'a' },
    ]);
    expect(keys).toEqual(['a>b', 'a>b#1', 'b>a']);
    expect(new Set(keys).size).toBe(3);
  });

  it('reads ids from resolved node objects the same as from strings', () => {
    // d3-force replaces source/target ids with node objects after init.
    expect(linkKeys([{ source: { id: 'a' }, target: { id: 'b' } }])).toEqual(
      linkKeys([{ source: 'a', target: 'b' }]),
    );
  });

  it('prefers an explicit id, so reordered parallel edges keep their identity', () => {
    const before = linkKeys([
      { id: 'http', source: 'a', target: 'b' },
      { id: 'grpc', source: 'a', target: 'b' },
    ]);
    const after = linkKeys([
      { id: 'grpc', source: 'a', target: 'b' },
      { id: 'http', source: 'a', target: 'b' },
    ]);
    expect(before).toEqual(['http', 'grpc']);
    expect(after).toEqual(['grpc', 'http']);
  });

  it('is order-independent for distinct pairs (what the data-update matcher relies on)', () => {
    const links = [
      { source: 'a', target: 'b', value: 1 },
      { source: 'c', target: 'd', value: 2 },
    ];
    const byKey = new Map(linkKeys(links).map((k, i) => [k, links[i].value]));
    const reordered = [links[1], links[0]];
    const matched = linkKeys(reordered).map((k) => byKey.get(k));
    expect(matched).toEqual([2, 1]);
  });
});
