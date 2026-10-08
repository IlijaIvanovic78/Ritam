import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { Category } from '../../../shared/types.ts';
import { Icon } from './Icon.tsx';
import { cx } from './cx.ts';

/** Zaglavlje stranice: naslov, podnaslov i akcije desno. */
export function PageHeader({
  title,
  sub,
  actions,
  className,
}: {
  title: ReactNode;
  sub?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cx('page-head', className)}>
      <div className="page-head-text">
        <h1 className="page-title">{title}</h1>
        {sub && <p className="page-sub">{sub}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}

/** Sekcija sa naslovom i opcionim akcijama. */
export function Card({
  title,
  actions,
  children,
  className,
  flush,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Bez unutrašnjeg paddinga (za liste do ivica). */
  flush?: boolean;
}) {
  return (
    <section className={cx('card', flush && 'card-flush', className)}>
      {(title || actions) && (
        <header className="card-head">
          {title && <h2 className="card-title">{title}</h2>}
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      <div className="card-body">{children}</div>
    </section>
  );
}

export function Empty({ title, text, action }: { title: ReactNode; text?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {text && <p className="empty-text">{text}</p>}
      {action && <div className="empty-action">{action}</div>}
    </div>
  );
}

export function Spinner({ small }: { small?: boolean }) {
  return <span className={cx('spinner', small && 'spinner-sm')} role="status" aria-label="Učitavanje" />;
}

export function PageLoader() {
  return (
    <div className="page-loader">
      <Spinner />
    </div>
  );
}

/** Horizontalna traka napretka; value 0..1 (može i > 1, crta se do 100%). */
export function ProgressBar({
  value,
  color,
  label,
  className,
}: {
  value: number;
  color?: string;
  label?: string;
  className?: string;
}) {
  const pct = Math.max(0, Math.min(1, value || 0)) * 100;
  return (
    <div
      className={cx('pbar', className)}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
      aria-label={label}
    >
      <span className="pbar-fill" style={{ width: `${pct}%`, background: color }} />
    </div>
  );
}

/** Kružni indikator; value 0..1 ili null (prazan). */
export function Ring({
  value,
  size = 56,
  stroke = 5,
  color,
  children,
  label,
}: {
  value: number | null;
  size?: number;
  stroke?: number;
  color?: string;
  children?: ReactNode;
  label?: string;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(1, value ?? 0));
  return (
    <div className="ring" style={{ width: size, height: size }} role="img" aria-label={label}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle className="ring-track" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} fill="none" />
        <circle
          className="ring-fill"
          cx={size / 2}
          cy={size / 2}
          r={r}
          strokeWidth={stroke}
          fill="none"
          // Okrugli krajevi crteža dužine 0 bi nacrtali tačku na 12 sati (kao da je napredak počeo).
          strokeLinecap={v > 0 ? 'round' : 'butt'}
          strokeDasharray={`${c * v} ${c}`}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={color ? { stroke: color } : undefined}
        />
      </svg>
      {children != null && <div className="ring-label">{children}</div>}
    </div>
  );
}

/**
 * Strelice u radio grupi biraju prethodnu/sledeću opciju i prebacuju fokus na nju (roving tabindex:
 * samo izabrana opcija je u Tab redosledu). preventDefault sprečava i prečice stranice (← / → dan).
 */
function onRadioKeys<T>(e: KeyboardEvent<HTMLElement>, values: T[], selected: number, pick: (v: T) => void) {
  const step =
    e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
  if (!step || values.length === 0) return;
  e.preventDefault();
  const from = selected < 0 ? (step > 0 ? -1 : 0) : selected;
  const next = (from + step + values.length) % values.length;
  pick(values[next]);
  e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')[next]?.focus();
}

/** Segmentirana kontrola (radio grupa). */
export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  label,
  size = 'md',
  className,
}: {
  value: T;
  options: Array<{ value: T; label: ReactNode; title?: string }>;
  onChange: (v: T) => void;
  label: string;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const selected = options.findIndex((o) => o.value === value);
  return (
    <div
      className={cx('seg', size === 'sm' && 'seg-sm', className)}
      role="radiogroup"
      aria-label={label}
      onKeyDown={(e) => onRadioKeys(e, options.map((o) => o.value), selected, onChange)}
    >
      {options.map((o, i) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={i === selected || (selected < 0 && i === 0) ? 0 : -1}
          className={cx('seg-btn', o.value === value && 'is-active')}
          title={o.title}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function CategoryDot({ color, size = 8 }: { color: string; size?: number }) {
  return <span className="cat-dot" style={{ background: color, width: size, height: size }} aria-hidden="true" />;
}

/** Najduži naziv kategorije (isto ograničenje kao na serveru). */
const CATEGORY_NAME_MAX = 40;

/** Upravljanje izborom kategorije iz forme u kojoj stoji (vidi CategoryPicker). */
export interface CategoryPickerHandle {
  /** Upisan, a još nenapravljen naziv nove kategorije (null ako ga nema). */
  pending(): string | null;
  /**
   * Napravi kategoriju od upisanog naziva, isto kao Enter/✓ (i izabere je). Vraća njen id (null ako
   * nema šta da se napravi); greška se baca, a poruka ostaje uz polje.
   */
  flush(): Promise<number | null>;
}

/**
 * Izbor kategorije kao "čipovi". Sa `onCreate` na kraju je i čip "+ Nova": otvara malo polje za
 * naziv (Enter/✓ pravi kategoriju, Esc/✕ odustaje); napravljena kategorija se odmah izabere.
 * `onCreate` vraća id nove kategorije, a grešku (npr. naziv već postoji) baca — prikazuje se uz polje.
 *
 * Upisan, a nepotvrđen naziv se ne gubi tiho: forma ga pri čuvanju napravi preko `ref.flush()`
 * (čuvanje staje ako ne uspe), a `onPendingChange` javlja da ga ima (nesačuvana izmena).
 * Napuštanje polja (blur) namerno ne pravi kategoriju — blur je i klik na ✕ ili Otkaži.
 */
export const CategoryPicker = forwardRef<
  CategoryPickerHandle,
  {
    categories: Category[];
    value: number | null;
    onChange: (id: number | null) => void;
    allowNone?: boolean;
    label?: string;
    onCreate?: (name: string) => Promise<number | null>;
    /** Da li je upisan naziv nove kategorije koji još nije napravljen. */
    onPendingChange?: (pending: boolean) => void;
  }
>(function CategoryPicker(
  { categories, value, onChange, allowNone = true, label = 'Kategorija', onCreate, onPendingChange },
  ref,
) {
  const values: Array<number | null> = categories.map((c) => c.id);
  if (allowNone) values.push(null);
  const selected = values.indexOf(value);
  const tab = (i: number) => (i === selected || (selected < 0 && i === 0) ? 0 : -1);

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  /** Posle pravljenja/odustajanja fokus ide na izabrani čip, odnosno na "+ Nova". */
  const refocus = useRef<'selected' | 'add' | null>(null);
  /** Zahtev za novu kategoriju koji je u toku (Enter pa odmah "Sačuvaj" čeka isti zahtev). */
  const inflight = useRef<Promise<number | null> | null>(null);

  const pendingName = creating && onCreate ? name.trim() : '';
  const hasPending = pendingName !== '';
  const onPendingRef = useRef(onPendingChange);
  onPendingRef.current = onPendingChange;
  useEffect(() => {
    onPendingRef.current?.(hasPending);
  }, [hasPending]);

  useEffect(() => {
    if (creating) inputRef.current?.focus();
  }, [creating]);

  useEffect(() => {
    const target = refocus.current;
    if (!target || creating) return;
    refocus.current = null;
    const sel = target === 'selected' ? '[role="radio"][aria-checked="true"]' : '.chip-add';
    rootRef.current?.querySelector<HTMLElement>(sel)?.focus();
  });

  const cancel = () => {
    if (busy) return;
    setCreating(false);
    setName('');
    setError(null);
    refocus.current = 'add';
  };

  /** Napravi kategoriju od upisanog naziva; id nove (ili null), greška se baca i prikazuje uz polje. */
  const run = (): Promise<number | null> => {
    if (inflight.current) return inflight.current;
    if (!onCreate) return Promise.resolve(null);
    const trimmed = name.trim();
    if (!trimmed) {
      const msg = 'Upiši naziv kategorije.';
      setError(msg);
      inputRef.current?.focus();
      return Promise.reject(new Error(msg));
    }
    setBusy(true);
    setError(null);
    const p = (async () => {
      try {
        const id = await onCreate(trimmed);
        setCreating(false);
        setName('');
        if (id != null) onChange(id);
        refocus.current = id != null ? 'selected' : 'add';
        return id;
      } catch (e) {
        setError(e instanceof Error && e.message ? e.message : 'Kategorija nije napravljena. Pokušaj ponovo.');
        requestAnimationFrame(() => inputRef.current?.focus());
        throw e;
      } finally {
        setBusy(false);
        inflight.current = null;
      }
    })();
    inflight.current = p;
    return p;
  };

  const create = () => {
    run().catch(() => {
      // greška je već uz polje
    });
  };

  useImperativeHandle(ref, () => ({
    pending: () => (hasPending ? pendingName : null),
    flush: () => (hasPending || inflight.current ? run() : Promise.resolve(null)),
  }));

  const onInputKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter') {
      // Ne šalje formu u kojoj je izbor (npr. "Dodaj blok").
      e.preventDefault();
      create();
    } else if (e.key === 'Escape') {
      // Odustaje samo od nove kategorije; sheet ostaje otvoren.
      e.preventDefault();
      e.stopPropagation();
      cancel();
    }
  };

  const chips = (
    <div
      className="chips"
      role="radiogroup"
      aria-label={label}
      onKeyDown={(e) => {
        // Strelice samo na čipovima kategorija (ne u polju za novu kategoriju).
        if (e.target instanceof HTMLElement && e.target.getAttribute('role') === 'radio') {
          onRadioKeys(e, values, selected, onChange);
        }
      }}
    >
      {categories.map((c, i) => (
        <button
          key={c.id}
          type="button"
          role="radio"
          aria-checked={value === c.id}
          tabIndex={tab(i)}
          className={cx('chip', value === c.id && 'is-active')}
          style={{ ['--cat' as string]: c.color }}
          onClick={() => onChange(c.id)}
        >
          <CategoryDot color={c.color} />
          {c.name}
        </button>
      ))}
      {allowNone && (
        <button
          type="button"
          role="radio"
          aria-checked={value === null}
          tabIndex={tab(categories.length)}
          className={cx('chip', value === null && 'is-active')}
          onClick={() => onChange(null)}
        >
          Bez kategorije
        </button>
      )}
      {onCreate &&
        (creating ? (
          <span className="chip-new">
            <input
              ref={inputRef}
              className={cx('input', 'chip-new-input')}
              value={name}
              maxLength={CATEGORY_NAME_MAX}
              placeholder="Naziv kategorije"
              aria-label="Naziv nove kategorije"
              aria-invalid={!!error || undefined}
              autoComplete="off"
              enterKeyHint="done"
              // Ne disabled: polje zadržava fokus (i Esc) dok zahtev traje.
              readOnly={busy}
              aria-busy={busy || undefined}
              onChange={(e) => {
                setName(e.target.value);
                if (error) setError(null);
              }}
              onKeyDown={onInputKey}
            />
            <button
              type="button"
              className="icon-btn icon-btn-ghost icon-btn-sm"
              aria-label="Dodaj kategoriju"
              title="Dodaj kategoriju"
              disabled={busy}
              onClick={create}
            >
              {busy ? <span className="spinner spinner-sm" aria-hidden="true" /> : <Icon name="check" size={18} />}
            </button>
            <button
              type="button"
              className="icon-btn icon-btn-ghost icon-btn-sm"
              aria-label="Odustani od nove kategorije"
              title="Odustani"
              disabled={busy}
              onClick={cancel}
            >
              <Icon name="x" size={18} />
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="chip chip-add"
            aria-label="Nova kategorija"
            onClick={() => {
              setError(null);
              setCreating(true);
            }}
          >
            <Icon name="plus" size={16} />
            Nova
          </button>
        ))}
    </div>
  );

  if (!onCreate) return chips;
  return (
    <div className="cat-picker" ref={rootRef}>
      {chips}
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
});

/** Prekidač (checkbox stilizovan kao switch). */
export function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: ReactNode;
  disabled?: boolean;
}) {
  return (
    <label className={cx('toggle', disabled && 'is-disabled')}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="toggle-track" aria-hidden="true">
        <span className="toggle-thumb" />
      </span>
      <span className="toggle-label">{label}</span>
    </label>
  );
}

const RATING_LABELS = ['Loš', 'Slab', 'Okej', 'Dobar', 'Odličan'];

/** Ocena dana 1–5; ponovni klik na istu ocenu je briše (null), pa su to prekidači, ne radio grupa. */
export function RatingInput({ value, onChange }: { value: number | null; onChange: (v: number | null) => void }) {
  return (
    <div className="rating" role="group" aria-label="Ocena dana">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          aria-pressed={value === n}
          aria-label={`${n} — ${RATING_LABELS[n - 1]}`}
          title={RATING_LABELS[n - 1]}
          className={cx('rating-btn', value === n && 'is-on', value != null && n < value && 'is-below')}
          onClick={() => onChange(value === n ? null : n)}
        >
          {n}
        </button>
      ))}
    </div>
  );
}

/** Prikaz ocene (samo za čitanje), npr. u dnevniku. */
export function RatingDots({ value }: { value: number | null }) {
  if (value == null) return null;
  return (
    <span className="rating-dots" aria-label={`Ocena ${value} od 5`} title={`${value}/5 — ${RATING_LABELS[value - 1]}`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <span key={n} className={cx('rating-dot', n <= value && 'is-on')} />
      ))}
    </span>
  );
}

export { RATING_LABELS };
