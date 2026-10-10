// Zalepljena traka iznad niza, u dva reda: gore "Sada · još 2h 40m · do 14:00" (ili šablon / dan), ispod naziv bloka
// koji se nikad ne seče loše; desno čip "● 1" (prolaz kroz ocene), Poništi (samo uz istoriju) i "+". Ispod traka
// celog dana (24h): blokovi u bojama kategorija i "sada" — dodir / prevlačenje / ←→ skaču na to vreme.

import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { useOnline } from '../../lib/hooks.ts';
import { fmtClock, fmtDuration } from '../../../../shared/time.ts';
import type { StackItem } from '../../../../shared/blockStack.ts';
import { useT } from '../../i18n/index.ts';
import { Icon, cx } from '../../ui/index.ts';
import type { StackController } from './controller.ts';
import { clamp, guardTap, markBlockGesture } from './geometry.ts';

/** Jučerašnji blok koji još traje (npr. noćni do jutra), u minutima ovog dana. */
export interface CarryOver {
  title: string;
  start: number;
  end: number;
}

/** "Čuva se…" se pokazuje tek kad čuvanje traje duže od ovoga (ms). */
const SLOW_SAVE_MS = 1000;

/** Traka dana: izabran blok uži od ovoga (px) se označava tačkom iznad staze, ne prstenom. */
const NARROW_PX = 8;

