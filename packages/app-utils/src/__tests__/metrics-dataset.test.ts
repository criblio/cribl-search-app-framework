import { afterEach, describe, expect, it, vi } from 'vitest';
import { setCurrentDataset } from '../dataset.js';
import {
  METRICS_DATASET,
  MetricsQueryError,
  queryInstant,
  queryRange,
  runMetricsQuery,
} from '../metrics.js';

const EMPTY = '{"isFinished":true,"totalEventCount":0,"job":{"status":"completed"}}\n';

afterEach(() => setCurrentDataset(''));

describe('metrics dataset guard', () => {
  it("rejects the app's Search dataset before sending the request", async () => {
    setCurrentDataset('otel');
    const transport = vi.fn(async () => EMPTY);
    const err = await queryRange('sum(rate(traces_span_metrics_calls_total[5m]))', {
      step: 60, dataset: 'otel', transport,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MetricsQueryError);
    expect((err as MetricsQueryError).code).toBe('wrong-dataset');
    expect((err as Error).message).toContain('omit `dataset`');
    expect(transport).not.toHaveBeenCalled();
    await expect(queryInstant('up', { dataset: 'otel', transport })).rejects.toMatchObject({
      code: 'wrong-dataset',
    });
    await expect(runMetricsQuery('up', { dataset: 'otel', transport })).rejects.toMatchObject({
      code: 'wrong-dataset',
    });
    expect(transport).not.toHaveBeenCalled();
  });

  it('uses the metrics default when no dataset is passed', async () => {
    setCurrentDataset('otel');
    const transport = vi.fn(async () => EMPTY);
    await expect(queryRange('up', { step: 60, transport })).resolves.toEqual([]);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('accepts an explicit metrics dataset, including one that matches the default', async () => {
    const transport = vi.fn(async () => EMPTY);
    setCurrentDataset('otel');
    await queryInstant('up', { dataset: 'my_metrics', transport });
    setCurrentDataset(METRICS_DATASET);
    await queryInstant('up', { dataset: METRICS_DATASET, transport });
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('does nothing when no Search dataset is set (Node hosts)', async () => {
    const transport = vi.fn(async () => EMPTY);
    await queryInstant('up', { dataset: 'otel', transport });
    expect(transport).toHaveBeenCalledTimes(1);
  });
});
