/**
 * One banner naming every panel whose data failed to load.
 *
 * A monitoring page that swallows a failed query renders an empty table
 * and "0 errors", which reads as "all good" — the worst false signal the
 * page can give. APM's home showed a failed error-rate query as a healthy
 * service list until this banner existed. Pair it with `usePageLoad`
 * (`@criblio/app-utils/page-load`), whose `failures` it renders directly,
 * and also pass each failure to its own panel's `error` prop so it shows
 * where the user is looking.
 *
 * Built on Capra's `<Alert>` (an optional peer dependency, as for the
 * other Capra-based components), so subpath-only: never re-exported from
 * the package root.
 */
import { Alert } from '@capra/core';

export const PARTIAL_FAILURE_TITLE =
  'Some data is unavailable. Empty values below are not evidence of health.';

export interface PartialFailureBannerProps {
  /** Panel label → error message. Empty renders nothing. */
  failures: Readonly<Record<string, string>> | ReadonlyMap<string, string>;
  /** Re-run the failed reads; omit to render no Retry button. */
  onRetry?: () => void;
}

export function PartialFailureBanner({ failures, onRetry }: PartialFailureBannerProps) {
  const entries = failures instanceof Map
    ? [...(failures as ReadonlyMap<string, string>).entries()]
    : Object.entries(failures as Readonly<Record<string, string>>);
  if (entries.length === 0) return null;
  return (
    <Alert
      appearance="danger"
      layout="section"
      title={PARTIAL_FAILURE_TITLE}
      action={onRetry ? { label: 'Retry unavailable data', onClick: () => onRetry() } : undefined}
    >
      <ul>
        {entries.map(([panel, message]) => (
          <li key={panel}><strong>{panel}:</strong> {message}</li>
        ))}
      </ul>
    </Alert>
  );
}
