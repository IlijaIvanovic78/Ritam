// Jedan red niza: blok (naziv, opseg, ocena, ručica trajanja, "+" na šavovima, rezovi) ili slobodno vreme.
// Klikove, držanje i prevlačenje obrađuje StackController (delegirano sa <ol>), pa ovde nema handlera.

import { Fragment, type CSSProperties, type ReactNode } from 'react';
import type { BlockStatus } from '../../../../shared/types.ts';
import { fmtClock, fmtDuration } from '../../../../shared/time.ts';
import type { ItemId, StackItem } from '../../../../shared/blockStack.ts';
import { useT } from '../../i18n/index.ts';
import { CategoryStroke, Icon, cx } from '../../ui/index.ts';
import { fmtRange } from './geometry.ts';

export interface RowView {
  c: StackItem;
  key: string;
  /** Početak za prikaz (tokom prevlačenja: raspored koji bi nastao spuštanjem). */
  st: number;
  /** Trajanje za prikaz. */
  dur: number;
  h: number;
  trailing: boolean;
  started: boolean;
  past: boolean;
  now: boolean;
  /** Minut "sada" (tekući red: preostalo vreme i linija sada). */
  nowMin: number | null;
  due: boolean;
  ghost: boolean;
  selected: boolean;
  over: boolean;
  moving: boolean;
  /** Režim "Premesti" je uključen (slobodno vreme koje nije cilj tada nije ni u Tab redosledu). */
  inMove: boolean;
  /** Slobodno vreme koje je cilj u režimu "Premesti": "od 20:00". */
  targetFrom: number | null;
  canRate: boolean;
  canResize: boolean;
  canInsTop: boolean;
  canInsBot: boolean;
  noLift: boolean;
  canClose: boolean;
  splitting: { cuts: number[] } | null;
  lifted: boolean;
  liftedLabel: string | null;
  hole: boolean;
  holeH: number;
  shift: number;
  shifting: boolean;
  drop: boolean;
  color: string;
  showNote: boolean;
  register: (id: ItemId, el: HTMLLIElement | null) => void;
}

const STATUS: Array<{ s: Exclude<BlockStatus, 'pending'>; icon: 'check' | 'half' | 'x'; label: 'status.done' | 'status.partial' | 'status.skipped' }> = [
  { s: 'done', icon: 'check', label: 'status.done' },
  { s: 'partial', icon: 'half', label: 'status.partial' },
  { s: 'skipped', icon: 'x', label: 'status.skipped' },
];

const BREAK = (
  <svg width="12" height="10" viewBox="0 0 12 10" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
    <path d="M1 4.5 L11 1 M1 9 L11 5.5" />
  </svg>
);

