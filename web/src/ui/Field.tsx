import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { cx } from './cx.ts';

/** Labela + kontrola + opcioni hint/greška. */
export function Field({
  label,
  hint,
  error,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={cx('field', className)}>
      <span className="field-label">{label}</span>
      {children}
      {error ? <span className="field-error">{error}</span> : hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function TextInput(
  { className, type = 'text', ...rest },
  ref,
) {
  return <input ref={ref} type={type} className={cx('input', className)} {...rest} />;
});

type TimeInputProps = {
  /** "HH:MM" (24h) ili '' */
  value: string;
  onChange: (e: { target: { value: string } }) => void;
  id?: string;
  className?: string;
  disabled?: boolean;
  required?: boolean;
  autoFocus?: boolean;
  /** Granice "HH:MM", uključivo. */
  min?: string;
  max?: string;
  /** Naziv polja za čitače ekrana ("Od", "Do"…); select-ovi dobijaju "<naziv>: sat/minuti". */
  'aria-label': string;
  'aria-invalid'?: boolean;
  'aria-describedby'?: string;
  onKeyDown?: (e: KeyboardEvent<HTMLElement>) => void;
};

const pad2 = (n: number) => String(n).padStart(2, '0');
const toMin = (s: string | undefined, fallback: number) => {
  const m = s ? /^(\d{1,2}):(\d{2})$/.exec(s) : null;
  return m ? Number(m[1]) * 60 + Number(m[2]) : fallback;
};

/**
 * Izbor vremena u 24h formatu: sat (00–23) i minuti (korak 5). Dva <select>-a umesto
 * <input type="time"> jer native polje prati jezik sistema i na engleskom prikazuje AM/PM.
 * onChange dobija { target: { value: "HH:MM" } }, isto kao obično polje.
 */
export function TimeInput({
  value,
  onChange,
  id,
  className,
  disabled,
  required,
  autoFocus,
  min,
  max,
  onKeyDown,
  'aria-label': label,
  'aria-invalid': ariaInvalid,
  'aria-describedby': describedBy,
}: TimeInputProps) {
  const parsed = /^(\d{1,2}):(\d{2})$/.exec(value ?? '');
  const h = parsed ? Number(parsed[1]) : null;
  const m = parsed ? Number(parsed[2]) : null;
  const lo = toMin(min, 0);
  const hi = toMin(max, 23 * 60 + 59);

  const hours: number[] = [];
  for (let x = 0; x < 24; x++) if (x * 60 + 59 >= lo && x * 60 <= hi) hours.push(x);
  const minutes: number[] = [];
  for (let x = 0; x < 60; x += 5) minutes.push(x);
  if (m != null && !minutes.includes(m)) minutes.push(m);
  minutes.sort((a, b) => a - b);
  const allowedMinutes = h == null ? minutes : minutes.filter((x) => h * 60 + x >= lo && h * 60 + x <= hi);

  const emit = (hh: number, mm: number) => {
    const t = Math.min(hi, Math.max(lo, hh * 60 + mm));
    onChange({ target: { value: `${pad2(Math.floor(t / 60))}:${pad2(t % 60)}` } });
  };

  return (
    <span className={cx('time-input', className)} role="group" aria-label={label} onKeyDown={onKeyDown}>
      <select
        id={id}
        autoFocus={autoFocus}
        className="input select time-input-part tabular"
        value={h ?? ''}
        disabled={disabled}
        required={required}
        aria-label={`${label}: sat`}
        aria-invalid={ariaInvalid || undefined}
        aria-describedby={describedBy}
        onChange={(e) => emit(Number(e.target.value), m ?? 0)}
      >
        {h == null && <option value="">--</option>}
        {hours.map((x) => (
          <option key={x} value={x}>
            {pad2(x)}
          </option>
        ))}
      </select>
      <span className="time-input-sep" aria-hidden="true">
        :
      </span>
      <select
        className="input select time-input-part tabular"
        value={m ?? ''}
        disabled={disabled}
        required={required}
        aria-label={`${label}: minuti`}
        aria-invalid={ariaInvalid || undefined}
        aria-describedby={describedBy}
        onChange={(e) => emit(h ?? 0, Number(e.target.value))}
      >
        {m == null && <option value="">--</option>}
        {allowedMinutes.map((x) => (
          <option key={x} value={x}>
            {pad2(x)}
          </option>
        ))}
      </select>
    </span>
  );
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cx('input select', className)} {...rest}>
      {children}
    </select>
  );
}

/** Textarea koja raste sa sadržajem (minRows redova minimum). */
export const TextArea = forwardRef<
  HTMLTextAreaElement,
  TextareaHTMLAttributes<HTMLTextAreaElement> & { minRows?: number }
>(function TextArea({ className, minRows = 3, value, ...rest }, outerRef) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useImperativeHandle(outerRef, () => ref.current as HTMLTextAreaElement);

  const resize = () => {
    const el = ref.current;
    if (!el) return;
    // Tekst je samo porastao: dovoljno je produžiti polje.
    if (el.scrollHeight > el.clientHeight) {
      el.style.height = `${el.scrollHeight + 2}px`;
      return;
    }
    // Za merenje se polje na trenutak skupi; stranica (ili sheet) bi se pri tome odskrolovala
    // nagore dok kucaš na dnu dugačke beleške — vrati skrol tamo gde je bio.
    const scroller = el.closest<HTMLElement>('.sheet-body');
    const winY = window.scrollY;
    const innerY = scroller?.scrollTop ?? 0;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight + 2}px`;
    if (window.scrollY !== winY) window.scrollTo(window.scrollX, winY);
    if (scroller && scroller.scrollTop !== innerY) scroller.scrollTop = innerY;
  };

  // Pre iscrtavanja, da polje ni na trenutak ne bude odsečeno.
  useLayoutEffect(resize, [value]);
  useEffect(() => {
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  return <textarea ref={ref} rows={minRows} className={cx('input textarea', className)} value={value} {...rest} />;
});