export function StackBar({
  ctl,
  list,
  st,
  cur,
  title,
  dayLabel,
  carryOver,
  strip,
}: {
  ctl: StackController;
  list: readonly StackItem[];
  st: number[];
  cur: number;
  /** Traka dana, ako crta drugi niz (pregled novog bloka; gornji red tada računa samo pravi niz). */
  strip?: { list: readonly StackItem[]; st: number[] };
  /** Naziv šablona (režim šablona). */
  title?: string;
  /** Dan bez "sada": "Juče" ili datum (iznad broja blokova). */
  dayLabel?: string;
  carryOver?: CarryOver | null;
}) {
  const t = useT();
  const online = useOnline();
  const { mode, now } = ctl.cfg;
  const tpl = mode === 'template';
  const blocksN = list.filter((c) => c.kind === 'block' && c.id !== ctl.ghostId).length;

  // Čuvanje koje traje: tek posle 1 s od slanja zahteva (brzo čuvanje se ne vidi; Poništi je ionako u traci).
  const saving = ctl.saveState === 'saving';
  const [slowSave, setSlowSave] = useState(false);
  useEffect(() => {
    if (!saving) {
      setSlowSave(false);
      return;
    }
    const id = window.setTimeout(() => setSlowSave(true), SLOW_SAVE_MS);
    return () => window.clearTimeout(id);
  }, [saving]);

  // Gornji red ("kicker"): oznaka i preostalo vreme se nikad ne skraćuju; skraćuje se samo rep ("do 14:00", "sledeće …").
  let label: string;
  let labelNow = false;
  let left = '';
  let extra = '';
  let tail = '';
  let name: ReactNode;
  let nameFull: string;
  let twoLines = false;
  if (tpl) {
    // Naziv šablona je i naslov stranice: u traci tek kad je zalepljena (naslov je otišao gore), do tada broj blokova.
    label = t('blocks.bar.template');
    const count = t('common.blocks', { n: blocksN });
    extra = count;
    name = (
      <>
        <span className="blk-bar-if-stuck">{title ?? ''}</span>
        <span className="blk-bar-if-rest">{count}</span>
      </>
    );
    nameFull = t('blocks.bar.tplCount', { name: title ?? '', n: blocksN });
  } else if (now == null) {
    // Raniji / budući dan: koji je dan (traka ostaje i kad naslov stranice ode gore) i koliko blokova.
    label = dayLabel ?? t('day.timeline.title');
    name = nameFull = t('common.blocks', { n: blocksN });
  } else {
    label = t('day.now.label');
    labelNow = true;
    const c = cur >= 0 ? list[cur] : null;
    const carry = carryOver && carryOver.start <= now && now < carryOver.end && (!c || c.kind === 'free') ? carryOver : null;
    if (!c && !carry) {
      name = nameFull = t('day.now.over');
      twoLines = true;
    } else {
      const free = !carry && c!.kind === 'free';
      name = carry ? carry.title : free ? t('day.now.free') : (c as Extract<StackItem, { kind: 'block' }>).title;
      const end = carry ? carry.end : st[cur] + c!.dur;
      left = t('day.now.left', { time: fmtDuration(Math.max(1, Math.ceil(end - now))) });
      if (carry) extra = t('day.now.fromYesterday');
      if (free) {
        const nx = list.findIndex((x, i) => x.kind === 'block' && st[i] > now);
        const next = nx >= 0 ? list[nx] : null;
        if (next && next.kind === 'block') tail = t('blocks.bar.next', { name: next.title, time: fmtClock(st[nx]) });
      } else tail = t('blocks.bar.until', { time: fmtClock(end) });
      nameFull = [name, left, extra, tail].filter(Boolean).join(' · ');
    }
  }
  // Bez mreže (izmene se ne čuvaju; i traka "Nema interneta" iznad) ili sporo čuvanje: umesto repa.
  if (!online) tail = t('blocks.bar.offline');
  else if (slowSave) tail = t('common.saving');

  // Danas i praćen raniji dan (tamo čeka ocenu svaki neocenjen blok koji se računa).
  const dues = !tpl && (now != null || ctl.cfg.pastDay) ? list.filter((x, i) => ctl.isDue(x, st[i])).length : 0;

  const SEP = (
    <span className="blk-bar-sep" aria-hidden="true">
      {' · '}
    </span>
  );
  const parts: ReactNode[] = [];
  if (left) parts.push(<span className="blk-bar-k is-now">{left}</span>);
  if (extra) parts.push(<span className="blk-bar-k">{extra}</span>);
  // Šablon: broj blokova u gornjem redu samo kad je naziv u donjem (zalepljena traka).
  const extraStuck = tpl;

  return (
    <div className="blk-bar" ref={(el) => void (ctl.barEl = el)}>
      <div className="blk-bar-top">
        <div className="blk-bar-info">
          <span className="blk-bar-kicker">
            <span className={cx('blk-bar-k', labelNow ? 'is-now' : 'is-plain')}>{label}</span>
            {parts.map((p, k) => (
              <span key={k} className={cx('blk-bar-part', extraStuck && 'blk-bar-if-stuck')}>
                {SEP}
                {p}
              </span>
            ))}
            {tail && (
              <span className={cx('blk-bar-tail', !online && 'is-offline')}>
                {SEP}
                {tail}
              </span>
            )}
          </span>
          <span className={cx('blk-bar-name', twoLines && 'is-long')} title={nameFull}>
            {name}
          </span>
        </div>
        {dues > 0 && (
          <button
            type="button"
            className="blk-bar-due"
            aria-label={`${t('blocks.bar.due', { n: dues })}: ${t('blocks.bar.dueAria')}`}
            title={t('day.now.due', { n: dues })}
            onClick={() => ctl.startReview()}
          >
            <span className="blk-bar-due-pill">
              <span className="blk-bar-due-dot" />
              <span className="is-long">{t('blocks.bar.due', { n: dues })}</span>
              <span className="is-short">{dues}</span>
            </span>
          </button>
        )}
        {ctl.hist.past.length > 0 && (
          <button type="button" className="icon-btn" aria-label={t('blocks.undo')} title={t('blocks.undoKey')} onClick={() => ctl.undo()}>
            <Icon name="undo" />
          </button>
        )}
        <button
          type="button"
          className="icon-btn blk-bar-add"
          aria-label={t('day.addBlock')}
          title={t('blocks.addKey')}
          onClick={(e) => {
            // Drugi brzi dodir bi pao na pozadinu lista "Novi blok" i zatvorio ga.
            guardTap(e);
            ctl.openNew();
          }}
        >
          <Icon name="plus" size={22} />
        </button>
      </div>
      <DayStrip ctl={ctl} list={strip?.list ?? list} st={strip?.st ?? st} />
    </div>
  );
}

