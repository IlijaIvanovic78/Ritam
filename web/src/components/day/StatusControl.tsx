import type { BlockStatus } from '../../../../shared/types.ts';
import { Icon, cx, type IconName } from '../../ui/index.ts';

const OPTIONS: Array<{ value: Exclude<BlockStatus, 'pending'>; icon: IconName; label: string }> = [
  { value: 'done', icon: 'check', label: 'Urađeno' },
  { value: 'partial', icon: 'half', label: 'Delimično' },
  { value: 'skipped', icon: 'x', label: 'Nije urađeno' },
];

/**
 * Tri dugmeta za status bloka (grupa prekidača, aria-pressed). Klik na aktivno vraća blok na
 * "čeka" (pending) — zato nije radio grupa, koja ne može da se poništi.
 */
export function StatusControl({
  value,
  onChange,
  label,
  disabled,
}: {
  value: BlockStatus;
  onChange: (s: BlockStatus) => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <div
      className={cx('day-status', value !== 'pending' && 'has-value')}
      role="group"
      aria-label={label}
      aria-disabled={disabled || undefined}
    >
      {OPTIONS.map((o) => {
        const active = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={active}
            aria-label={o.label}
            title={disabled ? undefined : o.label}
            disabled={disabled}
            className={cx('day-status-btn', `is-${o.value}`, active && 'is-active')}
            onClick={() => onChange(active ? 'pending' : o.value)}
          >
            <Icon name={o.icon} size={18} />
          </button>
        );
      })}
    </div>
  );
}
