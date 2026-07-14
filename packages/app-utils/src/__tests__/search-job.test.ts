import { describe, expect, it } from 'vitest';
import {
  SearchJobError,
  runSearchJob,
  type SearchHttpClient,
} from '../search-job.js';

function completedClient(results: unknown): SearchHttpClient {
  return {
    post: async () => ({ items: [{ id: 'job-1', status: 'completed' }] }),
    get: async (path) => path.includes('/results?')
      ? results
      : { items: [{ id: 'job-1', status: 'completed' }] },
  };
}

describe('runSearchJob', () => {
  it('runs through an injected client and parses NDJSON rows', async () => {
    const rows = await runSearchJob(
      completedClient('{"fields":["svc"]}\n{"svc":"api"}\n{"svc":"worker"}\n'),
      'dataset="otel" | limit 2',
      { limit: 2 },
    );
    expect(rows).toEqual([{ svc: 'api' }, { svc: 'worker' }]);
  });

  it('fails closed on malformed NDJSON instead of silently dropping rows', async () => {
    const promise = runSearchJob(
      completedClient('{"fields":[]}\n{"ok":true}\nnot-json\n'),
      'dataset="otel"',
    );
    await expect(promise).rejects.toMatchObject({ kind: 'malformed-response', jobId: 'job-1' });
  });

  it('cancels the server job when the caller aborts', async () => {
    const controller = new AbortController();
    const deleted: string[] = [];
    const client: SearchHttpClient = {
      post: async () => ({ items: [{ id: 'job-2', status: 'queued' }] }),
      get: async () => {
        controller.abort();
        return { items: [{ id: 'job-2', status: 'running' }] };
      },
      del: async (path) => { deleted.push(path); return {}; },
    };
    const promise = runSearchJob(client, 'dataset="otel"', {
      signal: controller.signal,
      pollIntervalMs: 0,
    });
    await expect(promise).rejects.toBeInstanceOf(SearchJobError);
    await Promise.resolve();
    expect(deleted).toEqual(['/m/default_search/search/jobs/job-2']);
  });

  it('surfaces terminal failures with a stable error kind', async () => {
    const client: SearchHttpClient = {
      post: async () => ({ items: [{ id: 'job-3', status: 'failed' }] }),
      get: async () => ({}),
    };
    await expect(runSearchJob(client, 'dataset="otel"')).rejects.toMatchObject({
      kind: 'job',
      jobId: 'job-3',
    });
  });
});
