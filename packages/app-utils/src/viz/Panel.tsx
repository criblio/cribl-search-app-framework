import type { ReactNode } from 'react';
import s from './viz.module.css';

interface Props {
  title: string;
  subtitle?: string;
  error?: string | null;
  refreshing?: boolean;
  empty?: boolean;
  emptyMessage?: string;
  children: ReactNode;
}

/** Card wrapper for non-chart panels (tables, bar lists). */
export default function Panel({
  title,
  subtitle,
  error,
  refreshing = false,
  empty = false,
  emptyMessage = 'No data in this time range',
  children,
}: Props) {
  return (
    <div className={s.panel}>
      <div className={s.panelHeader}>
        <span className={s.panelTitle}>{title}</span>
        {subtitle && <span className={s.panelSub}>{subtitle}</span>}
      </div>
      {error && <div className={s.panelError}>{error}</div>}
      {!error && empty && <div className={s.panelEmpty}>{emptyMessage}</div>}
      {!error && !empty && <div className={refreshing ? s.refreshing : undefined}>{children}</div>}
    </div>
  );
}
