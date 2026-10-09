// Zalepljena traka iznad niza: "SADA <blok> · još 20m" (ili šablon), čip "1 čeka ocenu", Čuva se…/Sačuvano,
// Poništi i "+"; ispod mapa celog dana (24h) sa okvirom vidljivog dela — dodir/prevlačenje skače na to vreme.

import { Fragment, useRef, type ReactNode } from 'react';
import { useOnline } from '../../lib/hooks.ts';
import { fmtClock, fmtDuration } from '../../../../shared/time.ts';
import type { StackItem } from '../../../../shared/blockStack.ts';
import { useT } from '../../i18n/index.ts';
import { Icon, cx } from '../../ui/index.ts';
import type { StackController } from './controller.ts';
import { clamp, isPhoneWidth, markBlockGesture, reduceMotion } from './geometry.ts';

/** Jučerašnji blok koji još traje (npr. noćni do jutra), u minutima ovog dana. */
export interface CarryOver {
  title: string;
  start: number;
  end: number;
}

export function StackBar({
  ctl,
  list,
  st,
  cur,
  title,
  carryOver,
  wide,
}: {
  ctl: StackController;
  list: readonly StackItem[];
  st: number[];
  cur: number;
  /** Naziv šablona (režim šablona). */
  title?: string;
  carryOver?: CarryOver | null;
  /** Ima mesta za "· sledeće X u 13:30". */
  wide: boolean;
}) {
  const t = useT();
  const online = useOnline();
  const { mode, now } = ctl.cfg;
  const tpl = mode === 'template';
  const blocksN = list.filter((c) => c.kind === 'block' && c.id !== ctl.ghostId).length;
  // Razmaci ostaju i na početku dela (white-space: pre u blocks.css).
  const SEP = ' · ';

  // Tekst trake: naziv se skraćuje (…), "· još 20m" ostaje ceo, "· sledeće …" se prvo skraćuje; ceo tekst je u title.
  let label: string;
  let text: ReactNode;
  let full: string;
  let plain = true;
  if (tpl) {
    label = t('blocks.bar.template');
    full = t('blocks.bar.tplCount', { name: title ?? '', n: blocksN });
    text = (
      <>
        <strong className="blk-bar-name">{title}</strong>
        <span className="blk-bar-keep">
          {SEP}
          {t('common.blocks', { n: blocksN })}
        </span>
      </>
    );
  } else if (now == null) {
    label = t('day.timeline.title');
    full = t('common.blocks', { n: blocksN });
    text = <span className="blk-bar-name">{full}</span>;
  } else {
    plain = false;
    label = t('day.now.label');
    const c = cur >= 0 ? list[cur] : null;
    const carry = carryOver && carryOver.start <= now && now < carryOver.end && (!c || c.kind === 'free') ? carryOver : null;
    if (!c && !carry) {
      full = t('day.now.over');
      text = <span className="blk-bar-name">{full}</span>;
    } else {
      const name = carry ? carry.title : c!.kind === 'free' ? t('day.now.free') : c!.title;
      const end = carry ? carry.end : st[cur] + c!.dur;
      const nx = list.findIndex((x, i) => x.kind === 'block' && st[i] > now);
      const next = nx >= 0 ? list[nx] : null;
      const left = t('day.now.left', { time: fmtDuration(Math.max(1, Math.ceil(end - now))) });
      const nextText = wide && next && next.kind === 'block' ? t('blocks.bar.next', { name: next.title, time: fmtClock(st[nx]) }) : '';
      full = [name, left, carry ? t('day.now.fromYesterday') : '', nextText].filter(Boolean).join(' · ');
      text = (
        <>
          <strong className="blk-bar-name">{name}</strong>
          <span className="blk-bar-keep">
            {SEP}
            <span className="is-now">{left}</span>
            {carry && `${SEP}${t('day.now.fromYesterday')}`}
          </span>
          {nextText && (
            <span className="blk-bar-next">
              {SEP}
              {nextText}
            </span>
          )}
        </>
      );
    }
  }

  const dues = !tpl && now != null ? list.filter((x, i) => ctl.isDue(x, st[i])) : [];
  // Bez mreže: "Van mreže" (izmene se ne čuvaju; i traka "Nema interneta" iznad).
  const saved = !online ? t('blocks.bar.offline') : ctl.saveState === 'saving' ? t('common.saving') : ctl.saveState === 'saved' ? t('common.saved') : '';

  const jumpDue = () => {
    const first = dues[0];
    if (!first) return;
    const box = ctl.boxOf(first.id);
    if (!box) return;
    const b = ctl.band();
    const r = box.getBoundingClientRect();
    window.scrollTo({ top: Math.max(0, r.top + window.scrollY - b.top - 24), behavior: reduceMotion() ? 'auto' : 'smooth' });
    ctl.flash(first.id);
    ctl.runAfter();
    (box.querySelector('.day-status-btn') as HTMLElement | null)?.focus({ preventScroll: true });
  };

  return (
    <div className="blk-bar" ref={(el) => void (ctl.barEl = el)}>
      <div className="blk-bar-top">
        <div className="blk-bar-info">
          <span className={cx('blk-bar-label', plain && 'is-plain')}>{label}</span>
          <span className="blk-bar-text" title={full}>
            {text}
          </span>
        </div>
        {dues.length > 0 && (
          <button
            type="button"
            className="blk-bar-due"
            aria-label={`${t('blocks.bar.due', { n: dues.length })}: ${t('blocks.bar.dueAria')}`}
            title={t('day.now.due', { n: dues.length })}
            onClick={jumpDue}
          >
            <span className="blk-bar-due-dot" />
            <span>{t('blocks.bar.due', { n: dues.length })}</span>
          </button>
        )}
        <span className={cx('blk-bar-saved', dues.length > 0 && 'has-due', !online && 'is-offline')} role="status">
          {saved}
        </span>
        <button
          type="button"
          className="icon-btn"
          aria-label={t('blocks.undo')}
          title={t('blocks.undoKey')}
          disabled={ctl.hist.past.length === 0}
          onClick={() => ctl.undo()}
        >
          <Icon name="undo" />
        </button>
        <button type="button" className="icon-btn" aria-label={t('day.addBlock')} title={t('blocks.addKey')} onClick={() => ctl.openNew()}>
          <Icon name="plus" />
        </button>
      </div>
      <DayMap ctl={ctl} list={list} st={st} />
    </div>
  );
}