/**
 * Klik koji sledi dodiru na traci dana: stranica se u međuvremenu skrolovala (traka još nije bila zalepljena), pa bi
 * pao na ono što je sada pod prstom (npr. slobodno vreme → "Novi blok"). Proguta se samo taj jedan klik.
 */
function swallowClick() {
  const kill = (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
  };
  document.addEventListener('click', kill, { capture: true, once: true });
  window.setTimeout(() => document.removeEventListener('click', kill, true), 400);
}

/**
 * Traka celog dana: tanka staza sa blokovima (slobodno vreme se ne crta), "sada" i izabran blok. Klizač (role="slider"):
 * dodir ili prevlačenje skače na to vreme, ←/→ za sat; aria-valuenow upisuje kontroler pri skrolu (updateBar).
 */
function DayStrip({ ctl, list, st }: { ctl: StackController; list: readonly StackItem[]; st: number[] }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const down = useRef(false);
  const { start, end } = ctl.M.frame;
  const LEN = ctl.M.LEN;
  const pct = (m: number) => clamp(((m - start) / LEN) * 100, 0, 100);
  const { mode, pastDay } = ctl.cfg;
  const now = mode === 'day' ? ctl.cfg.now : null;
  // Bez "sada": šablon i raniji dan su puni, budući dan je ceo "unapred".
  const allSolid = mode === 'template' || (now == null && pastDay);

  const jump = (x: number) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    ctl.scrollToTime(start + clamp((x - r.left) / r.width, 0, 1) * LEN, false);
  };
  // Širina staze (px): izabran blok uži od NARROW_PX nema prsten (oko 2 px izgleda kao "0") nego tačku iznad staze.
  const w = ref.current?.clientWidth ?? 0;

  return (
    <div
      ref={(el) => {
        ref.current = el;
        ctl.mapEl = el;
      }}
      className="blk-strip"
      tabIndex={0}
      role="slider"
      aria-label={t('blocks.map.aria')}
      aria-valuemin={0}
      aria-valuemax={LEN}
      data-no-swipe
      onPointerDown={(e) => {
        down.current = true;
        markBlockGesture();
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          // pokazivač je već pušten
        }
        jump(e.clientX);
      }}
      onPointerMove={(e) => {
        if (!down.current) return;
        markBlockGesture();
        jump(e.clientX);
      }}
      onPointerUp={() => {
        down.current = false;
        swallowClick();
      }}
      onPointerCancel={() => (down.current = false)}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        const g = ctl.rowsGeo();
        const b = ctl.band();
        ctl.scrollToTime(ctl.yToTime(g, b.top + window.scrollY + (b.bottom - b.top) * 0.25) + (e.key === 'ArrowLeft' ? -60 : 60), false);
      }}
    >
      <span className="blk-strip-track">
        {list.map((c, i) => {
          if (c.kind !== 'block') return null;
          const s = st[i];
          const e = s + c.dur;
          if (s >= end) return null;
          const style = { left: `${pct(s)}%`, width: `calc(${pct(e) - pct(s)}% - 1px)`, ['--cat' as string]: ctl.catColor(c.categoryId) };
          const past = allSolid || (now != null && e <= now);
          // Tekući blok: prošli deo je pun (drugi segment preko prvog).
          const elapsed = now != null && s < now && now < e ? pct(now) - pct(s) : 0;
          const sel = ctl.sel === c.id;
          return (
            <Fragment key={ctl.keyOf(c.id)}>
              <span className={cx('blk-seg', past && 'is-past', sel && 'is-sel', sel && ((pct(e) - pct(s)) / 100) * w < NARROW_PX && 'is-narrow')} style={style} />
              {elapsed > 0 && <span className="blk-seg is-past is-part" style={{ ...style, width: `${elapsed}%` }} />}
            </Fragment>
          );
        })}
      </span>
      {now != null && <span className="blk-strip-now" style={{ left: `${pct(now)}%` }} />}
    </div>
  );
}
