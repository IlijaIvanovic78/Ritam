// Jedan red niza: blok (kartica: crta kategorije, naziv, jedan red mete, krug ocene, napredak tekućeg bloka, ručice
// izabranog, rezovi) ili slobodno vreme (tačkasta crta, "1h slobodno 15:00–16:00", "+").
// Klikove, držanje i prevlačenje obrađuje StackController (delegirano sa <ol>), pa ovde nema handlera.

import { Fragment, type CSSProperties, type ReactNode } from 'react';
import type { BlockStatus } from '../../../../shared/types.ts';
import { fmtClock, fmtDuration } from '../../../../shared/time.ts';
import type { ItemId, StackItem } from '../../../../shared/blockStack.ts';
import { useT, type TFunction } from '../../i18n/index.ts';
import { CategoryStroke, Icon, cx } from '../../ui/index.ts';
import { CHIP_H, SHORT_MIN, TALL_H, fmtRange } from './geometry.ts';

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
  /** Slobodno vreme koje je prošlo (ili bilo koje na ranijem danu): nizak red, bez "+". */
  pastFree: boolean;
  now: boolean;
  /** Minut "sada" (tekući red: preostalo vreme). */
  nowMin: number | null;
  due: boolean;
  ghost: boolean;
  /** Novi blok još bez naziva: "Novi blok" kao natpis (bleđe). */
  placeholder: boolean;
  selected: boolean;
  over: boolean;
  moving: boolean;
  /** Režim "Premesti" je uključen (slobodno vreme koje nije cilj tada nije ni u Tab redosledu). */
  inMove: boolean;
  /** Slobodno vreme koje je cilj u režimu "Premesti": "U slobodno vreme · 18:00–19:00 · pomera 1 blok". */
  target: { label: string; range: string; pushes: number; over: boolean } | null;
  /**
   * Drugi blok je podignut: slobodno vreme tada pokazuje samo trajanje (blokovi pokazuju opsege iz rasporeda posle
   * spuštanja, pa bi stvaran opseg slobodnog vremena išao "unazad").
   */
  inDrag: boolean;
  /** Krug ocene (blok koji je počeo, samo dan): stanje i opis za čitač ekrana. */
  check: { status: BlockStatus; label: string; popup: boolean; open: boolean } | null;
  /** Tekući blok: koliki deo je prošao (0–1). */
  prog: number | null;
  /** Slobodno vreme u koje se sme dodati blok ("+" desno). */
  canAdd: boolean;
  canResize: boolean;
  /** Gornja ručica (početak): blok koji još nije počeo. */
  canResizeStart: boolean;
  noLift: boolean;
  /** Uređivač rezova: rezovi i da li su ručni (nisu jednaki delovi) — samo tada × uz rez. */
  splitting: { cuts: number[]; custom: boolean } | null;
  lifted: boolean;
  liftedLabel: string | null;
  /**
   * Podignut blok je iznad slobodnog vremena: čip (koji pokriva red slobodnog vremena) dobija prsten "sada", odnosno
   * žut kad blok ne staje ceo i pomera ostale.
   */
  liftedInto: 'free' | 'push' | null;
  /** Na mestu podignutog bloka ostaje slobodno vreme (blok je počeo, ili pada u slobodno vreme). */
  hole: boolean;
  /** Visina mesta podignutog bloka: počeo = njegova visina, ostali = čip (red se skupi). */
  holeH: number;
  /** Mesto podignutog bloka ostaje njegove visine (blok je počeo: tu zaista ostaje slobodno vreme). */
  fixedHole: boolean;
  shift: number;
  shifting: boolean;
  drop: boolean;
  /** Iznad slobodnog vremena u koje blok ne staje ceo (pomera blokove posle njega). */
  dropPush: boolean;
  color: string;
  showNote: boolean;
  register: (id: ItemId, el: HTMLLIElement | null) => void;
}

const CHECK_ICON = { done: 'check', partial: 'half', skipped: 'x' } as const;

type MoveTargetView = NonNullable<RowView['target']>;

/** Desno uz mesto za "Premesti": "prelazi kraj dana" (crveno) ili "pomera 2 bloka". */
export function TargetNote({ t, x }: { t: TFunction; x: MoveTargetView }) {
  if (x.over) return <span className="blk-push is-over">{t('blocks.move.over')}</span>;
  return x.pushes > 0 ? <span className="blk-push">{t('blocks.move.pushes', { n: x.pushes })}</span> : null;
}

