/** Value formatters shared by charts, tiles, and tables. */

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

export function formatBytes(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs < 1) return `${value.toFixed(value === 0 ? 0 : 2)} B`;
  const exp = Math.min(Math.floor(Math.log(abs) / Math.log(1024)), BYTE_UNITS.length - 1);
  const scaled = value / 1024 ** exp;
  return `${scaled >= 100 ? scaled.toFixed(0) : scaled.toFixed(1)} ${BYTE_UNITS[exp]}`;
}

/** Bytes/second, shown as B/s .. TB/s. */
export function formatBytesRate(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return `${formatBytes(value)}/s`;
}

/** Bits/second from a bps value (wifi TX/RX rates, port speeds). */
export function formatBitsRate(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  const units = ['bps', 'Kbps', 'Mbps', 'Gbps'];
  if (abs < 1000) return `${value.toFixed(0)} bps`;
  const exp = Math.min(Math.floor(Math.log10(abs) / 3), units.length - 1);
  const scaled = value / 1000 ** exp;
  return `${scaled >= 100 ? scaled.toFixed(0) : scaled.toFixed(1)} ${units[exp]}`;
}

/** 12.9K / 4.2M style compact counts. */
export function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (abs >= 10_000) return `${(value / 1e3).toFixed(1)}K`;
  if (Number.isInteger(value)) return value.toLocaleString('en-US');
  return abs >= 100 ? value.toFixed(0) : value.toFixed(abs >= 1 ? 1 : 2);
}

/** Seconds → "37d 4h" / "5h 12m" / "8m". */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const d = Math.floor(seconds / 86_400);
  const h = Math.floor((seconds % 86_400) / 3_600);
  const m = Math.floor((seconds % 3_600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${Math.floor(seconds)}s`;
}

/** Ratio (0..1 or 0..100) → percent. Unpoller ratios are 0..100 already. */
export function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)}%`;
}

export function formatSeconds(value: number): string {
  if (!Number.isFinite(value)) return '—';
  if (value < 0.001) return `${(value * 1e6).toFixed(0)}µs`;
  if (value < 1) return `${(value * 1e3).toFixed(1)}ms`;
  return `${value.toFixed(2)}s`;
}

export function formatDb(value: number): string {
  if (!Number.isFinite(value)) return '—';
  return `${value.toFixed(0)} dB`;
}

export type ValueKind =
  | 'count'
  | 'bytes'
  | 'bytesRate'
  | 'bitsRate'
  | 'percent'
  | 'duration'
  | 'seconds'
  | 'db'
  | 'celsius';

export function formatValue(value: number, kind: ValueKind = 'count'): string {
  switch (kind) {
    case 'bytes':
      return formatBytes(value);
    case 'bytesRate':
      return formatBytesRate(value);
    case 'bitsRate':
      return formatBitsRate(value);
    case 'percent':
      return formatPercent(value);
    case 'duration':
      return formatDuration(value);
    case 'seconds':
      return formatSeconds(value);
    case 'db':
      return formatDb(value);
    case 'celsius':
      return Number.isFinite(value) ? `${value.toFixed(1)}°C` : '—';
    default:
      return formatCompact(value);
  }
}
