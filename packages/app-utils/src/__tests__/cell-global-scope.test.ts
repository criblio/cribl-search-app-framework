/**
 * The modules a cell imports must do nothing at module scope.
 *
 * A workerd isolate (celld, Cloudflare Workers) refuses async I/O, timer
 * setup, and random-value generation in global scope, and it counts
 * `new AbortController()` among them. Break that rule and the worker does
 * not start AT ALL — every session on the node dies at boot with
 *
 *   Uncaught Error: Disallowed operation called within global scope
 *     at index.js:85643:18
 *
 * which names a line in a 4 MB bundle and no module. That already
 * happened: `query-generation.ts` held `let controller = new
 * AbortController()` at module scope, perfectly reasonable for the
 * browser it was written for, and it reaches a cell through
 * `agent-tools` → `metrics` → `search`. Every typecheck and unit test
 * passed; the cell simply refused to boot.
 *
 * So this asserts the property rather than that one line: import each
 * cell-reachable entry point with the forbidden globals instrumented, and
 * require that nothing under `app-utils/src` touched them during
 * evaluation. Calls are RECORDED, not thrown on, so a violation reports
 * the file and function instead of dying inside the module loader; the
 * stack filter is what keeps vitest's own async work from registering.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

/** The entry points a cell host imports. Adding one here is the point:
 *  a new cell-facing subpath should be covered on the day it lands. */
const CELL_ENTRIES = [
  '../agent-tools.js',
  '../agent-tool-defs.js',
  '../cell-cribl.js',
  '../cribl-api-tool.js',
  '../openapi-digest.js',
  '../kql.js',
  '../search-job.js',
  '../metrics.js',
  '../query-generation.js',
];

interface Violation {
  op: string;
  frame: string;
}

/**
 * Instrument the operations workerd forbids in global scope.
 *
 * Returns the violations attributable to this package — a frame naming a
 * file under `app-utils/src`. Anything else on the stack is the test
 * runner or node itself, and counting those would make this fail for
 * reasons that have nothing to do with the cell.
 */
function watchForbiddenGlobals(): { violations: Violation[]; restore: () => void } {
  const violations: Violation[] = [];
  const record = (op: string): void => {
    const frame = (new Error().stack ?? '')
      .split('\n')
      .slice(2)
      .find((line) => /app-utils\/src\//.test(line) && !/__tests__/.test(line));
    if (frame) violations.push({ op, frame: frame.trim() });
  };

  const realAbortController = globalThis.AbortController;
  const realRandom = Math.random;
  const realSetTimeout = globalThis.setTimeout;
  const realSetInterval = globalThis.setInterval;
  const realFetch = globalThis.fetch;
  const realRandomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);

  class WatchedAbortController extends realAbortController {
    constructor() {
      super();
      record('new AbortController()');
    }
  }
  globalThis.AbortController = WatchedAbortController;
  Math.random = () => {
    record('Math.random()');
    return realRandom();
  };
  globalThis.setTimeout = ((...args: Parameters<typeof realSetTimeout>) => {
    record('setTimeout()');
    return realSetTimeout(...args);
  }) as typeof realSetTimeout;
  globalThis.setInterval = ((...args: Parameters<typeof realSetInterval>) => {
    record('setInterval()');
    return realSetInterval(...args);
  }) as typeof realSetInterval;
  globalThis.fetch = ((...args: Parameters<typeof realFetch>) => {
    record('fetch()');
    return realFetch(...args);
  }) as typeof realFetch;
  if (realRandomUUID) {
    globalThis.crypto.randomUUID = () => {
      record('crypto.randomUUID()');
      return realRandomUUID();
    };
  }

  return {
    violations,
    restore() {
      globalThis.AbortController = realAbortController;
      Math.random = realRandom;
      globalThis.setTimeout = realSetTimeout;
      globalThis.setInterval = realSetInterval;
      globalThis.fetch = realFetch;
      if (realRandomUUID) globalThis.crypto.randomUUID = realRandomUUID;
    },
  };
}

afterEach(() => {
  vi.resetModules();
});

describe('a cell can import these without the isolate refusing to boot', () => {
  it.each(CELL_ENTRIES)('%s does nothing at module scope', async (entry) => {
    // A fresh registry, or an already-evaluated module reports clean
    // because its side effect happened during an earlier import.
    vi.resetModules();
    const watch = watchForbiddenGlobals();
    try {
      await import(entry);
    } finally {
      watch.restore();
    }
    expect(watch.violations).toEqual([]);
  });
});
