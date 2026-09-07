# Metrics queries in apps

Use `@criblio/app-utils/metrics` **0.8.3 or later**. Earlier releases reject
valid responses from Cribl builds whose initial status snapshot says `running`
while the complete HTTP body already contains the samples. The shared client
handles both this framing and the older `completed` framing. It rejects explicit
failures and malformed or incomplete responses.

Metrics uses a synchronous GET to
`/m/default_search/search/query?searchJobSource=metrics&datasetId=…`.
The `mq-…` identifier in its response is diagnostic metadata. Do not create or
poll Search jobs to obtain metrics results. Discovery uses the separate
`metrics-catalog` client; successful discovery does not exercise query parsing.

```ts
import {
  queryInstant, queryRange, type MetricSample, type MetricSeries,
} from '@criblio/app-utils/metrics';

const current: MetricSample[] = await queryInstant('sum(my_gauge)', {
  dataset: 'metrics', earliest: '-15m', latest: 'now', signal,
});
// Instant samples have no `points` property. Preserve absence as null.
const value = current[0]?._value ?? null;
const valuesByTenant = new Map(current.map(sample => [
  sample.labels.tenant, sample._value,
]));

const history: MetricSeries[] = await queryRange('sum(rate(my_counter[5m]))', {
  dataset: 'metrics', earliest: '-1h', latest: 'now', step: 60, signal,
});
// Range results have labels and points: [{ t: epochSeconds, v: value }].
// `toLineSeries(history)` from /viz converts these for LineChart.
```

Replace the example metric names and labels with discovered ones. Both instant
`_time` and range `t` are epoch seconds. An instant evaluation time does not
establish the age of the last scrape; query the underlying metric's timestamp
when displaying freshness.

Keep exported types through the app's adapters. An `unknown` cast can conceal
an incorrect result shape while the bundle still builds. Test a populated
instant result and range result through those adapters before building more
widgets. Treat a failed request separately from a successful empty result.

`MetricsQueryError.code` distinguishes `query-failed`, `cancelled`,
`invalid-response` and `incomplete-response`. HTTP/transport errors and aborts
also reject the request. A transport or response failure does not establish
that the PromQL is wrong, or that a metric does not exist.

When scrapes duplicate the same logical series, preserve its semantic labels
while deduplicating. For example, collapse `(tenant, outcome)` copies first,
then sum outcomes for a success-rate denominator. Collapsing to `tenant` alone
chooses the largest outcome instead of the total and inflates success rates.