function DayMap({ ctl, list, st }: { ctl: StackController; list: readonly StackItem[]; st: number[] }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const down = useRef(false);
  const { start, end } = ctl.M.frame;
  const LEN = ctl.M.LEN;
  const pct = (m: number) => clamp(((m - start) / LEN) * 100, 0, 100);
  const now = ctl.cfg.mode === 'day' ? ctl.cfg.now : null;

  const jump = (x: number) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    ctl.scrollToTime(start + clamp((x - r.left) / r.width, 0, 1) * LEN, false);
  };

  return (
    <>
      {/* aria-valuenow / aria-valuetext upisuje kontroler pri svakom skrolu (vreme od kog ←/→ skaču). */}
      <div
        ref={(el) => {
          ref.current = el;
          ctl.mapEl = el;
        }}
        className="blk-map"
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
        onPointerUp={() => (down.current = false)}
        onPointerCancel={() => (down.current = false)}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
          e.preventDefault();
          const g = ctl.rowsGeo();
          const b = ctl.band();
          ctl.scrollToTime(ctl.yToTime(g, b.top + window.scrollY + (b.bottom - b.top) * 0.25) + (e.key === 'ArrowLeft' ? -60 : 60), false);
        }}
      >
        {list.map((c, i) => {
          const s = st[i];
          const e = s + c.dur;
          if (s >= end) return null;
          const l = pct(s);
          const w = Math.max(0.4, pct(e) - l - 0.25);
          const due = ctl.isDue(c, s);
          return (
            <Fragment key={ctl.keyOf(c.id)}>
              <span
                className={cx(
                  'blk-map-seg',
                  c.kind === 'free' && 'is-free',
                  now != null && e <= now && 'is-past',
                  ctl.sel === c.id && 'is-sel',
                )}
                style={{ left: `${l}%`, width: `${w}%`, ['--cat' as string]: c.kind === 'free' ? 'transparent' : ctl.catColor(c.categoryId) }}
              />
              {due && <span className="blk-map-due" style={{ left: `${(l + pct(e)) / 2}%` }} />}
            </Fragment>
          );
        })}
        {now != null && <span className="blk-map-now" style={{ left: `${pct(now)}%` }} />}
        <span className="blk-map-view" ref={(el) => void (ctl.mapViewEl = el)} />
      </div>
      <div className="blk-map-hours" aria-hidden="true">
        {[0, 6, 12, 18, 24].map((h) => (
          <span key={h} style={{ left: `${(h / 24) * 100}%` }}>
            {fmtClock(start + h * 60).slice(0, 2)}
          </span>
        ))}
      </div>
    </>
  );
}

export const isWideBar = () => !isPhoneWidth();
