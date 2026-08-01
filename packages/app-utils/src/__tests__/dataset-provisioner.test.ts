import { describe, expect, it, vi } from 'vitest';
import {
  ensureAcceleratedFields,
  getAcceleratedFieldsStatus,
} from '../dataset-provisioner.js';
import type { HttpClient } from '../provisioner.js';

function mockHttp(dataset: Record<string, unknown>): HttpClient {
  return {
    get: vi.fn().mockResolvedValue({ items: [dataset] }),
    post: vi.fn(),
    patch: vi.fn(),
    del: vi.fn(),
  };
}

describe('dataset accelerated fields', () => {
  it('reads accelerated field names from cacheConnectionInfo', async () => {
    const http = mockHttp({
      id: 'otel',
      cacheConnectionInfo: { acceleratedFields: ['service_name', 'status_code'] },
    });

    await expect(
      getAcceleratedFieldsStatus(http, '/datasets/otel', ['service_name', 'kind']),
    ).resolves.toEqual({
      ok: false,
      present: ['service_name', 'status_code'],
      missing: ['kind'],
    });
  });

  it('patches the nested string array and preserves cache metadata', async () => {
    const http = mockHttp({
      id: 'otel',
      type: 'cribl_search',
      cacheConnectionInfo: {
        acceleratedFields: ['existing'],
        cacheRef: 'main-cache',
        retentionInDays: 30,
      },
    });

    await expect(
      ensureAcceleratedFields(http, '/datasets/otel', ['existing', 'service_name']),
    ).resolves.toEqual({ action: 'update', added: ['service_name'] });
    expect(http.patch).toHaveBeenCalledWith('/datasets/otel', {
      cacheConnectionInfo: {
        acceleratedFields: ['existing', 'service_name'],
        cacheRef: 'main-cache',
        retentionInDays: 30,
      },
    });
  });

  it('does not patch when all expected fields are already present', async () => {
    const http = mockHttp({
      id: 'otel',
      cacheConnectionInfo: { acceleratedFields: ['service_name'] },
    });

    await expect(
      ensureAcceleratedFields(http, '/datasets/otel', ['service_name']),
    ).resolves.toEqual({ action: 'noop', added: [] });
    expect(http.patch).not.toHaveBeenCalled();
  });
});
