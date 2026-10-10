// List izabranog bloka (telefon: iznad donje trake; 860–999 px: na dnu kolone niza; ≥ 1000 px: u desnoj koloni):
// naziv ("Detalji ›") i ×, ocena (blok koji je počeo), Početak / Kraj u koracima od 5 min (držanje ponavlja, vreme se
// dodirne da se upiše) i najviše četiri pločice. Režimi deljenja (2–6 delova ili ručni rezovi) i premeštanja (mesta u
// nizu, Ranije / Kasnije, ceo blok ±5 min). Poruke se, dok je list otvoren, prikazuju u njemu (prvi red, dva reda teksta).

import { useEffect, useLayoutEffect, useRef, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import type { BlockStatus } from '../../../../shared/types.ts';
import { fmtClock, fmtDuration } from '../../../../shared/time.ts';
import type { StackBlock } from '../../../../shared/blockStack.ts';
import { useT, type MessageKey } from '../../i18n/index.ts';
import { CategoryDot, Icon, cx } from '../../ui/index.ts';
import { MSG_TAP_GUARD_MS, type DockAction, type Msg, type StackController, type StepEdge } from './controller.ts';
import { finePointer, fmtRange, guardTap } from './geometry.ts';
import { Stepper, TimeValue } from './Stepper.tsx';

const LABELS = {
  endnow: ['blocks.act.endNow', 'blocks.act.endNowKey'],
  split: ['blocks.act.split', 'blocks.act.splitKey'],
  move: ['blocks.act.move', 'blocks.act.moveKey'],
  after: ['blocks.act.addAfter', 'blocks.act.addAfterKey'],
  delete: ['blocks.act.delete', 'blocks.act.deleteKey'],
} as const satisfies Record<DockAction['act'], readonly [MessageKey, MessageKey]>;

const RATE: Array<{
  s: Exclude<BlockStatus, 'pending'>;
  icon: 'check' | 'half' | 'x';
  label: Extract<MessageKey, 'status.done' | 'status.partial' | 'blocks.rate.skippedShort'>;
  aria: Extract<MessageKey, 'status.done' | 'status.partial' | 'status.skipped'>;
}> = [
  { s: 'done', icon: 'check', label: 'status.done', aria: 'status.done' },
  { s: 'partial', icon: 'half', label: 'status.partial', aria: 'status.partial' },
  // "Nije urađeno" ne staje u trećinu lista na 360 px: vidljivo kratko, čitač ekrana čuje ceo naziv.
  { s: 'skipped', icon: 'x', label: 'blocks.rate.skippedShort', aria: 'status.skipped' },
];

/** "+25m" / "−15m". */
const signed = (d: number) => `${d > 0 ? '+' : '−'}${fmtDuration(Math.abs(d))}`;

/**
 * Poruka sa Poništi / akcijom i ×: u listu bloka ili kao plutajuća poruka iznad donje trake (tekst do dva reda). Bez
 * role="status": čitač ekrana je čuje samo kroz stalni aria-live region niza (ctl.say), jednom.
 * Dodir odmah posle pojavljivanja poruke (MSG_TAP_GUARD_MS) je drugi dodir dugmeta koje je bilo ispod nje (npr. dva
 * brza dodira na Obriši: plutajuća poruka se pojavi tačno na mestu pločice) — ne računa se. I obrnuto: posle dodira na
 * poruku pod prstom je često nešto drugo (Poništi brisanja ponovo otvara list bloka, sa Obriši tačno tu), pa se drugi
 * dodir dvostrukog dodira proguta (guardTap).
 */
export function MsgRow({ ctl, msg, className }: { ctl: StackController; msg: Msg; className: string }) {
  const t = useT();
  const fresh = (e: MouseEvent) => e.detail !== 0 && performance.now() - msg.at < MSG_TAP_GUARD_MS;
  return (
    <div className={className}>
      <span className="blk-msg-text">{msg.text}</span>
      {msg.actions.map((a, k) => (
        <button
          key={k}
          type="button"
          className="blk-msg-act"
          onClick={(e) => {
            if (fresh(e)) return;
            guardTap(e);
            ctl.closeMsg();
            a.fn();
          }}
        >
          {a.label}
        </button>
      ))}
      {msg.undo && (
        <button
          type="button"
          className="blk-msg-act"
          onClick={(e) => {
            if (fresh(e)) return;
            guardTap(e);
            ctl.undoFromMsg(msg);
          }}
        >
          {t('blocks.act.undo')}
        </button>
      )}
      <button
        type="button"
        className="blk-msg-close"
        aria-label={t('common.close')}
        onClick={(e) => {
          if (fresh(e)) return;
          guardTap(e);
          ctl.dismissMsg(msg, e.currentTarget.parentElement?.contains(document.activeElement) ?? false);
        }}
      >
        <Icon name="x" size={16} />
      </button>
    </div>
  );
}

export function ActionBar({ ctl }: { ctl: StackController }) {
  const t = useT();
  const c = ctl.cur();
  const ref = useRef<HTMLDivElement>(null);

  // Telefon: stranica dobija prostor ispod lista (--dock-h); kad list poraste (poruka), izabran blok ostaje iznad njega.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = document.documentElement;
    const set = () => root.style.setProperty('--dock-h', window.innerWidth < 860 && !ctl.dockInSide ? `${el.offsetHeight + 8}px` : '0px');
    set();
    const ro = new ResizeObserver(() => {
      set();
      if (!ctl.splitSt) ctl.keepSelVisible();
    });
    ro.observe(el);
    window.addEventListener('resize', set);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', set);
      root.style.setProperty('--dock-h', '0px');
    };
  }, [ctl]);

  if (!c) return null;
  const mode = ctl.splitSt ? 'split' : ctl.moveSt ? 'move' : 'block';

  return (
    <div
      ref={(el) => {
        ref.current = el;
        ctl.dockEl = el;
      }}
      className={cx('blk-dock', ctl.dockInSide && 'is-side')}
      role="region"
      aria-label={t('blocks.dock.aria')}
      data-no-swipe
    >
      {ctl.msg && <MsgRow ctl={ctl} msg={ctl.msg} className="blk-dock-msg" />}
      {mode === 'split' ? <SplitPanel ctl={ctl} c={c} /> : mode === 'move' ? <MovePanel ctl={ctl} c={c} /> : <BlockPanel ctl={ctl} c={c} />}
    </div>
  );
}

