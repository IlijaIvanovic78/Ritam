import type { BlockStatus } from '../../../../shared/types.ts';
import { useT } from '../../i18n/index.ts';
import { Icon, cx, type IconName } from '../../ui/index.ts';

const OPTIONS: Array<{
  value: Exclude<BlockStatus, 'pending'>;
  icon: IconName;
  label: 'status.done' | 'status.partial' | 'status.skipped';
}> = [
  { value: 'done', icon: 'check', label: 'status.done' },
  { value: 'partial', icon: 'half', label: 'status.partial' },
  { value: 'skipped', icon: 'x', label: 'status.skipped' },
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
  const t = useT();
  return (
    <div
      className={cx('day-status', value !== 'pending' && 'has-value')}
      role="group"
      aria-label={label}
      aria-disabled={disabled || undefined}
    >
      {OPTIONS.map((o) => {
        const active = value === o.value;
        const text = t(o.label);
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={active}
            aria-label={text}
            title={disabled ? undefined : text}
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