/** Opis mesta za čitač ekrana: "Pre „Učenje“, 16:00–17:30, pomera 1 blok". */
export function targetAria(t: TFunction, x: MoveTargetView): string {
  return [x.label, x.range, x.pushes > 0 ? t('blocks.move.pushes', { n: x.pushes }) : '', x.over ? t('blocks.move.over') : '']
    .filter(Boolean)
    .join(', ');
}

export function BlockRow({ v, statusWord }: { v: RowView; statusWord: (s: BlockStatus) => string }) {
  const t = useT();
  const { c } = v;
  const free = c.kind === 'free';
  const end = v.st + v.dur;
  const range = fmtRange(v.st, end);
  const short = !free && v.dur < SHORT_MIN && !v.splitting;
  const tall = !free && !short && !v.lifted && v.h >= TALL_H;
  // Preostalo kao u traci (zaokruženo naviše na minut).
  const left = v.nowMin != null ? fmtDuration(Math.max(1, Math.ceil(end - v.nowMin))) : '';
  const status: BlockStatus = c.kind === 'block' ? c.status : 'pending';

  const liStyle: CSSProperties = {};
  if (v.lifted) {
    // Blok koji nije počeo: red prati visinu čipa (skupi se zajedno sa njim, redovi ispod se podignu).
    if (v.fixedHole) liStyle.height = `${v.holeH}px`;
    (liStyle as Record<string, string>)['--ch'] = `${Math.min(v.holeH, CHIP_H)}px`;
    (liStyle as Record<string, string>)['--hole-h'] = `${v.holeH}px`;
  }
  if (v.shift) liStyle.transform = `translateY(${v.shift}px)`;

  const boxStyle = { '--cat': free ? 'transparent' : v.color, '--h': `${v.h}px` } as CSSProperties;

  let body: ReactNode;
  let aria: string;
  if (free) {
    const dur = <b>{t('blocks.free.dur', { time: fmtDuration(v.dur) })}</b>;
    let txt: ReactNode;
    if (v.target) {
      txt = (
        <>
          <b>{v.target.label}</b>
          <span className="blk-free-range">· {v.target.range}</span>
          <TargetNote t={t} x={v.target} />
        </>
      );
    } else if (v.ghost) {
      txt = (
        <>
          <b>{t('blocks.freeTime')}</b>
          <span className="blk-free-range">{range}</span>
        </>
      );
    } else if (v.now && v.nowMin != null) {
      // "Slobodno · još 9h 30m" već kaže koliko ima do kraja: "do kraja dana" bi samo ponovilo.
      txt = (
        <>
          <b className="is-now">
            {t('blocks.free')} · {t('day.now.left', { time: left })}
          </b>
          {!v.trailing && !v.inDrag && <span className="blk-free-range">{range}</span>}
        </>
      );
    } else
      txt = (
        <>
          {dur}
          {v.trailing ? (
            <span className="blk-free-range">{t('blocks.free.toEnd')}</span>
          ) : (
            !v.inDrag && <span className="blk-free-range">{range}</span>
          )}
        </>
      );
    body = (
      <>
        <span className="blk-free-txt">{txt}</span>
        {v.canAdd && !v.target && !v.ghost && (
          <span className="blk-free-plus" aria-hidden="true">
            <span>
              <Icon name="plus" size={16} />
            </span>
          </span>
        )}
      </>
    );
    aria = v.target ? targetAria(t, v.target) : t('blocks.freeAria', { range, time: fmtDuration(v.dur) });
  } else {
    const name = c.title;
    // Delovi mete imaju ključeve: ikonica beleške (jedini deo koji prima dodir, zbog opisa) ostaje isti element i kad se
    // blok podigne — dodir čiji je cilj uklonjen iz DOM-a više ne stiže do niza (vidi .blk-text u blocks.css).
    const note = v.showNote && c.note.trim() !== '' && (
      <span key="note" className="blk-note" title={t('day.row.noteTooltip')}>
        <Icon name="note" size={14} />
        <span className="sr-only">{t('day.row.noteLabel')}</span>
      </span>
    );
    const sep = (k: string) => (
      <span key={k} className="blk-sep" aria-hidden="true">
        ·
      </span>
    );
    let meta: ReactNode;
    if (v.lifted) {
      meta = (
        <>
          <span key="range" className="blk-range is-live">
            {range}
          </span>
          {v.liftedLabel && sep('sep')}
          {v.liftedLabel && (
            <span key="extra" className="blk-extra">
              {v.liftedLabel}
            </span>
          )}
          {note}
        </>
      );
    } else {
      // Tačno jedan dodatak posle opsega: preostalo (tekući) → čeka ocenu → stvarno vreme → trajanje.
      const extra = v.now ? (
        <span className="blk-extra is-now">{t('day.now.left', { time: left })}</span>
      ) : v.due ? (
        <span className="blk-extra is-due">{t('day.row.due')}</span>
      ) : v.started && c.actualMin != null && (c.status === 'done' || c.status === 'partial') ? (
        <span className="blk-extra">{t('day.row.actual', { time: fmtDuration(c.actualMin) })}</span>
      ) : (
        <span className="blk-extra">{fmtDuration(v.dur)}</span>
      );
      meta = (
        <>
          <span key="range" className="blk-range">
            {range}
          </span>
          {sep('sep')}
          <Fragment key="extra">{extra}</Fragment>
          {note}
          {v.over && sep('sep-over')}
          {v.over && (
            <span key="over" className="blk-extra is-over">
              {t('blocks.row.over')}
            </span>
          )}
        </>
      );
    }
    const ghostEmpty = v.ghost && v.placeholder;
    body = (
      <span className="blk-head">
        <CategoryStroke color={v.color} />
        <span className="blk-text">
          <span className={cx('blk-name', ghostEmpty && 'is-placeholder')}>{ghostEmpty ? t('day.block.newTitle') : name}</span>
          <span className="blk-meta">{meta}</span>
        </span>
      </span>
    );
    aria =
      t('blocks.rowAria', { name, range, time: fmtDuration(v.dur) }) +
      (v.started ? ', ' + (v.now ? t('day.nowTag') : v.due ? t('day.row.due') : statusWord(c.status)) : '');
  }

  const ck = v.check;

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
        free && v.pastFree && 'is-past-free',
        short && 'is-short',
        tall && 'is-tall',
        v.splitting && 'is-splitting',
        v.ghost && 'is-ghost',
        v.over && 'is-over',
        v.moving && 'is-moving',
        v.target && 'is-target',
        !free && `is-${status}`,
        ck && 'has-check',
        v.canResize && 'can-resize',
        v.canResizeStart && 'can-resize-start',
        v.noLift && 'no-lift',
        v.lifted && 'is-lifted',
        v.lifted && v.hole && 'is-leaving-hole',
        v.liftedInto && 'is-into-free',
        v.liftedInto === 'push' && 'is-into-push',
        v.shifting && 'is-shifting',
        v.drop && 'is-drop',
        v.dropPush && 'is-push',
      )}
      data-key={v.key}
      data-hole={v.lifted ? t('blocks.free') : undefined}
      style={liStyle}
    >
      <div className="blk-box" style={boxStyle}>
        <button
          type="button"
          className="blk-main"
          aria-label={aria}
          aria-pressed={free ? undefined : v.selected}
          disabled={free && v.pastFree && !v.target}
          tabIndex={v.ghost || (free && v.inMove && !v.target) ? -1 : 0}
        >
          {body}
        </button>
        {ck && (
          <button
            type="button"
            className="blk-check"
            data-status={ck.status}
            aria-label={ck.label}
            aria-haspopup={ck.popup ? 'dialog' : undefined}
            aria-expanded={ck.popup ? ck.open : undefined}
            tabIndex={v.lifted ? -1 : 0}
          >
            <span className="blk-check-c">{ck.status !== 'pending' && <Icon name={CHECK_ICON[ck.status]} size={16} />}</span>
          </button>
        )}
        {v.prog != null && (
          <span className="blk-prog" aria-hidden="true">
            <i style={{ width: `${(v.prog * 100).toFixed(1)}%` }} />
          </span>
        )}
        {v.splitting && (
          <Cuts cuts={v.splitting.cuts} custom={v.splitting.custom} name={c.kind === 'block' ? c.title : ''} color={v.color} st={v.st} dur={v.dur} h={v.h} />
        )}
        {!free && (
          <>
            <button
              type="button"
              className="blk-grip is-start"
              aria-label={t('blocks.gripStart')}
              tabIndex={v.selected && v.canResizeStart ? 0 : -1}
              data-no-swipe
            />
            <button
              type="button"
              className="blk-grip"
              aria-label={t('blocks.grip')}
              tabIndex={v.selected && v.canResize ? 0 : -1}
              data-no-swipe
            />
          </>
        )}
      </div>
    </li>
  );
}