export function BlockRow({ v, statusWord }: { v: RowView; statusWord: (s: BlockStatus) => string }) {
  const t = useT();
  const { c } = v;
  const free = c.kind === 'free';
  const end = v.st + v.dur;
  const range = fmtRange(v.st, end);
  const short = !free && v.dur < 30 && !v.splitting;
  // 30–45 min (niže od 78 px): naziv u jednom redu, da opseg ostane vidljiv (2 reda naziva + meta ne staju).
  const mid = !free && !short && !v.splitting && !v.lifted && v.h < 78;
  // Sa ✓ ◐ ✕ (oko 130 px): meta ne prelama, "čeka ocenu" / "još 20m" ide prvo, opseg se skraćuje (početak je u koloni).
  const rate = v.canRate && (short || mid);
  const left = v.nowMin != null ? fmtDuration(Math.max(1, end - v.nowMin)) : '';

  let name: string;
  let meta: ReactNode;
  if (free) {
    name = v.ghost ? t('blocks.freeTime') : v.targetFrom != null ? t('blocks.intoFree') : v.trailing ? t('blocks.freeToEnd') : t('blocks.free');
    if (v.targetFrom != null) meta = <span className="is-range">{t('blocks.from', { time: fmtClock(v.targetFrom) })}</span>;
    else if (v.now) meta = <span className="is-now">{t('day.now.left', { time: left })}</span>;
    else if (v.trailing) meta = <span>{fmtDuration(v.dur)}</span>;
    else
      meta = (
        <>
          <span className="blk-range">{range}</span>
          <span>{fmtDuration(v.dur)}</span>
        </>
      );
  } else {
    name = c.title;
    // Delovi mete imaju ključeve: ikonica beleške (jedini deo koji prima dodir, zbog opisa) ostaje isti element i kad se
    // blok podigne — dodir čiji je cilj uklonjen iz DOM-a više ne stiže do niza (vidi .blk-text u blocks.css).
    const note = v.showNote && c.note.trim() !== '' && (
      <span key="note" className="blk-note" title={t('day.row.noteTooltip')}>
        <Icon name="note" size={14} />
        <span className="sr-only">{t('day.row.noteLabel')}</span>
      </span>
    );
    if (v.lifted) {
      meta = (
        <>
          <span key="range" className="is-range">
            {range}
          </span>
          {v.liftedLabel && <span key="label">{v.liftedLabel}</span>}
          {note}
        </>
      );
    } else {
      const extra = v.now ? (
        <span className="blk-extra is-status is-now">{t('day.now.left', { time: left })}</span>
      ) : v.due ? (
        <span className="blk-extra is-status is-due">{t('day.row.due')}</span>
      ) : v.started && c.actualMin != null && (c.status === 'done' || c.status === 'partial') ? (
        <span className="blk-extra is-status">{t('day.row.actual', { time: fmtDuration(c.actualMin) })}</span>
      ) : (
        <span className="blk-extra">{fmtDuration(v.dur)}</span>
      );
      meta = (
        <>
          {!short && (
            <span key="range" className="blk-range">
              {range}
            </span>
          )}
          <Fragment key="extra">{extra}</Fragment>
          {v.over && (
            <span key="over" className="is-over">
              {t('blocks.row.over')}
            </span>
          )}
          {note}
        </>
      );
    }
  }

  const aria = free
    ? v.targetFrom != null
      ? t('blocks.intoFreeAria', { time: fmtClock(v.targetFrom) })
      : t('blocks.freeAria', { range, time: fmtDuration(v.dur) })
    : t('blocks.rowAria', { name, range, time: fmtDuration(v.dur) }) +
      (v.started ? ', ' + (v.now ? t('day.nowTag') : v.due ? t('day.row.due') : statusWord(c.status)) : '');

  const liStyle: CSSProperties = {};
  if (v.lifted) {
    liStyle.height = `${v.holeH}px`;
    (liStyle as Record<string, string>)['--ch'] = `${Math.min(v.holeH, 64)}px`;
    (liStyle as Record<string, string>)['--hole-h'] = `${v.holeH}px`;
  }
  if (v.shift) liStyle.transform = `translateY(${v.shift}px)`;

  const boxStyle = {
    '--cat': free ? 'transparent' : v.color,
    '--h': `${v.h}px`,
    ...(v.now && v.nowMin != null ? { '--now-y': `${Math.round(((v.nowMin - v.st) / v.dur) * v.h)}px` } : {}),
  } as CSSProperties;

  const status = c.kind === 'block' ? c.status : 'pending';

  return (
    <li
      ref={(el) => v.register(c.id, el)}
      className={cx(
        'blk',
        free && 'is-free',
        v.trailing && 'is-trailing',
        v.selected && !v.ghost && 'is-selected',
        v.now && 'is-now',
        v.due && 'is-due',
        v.past && 'is-past',
        short && 'is-short',
        mid && 'is-mid',
        rate && 'is-rate',
        v.splitting && 'is-splitting',
        !free && v.dur > 180 && !v.splitting && 'is-long',
        v.ghost && 'is-ghost',
        v.over && 'is-over',
        v.moving && 'is-moving',
        v.targetFrom != null && 'is-target',
        !free && `is-${status}`,
        v.canResize && 'can-resize',
        v.canInsTop && 'can-ins-top',
        v.canInsBot && 'can-ins-bot',
        v.noLift && 'no-lift',
        v.canClose && 'can-close',
        v.lifted && 'is-lifted',
        v.lifted && v.hole && 'is-leaving-hole',
        v.shifting && 'is-shifting',
        v.drop && 'is-drop',
      )}
      data-key={v.key}
      data-hole={v.lifted ? t('blocks.free') : undefined}
      style={liStyle}
    >
      <span className="blk-time" aria-hidden="true">
        {fmtClock(v.st)}
      </span>
      <div className="blk-box" style={boxStyle}>
        <span className="blk-elapsed" />
        <button
          type="button"
          className="blk-main"
          aria-label={aria}
          aria-pressed={free ? undefined : v.selected}
          disabled={free && v.past}
          tabIndex={v.ghost || (free && v.inMove && v.targetFrom == null) ? -1 : 0}
        >
          {!free && <CategoryStroke color={v.color} />}
          {free && (
            <span className="blk-plus">
              <Icon name="plus" size={16} />
            </span>
          )}
          <span className="blk-text">
            <span className="blk-name">{name}</span>
            <span className="blk-meta">{meta}</span>
          </span>
        </button>
        {!free && v.canRate && (
          <div className={cx('day-status', status !== 'pending' && 'has-value')} role="group" aria-label={t('day.row.statusLabel', { title: name })}>
            {STATUS.map((o) => {
              const on = status === o.s;
              return (
                <button
                  key={o.s}
                  type="button"
                  className={cx('day-status-btn', `is-${o.s}`, on && 'is-active')}
                  data-status={o.s}
                  aria-pressed={on}
                  aria-label={t(o.label)}
                  title={t(o.label)}
                >
                  <Icon name={o.icon} size={18} />
                </button>
              );
            })}
          </div>
        )}
        {free && v.canClose && (
          <button type="button" className="blk-gap" title={t('blocks.closeGap')} aria-label={t('blocks.closeGapAria', { range })}>
            <Icon name="collapse" size={20} />
          </button>
        )}
        <span className="blk-nowline" />
        <span className="blk-break" aria-hidden="true">
          {BREAK}
        </span>
        {v.splitting && <Cuts cuts={v.splitting.cuts} st={v.st} dur={v.dur} h={v.h} />}
        {!free && (
          <>
            <button type="button" className="blk-ins is-top" aria-label={t('blocks.addAbove')} tabIndex={v.selected ? 0 : -1}>
              <Icon name="plus" size={14} />
            </button>
            <button type="button" className="blk-ins is-bot" aria-label={t('blocks.addBelow')} tabIndex={v.selected ? 0 : -1}>
              <Icon name="plus" size={14} />
            </button>
            <button
              type="button"
              className="blk-grip"
              aria-label={t('blocks.grip', { name })}
              tabIndex={v.selected && v.canResize ? 0 : -1}
              data-no-swipe
            />
          </>
        )}
      </div>
    </li>
  );
}

