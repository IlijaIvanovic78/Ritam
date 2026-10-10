// Koraci od 5 min u listu bloka (Početak / Kraj, "Ceo blok") i u listu "Novi blok" ("Počinje u"): − i + ponavljaju
// korak dok se drže, a vreme u sredini se dodirne (ili klikne) da se upiše (kucanje je uvek 24h).

import { useEffect, useRef, useState, type MouseEvent, type PointerEvent, type ReactNode } from 'react';
import { fmtClock } from '../../../../shared/time.ts';
import { Icon, cx } from '../../ui/index.ts';
import { REPEAT, finePointer } from './geometry.ts';

/** Prst koji je skliznuo sa dugmeta više od ovoga (px) zaustavlja ponavljanje. */
const HOLD_SLOP = 12;

/**
 * Držanje dugmeta: prvi korak odmah, posle 400 ms ponavljanje na 120 ms, posle 20 ponavljanja na 70 ms. Staje na
 * puštanje, izlazak prsta sa dugmeta (pointermove: dok je pokazivač zarobljen, pointerleave ne stiže), gubitak
 * pokazivača ili fokusa prozora i kad korak vrati false (granica: kartica se trese, poruka kaže zašto). Klik koji
 * sledi pritisku se ne računa (korak je već urađen); klik sa tastature (detail 0) je jedan korak.
 */
export function useHoldRepeat(step: () => boolean) {
  const stepRef = useRef(step);
  stepRef.current = step;
  const timer = useRef(0);
  const [held, setHeld] = useState(false);

  const stop = () => {
    window.clearTimeout(timer.current);
    timer.current = 0;
    setHeld(false);
  };
  const stopRef = useRef(stop);
  stopRef.current = stop;

  useEffect(() => {
    const onBlur = () => stopRef.current();
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('blur', onBlur);
      window.clearTimeout(timer.current);
    };
  }, []);

  const repeat = (n: number) => {
    timer.current = window.setTimeout(
      () => {
        if (!stepRef.current()) {
          stopRef.current();
          return;
        }
        repeat(n + 1);
      },
      n === 0 ? REPEAT.first : n >= REPEAT.fastAfter ? REPEAT.fast : REPEAT.every,
    );
  };

  return {
    held,
    props: {
      onPointerDown: (e: PointerEvent<HTMLButtonElement>) => {
        if (e.button !== 0 || e.currentTarget.getAttribute('aria-disabled') === 'true') return;
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          // pokazivač je već pušten
        }
        window.clearTimeout(timer.current);
        if (!stepRef.current()) return;
        setHeld(true);
        repeat(0);
      },
      onPointerMove: (e: PointerEvent<HTMLButtonElement>) => {
        if (!timer.current) return;
        const r = e.currentTarget.getBoundingClientRect();
        const out = e.clientX < r.left - HOLD_SLOP || e.clientX > r.right + HOLD_SLOP || e.clientY < r.top - HOLD_SLOP || e.clientY > r.bottom + HOLD_SLOP;
        if (!out) return;
        stop();
        try {
          e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
          // pokazivač nije zarobljen
        }
      },
      onPointerUp: stop,
      onPointerCancel: stop,
      onPointerLeave: stop,
      onLostPointerCapture: stop,
      onClick: (e: MouseEvent<HTMLButtonElement>) => {
        if (e.detail === 0 && e.currentTarget.getAttribute('aria-disabled') !== 'true') stepRef.current();
      },
      // Držanje prsta ne otvara meni (Android).
      onContextMenu: (e: MouseEvent) => e.preventDefault(),
    },
  };
}

/**
 * − ili +. Na granici je samo aria-disabled (ne disabled): dugme koje tastatura drži u fokusu (Enter ponavlja korak) ne
 * gubi fokus kad dođe do granice — fokus bi pao na <body>.
 */
function StepButton({ icon, label, step, disabled }: { icon: 'minus' | 'plus'; label: string; step: () => boolean; disabled: boolean }) {
  const h = useHoldRepeat(step);
  return (
    <button type="button" className={cx('blk-stp-btn', h.held && 'is-held')} aria-label={label} aria-disabled={disabled || undefined} {...h.props}>
      <Icon name={icon} size={20} />
    </button>
  );
}

/** − vrednost + (zaključan: samo vrednost, isprekidano, npr. početak bloka koji je počeo). */
export function Stepper({
  minus,
  plus,
  canMinus,
  canPlus,
  minusLabel,
  plusLabel,
  locked = false,
  className,
  children,
}: {
  minus: () => boolean;
  plus: () => boolean;
  canMinus: boolean;
  canPlus: boolean;
  minusLabel: string;
  plusLabel: string;
  locked?: boolean;
  className?: string;
  children: ReactNode;
}) {
  if (locked) return <div className={cx('blk-stp is-locked', className)}>{children}</div>;
  return (
    <div className={cx('blk-stp', className)}>
      <StepButton icon="minus" label={minusLabel} step={minus} disabled={!canMinus} />
      {children}
      <StepButton icon="plus" label={plusLabel} step={plus} disabled={!canPlus} />
    </div>
  );
}

/**
 * Otkucane cifre → "HH:MM" u 24h, kao polje za vreme sa 24h jezikom: sat ima dve cifre, ili jednu ako je veća od 2
 * (9 → 09; "24" → 02:4…); minuti isto (jedna cifra veća od 5 je 0X). Dok se minuti ne otkucaju, ostaju kakvi su bili.
 */