/** Gornji red lista u režimu deljenja / premeštanja: naslov i ×. */
function PanelHead({ title, closeLabel, onClose }: { title: ReactNode; closeLabel: string; onClose: () => void }) {
  return (
    <div className="blk-dock-bar">
      <span className="blk-dock-title">{title}</span>
      <button type="button" className="icon-btn blk-dock-close" aria-label={closeLabel} onClick={onClose}>
        <Icon name="x" />
      </button>
    </div>
  );
}

function BlockPanel({ ctl, c }: { ctl: StackController; c: StackBlock }) {
  const t = useT();
  const M = ctl.M;
  const list = ctl.items;
  const i = M.idxOf(list, c.id);
  const A = ctl.anch();
  // Uživo (ručica se vuče): trajanje i vremena iz pregleda.
  const view = ctl.preview ?? list;
  const vi = M.idxOf(view, c.id);
  const vst = M.startsOf(view)[vi] ?? 0;
  const vdur = view[vi]?.dur ?? c.dur;
  const { acts, past, locked } = ctl.tiles(list, i);
  const canRate = ctl.cfg.mode === 'day' && !!A && M.startsOf(list)[i] <= A.now;
  const pastView = past || (ctl.cfg.pastDay && ctl.cfg.now == null);

  // Naziv je najvažniji u gornjem redu: kad ne staje ceo (u uskom listu: u dva reda), "Detalji" ostaje samo strelica
  // (opis je u aria-label).
  const headRef = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const head = headRef.current;
    const name = head?.querySelector<HTMLElement>('.blk-dock-name');
    if (!head || !name) return;
    head.classList.remove('is-tight');
    if (name.scrollWidth > name.clientWidth + 1 || name.scrollHeight > name.clientHeight + 1) head.classList.add('is-tight');
  });

  let times: ReactNode;
  if (locked) times = <p className="blk-dock-note">{t(ctl.cfg.mode === 'template' ? 'blocks.overlap.lockedTpl' : 'blocks.overlap.locked')}</p>;
  else if (pastView)
    times = (
      <p className="blk-dock-note">
        <b>{fmtRange(vst, vst + vdur)}</b> · {t('blocks.dock.past')}
      </p>
    );
  else times = <TimeSteppers ctl={ctl} c={c} i={i} start={vst} end={vst + vdur} />;

  return (
    <>
      <div className="blk-dock-bar">
        <button
          ref={headRef}
          type="button"
          className="blk-dock-head"
          aria-label={t('blocks.dock.details', { name: c.title })}
          title={t('blocks.act.detailsKey')}
          onClick={() => ctl.openDetails(c.id)}
        >
          <CategoryDot color={ctl.catColor(c.categoryId)} size={9} />
          <span className="blk-dock-name">{c.title}</span>
          <span className="blk-dock-dur">{fmtDuration(vdur)}</span>
          <span className="blk-dock-more">
            <span className="blk-dock-more-l">{t('blocks.act.details')}</span>
            <Icon name="chevron-right" size={16} />
          </span>
        </button>
        <button type="button" className="icon-btn blk-dock-close" aria-label={t('blocks.dock.close')} onClick={() => ctl.closeDock()}>
          <Icon name="x" />
        </button>
      </div>
      {canRate && (
        <div className="blk-rate" role="group" aria-label={t('day.row.statusLabel', { title: c.title })}>
          {RATE.map((o) => {
            const on = c.status === o.s;
            return (
              <button
                key={o.s}
                type="button"
                className={cx('blk-rate-btn', `is-${o.s}`, on && 'is-on')}
                aria-pressed={on}
                aria-label={t(o.aria)}
                onClick={() => ctl.rate(c.id, o.s, 'sheet')}
              >
                <Icon name={o.icon} size={18} />
                <span>{t(o.label)}</span>
              </button>
            );
          })}
        </div>
      )}
      {times}
      {acts.length > 0 && (
        <div className="blk-tiles" style={{ '--n': acts.length } as CSSProperties}>
          {acts.map((a) => (
            <button
              key={a.act}
              type="button"
              className={cx('blk-tile', a.cls)}
              data-act={a.act}
              title={t(LABELS[a.act][1])}
              disabled={a.disabled}
              onClick={(e) => {
                // Pločica se pod prstom menja (Završi sad → Dodaj posle) ili otvara list / poruku tačno tu.
                guardTap(e);
                ctl.dockAction(a.act, e.detail === 0);
              }}
            >
              <Icon name={a.icon} size={22} />
              <span>{t(LABELS[a.act][0])}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

/** Oznaka iznad koraka: "Početak", "Početak · počelo"; dok traje niz koraka i pomak ("· +25m"). */
function StepLabel({ ctl, id, edge, text }: { ctl: StackController; id: StackBlock['id']; edge: StepEdge; text: string }) {
  const d = ctl.stepDelta(id, edge);
  return (
    <p className="blk-stp-lbl">
      {text}
      {d != null && <span className="is-delta"> · {signed(d)}</span>}
    </p>
  );
}

/** Početak i Kraj: −/+ 5 min (držanje ponavlja), vreme se dodirne da se upiše; tekući blok ima zaključan početak. */
function TimeSteppers({ ctl, c, i, start, end }: { ctl: StackController; c: StackBlock; i: number; start: number; end: number }) {
  const t = useT();
  const M = ctl.M;
  const list = ctl.items;
  const A = ctl.anch();
  const SNAP = M.SNAP;
  const st = M.startsOf(list)[i];
  const range = M.canResizeStart(list, i, A) ? M.startRange(list, c.id, A) : null;
  const canE = M.canResize(list, i, A);
  // Uvek izabran blok (posle odgovora servera id može biti nov).
  const id = () => ctl.cur()?.id;
  const step = (fn: (id: StackBlock['id']) => boolean) => () => {
    const x = id();
    return x != null && fn(x);
  };
  const S = t('blocks.time.start');
  const E = t('blocks.time.end');
  return (
    <div className="blk-times">
      <div>
        <StepLabel ctl={ctl} id={c.id} edge="start" text={range ? S : `${S} · ${t('blocks.time.started')}`} />
        <Stepper
          locked={!range}
          minus={step((x) => ctl.resizeStartBy(x, -SNAP, { quiet: true }))}
          plus={step((x) => ctl.resizeStartBy(x, SNAP, { quiet: true }))}
          canMinus={!!range && st > range.min}
          canPlus={!!range && st < range.max}
          minusLabel={t('blocks.time.startEarlier')}
          plusLabel={t('blocks.time.startLater')}
        >
          <TimeValue
            minute={start}
            label={t('blocks.time.type', { edge: S, time: fmtClock(start) })}
            onSet={range ? (v) => void ctl.setEdgeTime(c.id, 'start', v) : undefined}
          />
        </Stepper>
      </div>
      <div>
        <StepLabel ctl={ctl} id={c.id} edge="end" text={E} />
        <Stepper
          locked={!canE}
          minus={step((x) => ctl.resizeBy(x, -SNAP, { quiet: true }))}
          plus={step((x) => ctl.resizeBy(x, SNAP, { quiet: true }))}
          canMinus={canE && c.dur > M.minDurAt(list, i, A)}
          canPlus={canE && M.stepDur(list, c.id, SNAP, A) != null && c.dur < M.LEN}
          minusLabel={t('blocks.time.endEarlier')}
          plusLabel={t('blocks.time.endLater')}
        >
          <TimeValue
            minute={end}
            label={t('blocks.time.type', { edge: E, time: fmtClock(end) })}
            onSet={canE ? (v) => void ctl.setEdgeTime(c.id, 'end', v) : undefined}
          />
        </Stepper>
      </div>
    </div>
  );
}

/** Deljenje: broj delova 2–6 (ili ručni rezovi u kartici), zbir delova, Otkaži / Podeli na N delova. */
function SplitPanel({ ctl, c }: { ctl: StackController; c: StackBlock }) {
  const t = useT();
  const cuts = [...(ctl.splitSt?.cuts ?? [])].sort((a, b) => a - b);
  const n = cuts.length + 1;
  const pts = [0, ...cuts, c.dur];
  const d = pts.slice(1).map((p, k) => p - pts[k]);
  const sum = d.every((x) => x === d[0]) ? (n > 1 ? `${n} × ${fmtDuration(d[0])}` : fmtDuration(c.dur)) : d.map(fmtDuration).join(' + ');
  return (
    <>
      <PanelHead title={t('blocks.split.title', { name: c.title })} closeLabel={t('blocks.split.cancel')} onClose={() => cancelSplit(ctl)} />
      <p className="blk-dock-lbl">{t('blocks.split.parts')}</p>
      <div className="blk-seg-n" role="group" aria-label={t('blocks.split.label')}>
        {[2, 3, 4, 5, 6].map((k) => {
          const e = ctl.M.cuts15(c.dur, k);
          const on = !!e && e.join() === cuts.join();
          return (
            <button
              key={k}
              type="button"
              aria-pressed={on}
              aria-label={t('blocks.split.n', { n: k })}
              disabled={!e}
              onClick={() => e && ctl.setCuts(e)}
            >
              {k}
            </button>
          );
        })}
      </div>
      <p className="blk-split-sum">{sum}</p>
      <p className="blk-dock-hint is-split">{finePointer() ? t('blocks.split.hintFine') : t('blocks.split.hintTouch')}</p>
      <div className="blk-dock-foot">
        {/* Posle oba dugmeta list se menja (pločice bloka): drugi brzi dodir ne sme da pogodi pločicu ispod. */}
        <button
          type="button"
          className="btn btn-secondary"
          onClick={(e) => {
            guardTap(e);
            cancelSplit(ctl);
          }}
        >
          {t('common.cancel')}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={n < 2}
          onClick={(e) => {
            guardTap(e);
            ctl.confirmSplit();
          }}
        >
          {n > 1 ? t('blocks.split.confirm', { n }) : t('blocks.split.addCut')}
        </button>
      </div>
    </>
  );
}

/**
 * Premeštanje: mesta su u nizu (natpis, opseg, "pomera N"); ovde Ranije / Kasnije za jedno mesto (sa opsegom posle
 * koraka; režim ostaje) i "Ceo blok" ±5 min kroz slobodno vreme (blok koji još nije počeo).
 */
function MovePanel({ ctl, c }: { ctl: StackController; c: StackBlock }) {
  const t = useT();
  const M = ctl.M;
  const i = M.idxOf(ctl.items, c.id);
  const st = M.startsOf(ctl.items)[i] ?? 0;
  const whole = M.canResizeStart(ctl.items, i, ctl.anch()) && !ctl.cfg.pastDay;
  const id = () => ctl.cur()?.id;
  const nudge = (dir: -1 | 1) => () => {
    const x = id();
    return x != null && ctl.nudge(x, dir, { quiet: true, stay: true });
  };
  return (
    <>
      <PanelHead
        title={
          <>
            {t('blocks.move.title', { name: c.title })} <span className="muted">· {fmtDuration(c.dur)}</span>
          </>
        }
        closeLabel={t('common.cancel')}
        onClose={() => ctl.cancelMove()}
      />
      <div className="blk-tiles is-move" style={{ '--n': 2 } as CSSProperties}>
        {([-1, 1] as const).map((dir) => {
          const r = ctl.moveResult(c.id, dir);
          // Bez mesta je samo aria-disabled: fokus tastature (Enter ponavlja korak) ostaje na pločici.
          return (
            <button
              key={dir}
              type="button"
              className="blk-tile is-row"
              data-act={dir < 0 ? 'earlier' : 'later'}
              aria-disabled={!r || undefined}
              onClick={() => {
                const x = id();
                if (r && x != null) ctl.moveBy(x, dir);
              }}
            >
              <Icon name={dir < 0 ? 'arrow-up' : 'arrow-down'} size={22} />
              <span className="blk-tile-txt">
                <span>{t(dir < 0 ? 'blocks.act.earlier' : 'blocks.act.later')}</span>
                <small>{r ?? t('blocks.move.noRoom')}</small>
              </span>
            </button>
          );
        })}
      </div>
      {whole && (
        <div className="blk-whole">
          <p className="blk-stp-lbl">
            {t('blocks.move.whole')} · {t('blocks.move.wholeHint')}
            {ctl.stepDelta(c.id, 'nudge') != null && <span className="is-delta"> · {signed(ctl.stepDelta(c.id, 'nudge')!)}</span>}
          </p>
          <Stepper
            minus={nudge(-1)}
            plus={nudge(1)}
            canMinus={ctl.canNudge(c.id, -1)}
            canPlus={ctl.canNudge(c.id, 1)}
            minusLabel={t('blocks.move.wholeEarlier')}
            plusLabel={t('blocks.move.wholeLater')}
          >
            <span className="blk-stp-val is-range">{fmtRange(st, st + c.dur)}</span>
          </Stepper>
        </div>
      )}
      <p className="blk-dock-hint">{finePointer() ? t('blocks.move.hintFine') : t('blocks.move.hint')}</p>
    </>
  );
}

function cancelSplit(ctl: StackController) {
  ctl.splitSt = null;
  ctl.emit();
  ctl.focusRow(ctl.sel);
}