/** Visina oznake jednog dela u uređivaču rezova (naziv + "40m · 16:00–16:40"); crta dela je visoka koliko i ona. */
const PIECE_LABEL_H = 38;
/** Jedan red oznake ("40m · 16:00–16:40"). */
const PIECE_LINE_H = 18;
/** Prvi deo niži od ovoga (px) ima naziv i opseg u jednom redu; deo niži od PIECE_MIN_H je bez oznake. */
const PIECE_TWO_H = 50;
const PIECE_MIN_H = 22;
/** Kratka crta dela u koji crta sa dve kuke ne staje. */
const PIECE_TICK_H = 14;

/**
 * Uređivač rezova u bloku: svaki deo ima svoju crtu kategorije i oznaku ("40m · 16:00–16:40", prvi i naziv), pa blok
 * već izgleda kao N blokova; rez je isprekidana linija sa oznakom vremena koja se vuče. × uz rez samo kad su rezovi
 * ručni i ima ih više od jednog (jednaki delovi se biraju brojem u listu; jedini rez se ne uklanja).
 * Oznake se nikad ne preklapaju: nizak deo ima jedan red (prvi: "10m · 15:30–15:40 · Ručak" — skraćuje se naziv, ne
 * trajanje i opseg), sasvim nizak nijedan. Deo u koji crta (dve kuke) ne staje ima kratku crtu u boji kategorije.
 */