export function typedClock(digits: string, was: string): string {
  const two = digits.length > 1 && Number(digits[0]) <= 2 && Number(digits.slice(0, 2)) <= 23;
  const h = digits.slice(0, two ? 2 : 1);
  const rest = digits.slice(h.length);
  const m = !rest ? was.slice(3, 5) : rest.length > 1 && Number(rest[0]) <= 5 ? rest.slice(0, 2) : rest[0];
  return `${h.padStart(2, '0')}:${m.padStart(2, '0')}`;
}

/**
 * Vreme u sredini koraka; preko njega je providno polje za vreme (dodir otvara birač telefona, mišem se otvara
 * birač browsera, tastaturom se kuca). Upisano vreme kontroler zaokruži na 5 min. Bez `onSet` je samo tekst.
 *
 * Birač (dodir, miš) primenjuje izabrano vreme odmah. Kucanje se primenjuje tek na Enter ili izlazak iz polja (Esc
 * vraća staro): Chrome šalje "change" posle svake cifre, pa bi "08:00" prošlo kroz 00:45 i 08:45 i svaki taj korak
 * bi pomerao blokove posle njega. Dok se kuca, vidi se ono što je otkucano.
 *
 * Tastaturu ne obrađuje samo polje: ono prati jezik browsera, pa na engleskom (12h) ima nevidljiv AM/PM i "2100" bi
 * postalo 14:10, a "0930" preko 18:30 — 21:30. Cifre se zato skupljaju ovde i uvek se čitaju kao 24h (typedClock);
 * Backspace briše poslednju, ↑/↓ = ±5 min.
 */
export function TimeValue({ minute, label, onSet }: { minute: number; label?: string; onSet?: (hhmm: string) => void }) {
  const value = fmtClock(minute);
  const ref = useRef<HTMLInputElement>(null);
  // Nacrt dok je polje u fokusu (vidi se umesto stvarnog vremena), otkucane cifre i da li je menjan tastaturom.
  const [draft, setDraftState] = useState<string | null>(null);
  const draftRef = useRef<string | null>(null);
  const setDraft = (v: string | null) => {
    draftRef.current = v;
    setDraftState(v);
  };
  const typed = useRef('');
  const keyed = useRef(false);
  const setRef = useRef(onSet);
  setRef.current = onSet;
  const valueRef = useRef(value);
  valueRef.current = value;
  const editable = onSet != null;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onChange = () => {
      if (keyed.current || !el.value) return;
      setDraft(null);
      if (el.value !== valueRef.current) setRef.current?.(el.value);
    };
    el.addEventListener('change', onChange);
    return () => el.removeEventListener('change', onChange);
  }, [editable]);

  /** Otkucano vreme (Enter, izlazak iz polja): jedna izmena. */
  const commit = () => {
    const v = draftRef.current;
    const was = keyed.current;
    keyed.current = false;
    typed.current = '';
    setDraft(null);
    if (was && v && v !== valueRef.current) setRef.current?.(v);
  };

  /** Izmena tastaturom: nacrt (bez cifara = vrednost kakva je bila). */
  const keyTo = (v: string | null) => {
    keyed.current = v != null;
    setDraft(v ?? value);
  };

  return (
    <span className="blk-stp-val">
      <span aria-hidden={onSet ? true : undefined}>{draft || value}</span>
      {onSet && (
        <input
          ref={ref}
          type="time"
          step={300}
          value={draft ?? value}
          aria-label={label}
          onFocus={() => {
            keyed.current = false;
            typed.current = '';
            setDraft(value);
          }}
          onBlur={commit}
          onChange={(e) => {
            if (e.target.value) setDraft(e.target.value);
          }}
          onKeyDown={(e) => {
            const k = e.key;
            if (k === 'Enter') {
              e.preventDefault();
              commit();
            } else if (k === 'Escape') {
              // Prvi Esc vraća otkucano; tek sledeći zatvara list bloka (ili list "Novi blok": preventDefault, inače
              // modalni <dialog> sam pokreće "cancel").
              if (!keyed.current) return;
              e.preventDefault();
              e.stopPropagation();
              typed.current = '';
              keyTo(null);
            } else if (e.ctrlKey || e.metaKey || e.altKey) {
              // prečice browsera
            } else if (/^\d$/.test(k)) {
              e.preventDefault();
              typed.current = (typed.current.length >= 4 ? '' : typed.current) + k;
              keyTo(typedClock(typed.current, value));
            } else if (k === 'Backspace' || k === 'Delete') {
              e.preventDefault();
              typed.current = typed.current.slice(0, -1);
              keyTo(typed.current ? typedClock(typed.current, value) : null);
            } else if (k === 'ArrowUp' || k === 'ArrowDown') {
              e.preventDefault();
              const [h, m] = (draftRef.current ?? value).split(':').map(Number);
              const cur = h * 60 + m;
              const next = k === 'ArrowUp' ? Math.floor(cur / 5) * 5 + 5 : Math.ceil(cur / 5) * 5 - 5;
              typed.current = '';
              keyTo(fmtClock(next));
            } else if (k === ':' || k === '.') {
              // "9:30": dvotačka završava sat
              e.preventDefault();
              if (typed.current.length === 1) typed.current = `0${typed.current}`;
            } else if (k.length === 1) e.preventDefault(); // slova (a/p bi menjali nevidljiv AM/PM)
          }}
          onClick={(e) => {
            if (!finePointer()) return;
            try {
              e.currentTarget.showPicker?.();
            } catch {
              // birač nije dostupan (npr. polje nije dobilo fokus dodirom)
            }
          }}
        />
      )}
    </span>
  );
}
