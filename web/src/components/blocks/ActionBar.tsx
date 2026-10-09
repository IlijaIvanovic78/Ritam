// Traka akcija izabranog bloka (telefon: iznad donje trake; desktop: na dnu kolone niza): naziv (✎ =
// preimenuj), opseg, ×; posle deljenja "Podeli na [2] [3] [4] [Ručno…]"; akcije; režimi rezova, premeštanja i
// preimenovanja. Poruke se, dok je traka otvorena, prikazuju u njoj (tamni red sa Poništi i ×).

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { fmtDuration } from '../../../../shared/time.ts';
import { useT, type MessageKey } from '../../i18n/index.ts';
import { CategoryDot, Icon, cx } from '../../ui/index.ts';
import type { DockAction, Msg, StackController } from './controller.ts';
import { finePointer } from './geometry.ts';

const LABELS = {
  split: ['blocks.act.split', 'blocks.act.splitKey'],
  move: ['blocks.act.move', 'blocks.act.moveKey'],
  endnow: ['blocks.act.endNow', 'blocks.act.endNowKey'],
  shorter: ['blocks.act.shorter', 'blocks.act.shorterKey'],
  longer: ['blocks.act.longer', 'blocks.act.longerKey'],
  delete: ['blocks.act.delete', 'blocks.act.deleteKey'],
  details: ['blocks.act.details', 'blocks.act.detailsKey'],
} as const satisfies Record<DockAction['act'], readonly [MessageKey, MessageKey]>;

/**
 * Poruka sa Poništi / akcijom i ×: u traci akcija ili kao plutajuća poruka iznad donje trake. Bez role="status":
 * čitač ekrana je čuje samo kroz stalni aria-live region niza (ctl.say), jednom.
 */
