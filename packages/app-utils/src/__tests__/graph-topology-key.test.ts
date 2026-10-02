/**
 * `topoKey` — when useForceLayout rebuilds its simulation.
 *
 * The defect: the key was `source>target` per link and ignored link ids.
 * When a pair's only edge changed kind (rpc → messaging, so its id changed)
 * the key did not move, the simulation — and its copy of the OLD link — was
 * kept, and the data-only update matched the new id against nothing, so the
 * stale kind and metrics stayed on screen until the topology otherwise
 * changed (APM PR #193).
 */
import { describe, expect, it } from 'vitest';
import { topoKey } from '../graph/useForceLayout.js';
import { linkKeys } from '../graph/linkKeys.js';

const nodes = [
  { id: 'a', size: 1 },
  { id: 'b', size: 1 },
  { id: 'c', size: 1 },
];

describe('topoKey', () => {
  it('changes when a pair keeps its endpoints but its link id changes', () => {
    const before = topoKey(nodes, [{ id: 'a>b:rpc', value: 1, source: 'a', target: 'b' }]);
    const after = topoKey(nodes, [{ id: 'a>b:messaging', value: 1, source: 'a', target: 'b' }]);
    expect(after).not.toBe(before);
  });

  it('after the change, every new link id has a live counterpart (the data-only matcher cannot miss)', () => {
    // Model the hook: the simulation's links are copied when the key changes.
    let liveKey = '';
    let live: { id: string; value: number; source: string; target: string; kind: string }[] = [];
    const render = (links: typeof live) => {
      const key = topoKey(nodes, links);
      if (key !== liveKey) {
        liveKey = key;
        live = links.map((l) => ({ ...l }));
      }
      const liveKeys = new Set(linkKeys(live));
      return linkKeys(links).every((k) => liveKeys.has(k));
    };
    expect(render([{ id: 'a>b:rpc', value: 1, source: 'a', target: 'b', kind: 'rpc' }])).toBe(true);
    expect(render([{ id: 'a>b:messaging', value: 1, source: 'a', target: 'b', kind: 'messaging' }])).toBe(true);
    expect(live[0].kind).toBe('messaging');
  });

  it('is stable across reordering, for id-less and id-carrying links alike', () => {
    const links = [
      { id: 'x', value: 1, source: 'a', target: 'b' },
      { value: 1, source: 'b', target: 'c' },
      { value: 1, source: 'b', target: 'c' },
    ];
    expect(topoKey([...nodes].reverse(), [links[2], links[0], links[1]])).toBe(topoKey(nodes, links));
  });

  it('changes when a link keeps its id but moves to a different pair', () => {
    expect(topoKey(nodes, [{ id: 'e1', value: 1, source: 'a', target: 'b' }])).not.toBe(
      topoKey(nodes, [{ id: 'e1', value: 1, source: 'a', target: 'c' }]),
    );
  });

  it('ignores metric-only changes', () => {
    const links = [{ id: 'e1', value: 1, source: 'a', target: 'b' }];
    expect(topoKey(nodes, links)).toBe(topoKey(nodes, [{ ...links[0], value: 99 }]));
  });
});
