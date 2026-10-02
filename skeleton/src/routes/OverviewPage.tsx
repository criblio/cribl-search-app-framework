import { useDataset } from '@criblio/app-utils/dataset';

/** Placeholder home page. Replace with the app's default view. */
export default function OverviewPage() {
  const dataset = useDataset();
  return (
    <div>
      <h1>Overview</h1>
      <p>
        Replace this page with the app's default view. Queries read the current
        dataset (<code>{dataset || 'not set'}</code>) through <code>src/data/dataset.ts</code>.
      </p>
    </div>
  );
}