/** Uređivač rezova u bloku: delovi ("1h 30m 13:30–15:00"), isprekidane linije, oznaka vremena koja se vuče, ×. */
function Cuts({ cuts, st, dur, h }: { cuts: number[]; st: number; dur: number; h: number }) {
  const t = useT();
  const sorted = [...cuts].sort((a, b) => a - b);
  const pts = [0, ...sorted, dur];
  return (
    <div className="blk-cuts">
      <div className="blk-cut-pieces">
        {pts.slice(0, -1).map((p, k) => {
          const y0 = (p / dur) * h;
          const y1 = (pts[k + 1] / dur) * h;
          const top = k === 0 ? Math.max(y0, 34) : y0;
          return (
            <span key={k} className="blk-cut-piece" style={{ top, height: Math.max(0, y1 - top) }}>
              <b>{fmtDuration(pts[k + 1] - p)}</b>
              {fmtRange(st + p, st + pts[k + 1])}
            </span>
          );
        })}
      </div>
      {sorted.map((m, k) => {
        const tm = fmtClock(st + m);
        return (
          <div key={k} className="blk-cut" style={{ top: (m / dur) * h }}>
            <div className="blk-cut-handle">
              <button type="button" className="cut-drag" data-cut={k} aria-label={t('blocks.split.cutAt', { time: tm })} data-no-swipe>
                <span>{tm}</span>
              </button>
              <button type="button" className="cut-x" data-cutx={k} aria-label={t('blocks.split.removeCut', { time: tm })}>
                <Icon name="x" size={14} />
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
