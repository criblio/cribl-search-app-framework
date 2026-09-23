import { LineChart, Panel, StatTile, toLineSeries } from '@criblio/app-utils/viz';
import type { MetricSeries } from '@criblio/app-utils/metrics';

const trend: MetricSeries[] = [{
  labels: { service: 'example' },
  points: [{ t: 1_700_000_000, v: 2 }, { t: 1_700_000_060, v: 3 }],
}];

export default function App() {
  return <Panel title="Service health">
    <StatTile label="Requests" value={3} />
    <LineChart title="Request rate" series={toLineSeries(trend, { name: labels => labels.service })} />
  </Panel>;
}