export function MsgRow({ ctl, msg, className }: { ctl: StackController; msg: Msg; className: string }) {
  const t = useT();
  return (
    <div className={className}>
      <span className="blk-msg-text">{msg.text}</span>
      {msg.actions.map((a, k) => (
        <button
          key={k}
          type="button"
          className="blk-msg-act"
          onClick={() => {
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
          onClick={() => ctl.undoFromMsg(msg)}
        >
          {t('blocks.act.undo')}
        </button>
      )}
      <button
        type="button"
        className="blk-msg-close"
        aria-label={t('common.close')}
        onClick={(e) => ctl.dismissMsg(msg, e.currentTarget.parentElement?.contains(document.activeElement) ?? false)}
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

  // Visina trake na telefonu: stranica dobija toliko prostora na dnu (--dock-h).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const root = document.documentElement;
    const set = () => root.style.setProperty('--dock-h', window.innerWidth < 860 ? `${el.offsetHeight + 8}px` : '0px');
    set();
    const ro = new ResizeObserver(set);
    ro.observe(el);
    window.addEventListener('resize', set);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', set);
      root.style.setProperty('--dock-h', '0px');
    };
  }, []);

  if (!c) return null;
  const list = ctl.items;
  const i = ctl.M.idxOf(list, c.id);
  const view = ctl.preview ?? list;
  const vi = ctl.M.idxOf(view, c.id);
  const when = vi >= 0 ? `${ctl.rangeIn(view, c.id)} · ${fmtDuration(view[vi].dur)}` : '';
  const mode = ctl.splitSt ? 'split' : ctl.moveSt ? 'move' : ctl.renaming ? 'rename' : 'block';

  let body: ReactNode;
  if (mode === 'split' && ctl.splitSt) {
    const cuts = [...ctl.splitSt.cuts].sort((a, b) => a - b);
    const n = cuts.length + 1;
    const pts = [0, ...cuts, c.dur];
    const d = pts.slice(1).map((p, k) => p - pts[k]);
    const sum = d.length < 2 ? '' : d.every((x) => x === d[0]) ? `${d.length} × ${fmtDuration(d[0])}` : d.map(fmtDuration).join(' + ');
    body = (
      <>
        <div className="blk-dock-head">
          <span className="blk-dock-title">{t('blocks.split.title', { name: c.title })}</span>
          <button type="button" className="icon-btn blk-dock-close" aria-label={t('blocks.split.cancel')} onClick={() => cancelSplit(ctl)}>
            <Icon name="x" />
          </button>
        </div>
        <div className="blk-dock-row" role="group" aria-label={t('blocks.split.label')}>
          {[2, 3, 4].map((k) => {
            const e = ctl.M.cuts15(c.dur, k);
            return (
              <button
                key={k}
                type="button"
                className={cx('chip', !!e && e.join() === cuts.join() && 'is-active')}
                disabled={!e}
                onClick={() => e && ctl.setCuts(e)}
              >
                {t('blocks.split.n', { n: k })}
              </button>
            );
          })}
          <span className="blk-dock-sum">{sum}</span>
        </div>
        <p className="blk-dock-hint">{finePointer() ? t('blocks.split.hintFine') : t('blocks.split.hintTouch')}</p>
        <div className="blk-dock-foot">
          <button type="button" className="btn btn-secondary" onClick={() => cancelSplit(ctl)}>
            {t('common.cancel')}
          </button>
          <button type="button" className="btn btn-primary" disabled={n < 2} onClick={() => ctl.confirmSplit()}>
            {n > 1 ? t('blocks.split.confirm', { n }) : t('blocks.split.addCut')}
          </button>
        </div>
      </>
    );
  } else if (mode === 'move') {
    body = (
      <>
        <div className="blk-dock-head">
          <span className="blk-dock-title">
            {t('blocks.move.title', { name: c.title })} <span className="muted">· {fmtDuration(c.dur)}</span>
          </span>
          <button type="button" className="icon-btn blk-dock-close" aria-label={t('common.cancel')} onClick={() => ctl.cancelMove()}>
            <Icon name="x" />
          </button>
        </div>
        <p className="blk-dock-hint">{t('blocks.move.hint')}</p>
      </>
    );
  } else if (mode === 'rename') {
    body = <Rename ctl={ctl} key={String(c.id)} />;
  } else {
    const { acts, past } = ctl.dockActions(list, i);
    const fam = ctl.splitFam;
    const famOrig = fam ? fam.orig.find((x) => x.id === fam.origId) : undefined;
    body = (
      <>
        <div className="blk-dock-head">
          <button type="button" className="blk-dock-name" aria-label={t('blocks.dock.rename', { name: c.title })} onClick={() => ctl.startRename()}>
            <span>{c.title}</span>
            <Icon name="edit" size={15} />
          </button>
          <span className="blk-dock-when">{when}</span>
          <button type="button" className="icon-btn blk-dock-close" aria-label={t('blocks.dock.close')} onClick={() => ctl.closeDock()}>
            <Icon name="x" />
          </button>
        </div>
        {fam && famOrig && (
          <div className="blk-dock-row" role="group" aria-label={t('blocks.split.label')}>
            <span className="blk-dock-row-label">{t('blocks.split.label')}</span>
            {[2, 3, 4].map((k) => (
              <button
                key={k}
                type="button"
                className={cx('chip blk-chip-n', fam.n === k && 'is-active')}
                aria-pressed={fam.n === k}
                aria-label={t('blocks.split.n', { n: k })}
                disabled={!ctl.M.cuts15(famOrig.dur, k)}
                onClick={() => ctl.resplit(k)}
              >
                {k}
              </button>
            ))}
            <button type="button" className="chip chip-dashed" onClick={() => ctl.customCuts()}>
              {t('blocks.split.custom')}
            </button>
          </div>
        )}
        {past && <p className="blk-dock-hint">{t('blocks.dock.past')}</p>}
        <div className={cx('blk-dock-actions', acts.length >= 7 && 'is-many')} style={{ ['--n' as string]: acts.length }}>
          {acts.map((a) => (
            <button
              key={a.act}
              type="button"
              className={cx('blk-dock-btn', a.cls)}
              data-act={a.act}
              title={t(LABELS[a.act][1])}
              disabled={a.disabled}
              onClick={(e) => ctl.dockAction(a.act, e.detail === 0)}
            >
              <Icon name={a.icon} />
              <span>{t(LABELS[a.act][0])}</span>
            </button>
          ))}
        </div>
        <p className="blk-dock-keys">{t(ctl.cfg.mode === 'template' ? 'blocks.dock.keysTpl' : 'blocks.dock.keys')}</p>
      </>
    );
  }

  return (
    <div
      ref={(el) => {
        ref.current = el;
        ctl.dockEl = el;
      }}
      className="blk-dock"
      role="region"
      aria-label={t('blocks.dock.aria')}
    >
      {ctl.msg && <MsgRow ctl={ctl} msg={ctl.msg} className="blk-dock-msg" />}
      {body}
    </div>
  );
}

function cancelSplit(ctl: StackController) {
  ctl.splitSt = null;
  ctl.emit();
  ctl.focusRow(ctl.sel);
}

/** Preimenovanje u traci: polje sa izabranim tekstom, ✓ i ×; čipovi korisnikovih drugih naziva (jedan dodir). */
function Rename({ ctl }: { ctl: StackController }) {
  const t = useT();
  const c = ctl.cur();
  const [value, setValue] = useState(c?.title ?? '');
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);
  if (!c) return null;
  const sugs = ctl
    .knownNames()
    .filter((n) => n.name !== c.title)
    .slice(0, 10);
  return (
    <>
      <form
        className="blk-dock-rename"
        onSubmit={(e) => {
          e.preventDefault();
          ctl.rename(c.id, value);
          ctl.focusRow(c.id);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            ctl.cancelRename();
          }
        }}
      >
        <input
          ref={inputRef}
          className="input"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-label={t('blocks.name')}
          placeholder={t('day.block.titlePlaceholder')}
          maxLength={120}
          autoComplete="off"
          enterKeyHint="done"
        />
        <button type="submit" className="icon-btn" aria-label={t('blocks.rename.save')}>
          <Icon name="check" />
        </button>
        <button type="button" className="icon-btn" aria-label={t('common.cancel')} onClick={() => ctl.cancelRename()}>
          <Icon name="x" />
        </button>
      </form>
      {sugs.length > 0 && (
        <div className="blk-dock-sugs" role="group" aria-label={t('blocks.yourNames')} data-no-swipe>
          {sugs.map((s) => (
            <button key={s.name} type="button" className="chip" onClick={() => ctl.rename(c.id, s.name, s.cat)}>
              <CategoryDot color={ctl.catColor(s.cat)} />
              <span>{s.name}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}
