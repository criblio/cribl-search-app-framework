import type { ReactNode } from 'react';
import s from './viz.module.css';

interface Props {
  label: string;
  value: ReactNode;
  sub?: string;
  loading?: boolean;
}

/** Stat tile: label over a semibold value, optional context line. */
export default function StatTile({ label, value, sub, loading = false }: Props) {
  return (
    <div className={s.statTile}>
      <span className={s.statLabel}>{label}</span>
      <span className={s.statValue}>{loading ? '…' : value}</span>
      {sub && <span className={s.statSub}>{sub}</span>}
    </div>
  );
}
