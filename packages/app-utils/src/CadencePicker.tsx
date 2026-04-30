/**
 * Cadence dropdown for the Settings page. Pure controlled
 * component — the parent owns the value and persists changes.
 *
 * Typical use:
 *
 *   const [cadence, setCadence] = useState<CadenceOption>(loaded ?? DEFAULT_CADENCE);
 *   const onChange = (v: CadenceOption) => {
 *     setCadence(v);
 *     setSearchCadence(v);          // update the in-memory cache
 *     saveSettings({ ...prev, searchCadence: v });
 *   };
 *   <CadencePicker value={cadence} onChange={onChange} />
 */
import { CADENCE_OPTIONS, type CadenceOption } from './cadence.js';
import s from './CadencePicker.module.css';

export interface CadencePickerProps {
  value: CadenceOption;
  onChange: (next: CadenceOption) => void;
  /** Optional copy. Defaults to a generic explanation. */
  helpText?: React.ReactNode;
  /** Optional label override. */
  label?: string;
  disabled?: boolean;
}

export default function CadencePicker({
  value,
  onChange,
  helpText,
  label = 'Search cadence',
  disabled = false,
}: CadencePickerProps) {
  const selected =
    CADENCE_OPTIONS.find((o) => o.value === value) ?? CADENCE_OPTIONS[2];
  return (
    <div className={s.field}>
      <label className={s.label} htmlFor="cadence-picker">
        {label}
      </label>
      <select
        id="cadence-picker"
        className={s.select}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as CadenceOption)}
      >
        {CADENCE_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      <p className={s.help}>
        {helpText ?? (
          <>
            How often each scheduled search runs. Faster cadence means
            fresher data but more worker load. Currently selected:{' '}
            <strong>{selected.label}</strong> (data lag {selected.lagLabel}).
          </>
        )}
      </p>
    </div>
  );
}