function Cuts({
  cuts,
  custom,
  name,
  color,
  st,
  dur,
  h,
}: {
  cuts: number[];
  custom: boolean;
  name: string;
  color: string;
  st: number;
  dur: number;
  h: number;
}) {
  const t = useT();
  const sorted = [...cuts].sort((a, b) => a - b);
  const pts = [0, ...sorted, dur];
  const removable = custom && sorted.length > 1;
  return (
    <div className="blk-cuts">
      {pts.slice(0, -1).map((p, k) => {
        const y0 = (p / dur) * h;
        const ph = (pts[k + 1] / dur) * h - y0;
        const lines = k === 0 && ph >= PIECE_TWO_H ? 2 : ph >= PIECE_MIN_H ? 1 : 0;
        // Crta koliko oznaka (prvi deo: dva reda), nikad preko sledećeg dela; ispod visine dve kuke (28 px) kratka crta
        // uz oznaku (ili po sredini dela bez oznake).
        const sh = Math.min(lines === 2 ? PIECE_LABEL_H : 28, ph - 16);
        const labelTop = y0 + (lines === 2 ? 9 : Math.min(9, (ph - PIECE_LINE_H) / 2));
        const tickH = Math.min(PIECE_TICK_H, ph - 8);
        return (
          <Fragment key={k}>
            {sh >= 28 ? (
              <span className="blk-cut-stroke" style={{ top: y0 + 11, height: sh }}>
                <CategoryStroke color={color} />
              </span>
            ) : (
              tickH >= 6 && (
                <span
                  className="blk-cut-tick"
                  style={{ top: lines > 0 ? labelTop + (PIECE_LINE_H - tickH) / 2 : y0 + (ph - tickH) / 2, height: tickH, background: color }}
                />
              )
            )}
            {lines > 0 && (
              <span className="blk-cut-piece" style={{ top: labelTop }}>
                {lines === 2 && <span className="blk-cut-name">{name}</span>}
                <span className="blk-cut-meta">
                  <b>{fmtDuration(pts[k + 1] - p)}</b> · {fmtRange(st + p, st + pts[k + 1])}
                  {k === 0 && lines === 1 && (
                    <>
                      {' '}
                      · <span className="blk-cut-nm">{name}</span>
                    </>
                  )}
                </span>
              </span>
            )}
          </Fragment>
        );
      })}
      {sorted.map((m, k) => {
        const tm = fmtClock(st + m);
        return (
          <div key={k} className="blk-cut" style={{ top: (m / dur) * h }}>
            <div className="blk-cut-handle">
              {removable && (
                <button type="button" className="cut-x" data-cutx={k} aria-label={t('blocks.split.removeCut', { time: tm })}>
                  <span>
                    <Icon name="x" size={14} />
                  </span>
                </button>
              )}
              <button type="button" className="cut-drag" data-cut={k} aria-label={t('blocks.split.cutAt', { time: tm })} data-no-swipe>
                <span>{tm}</span>
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}
