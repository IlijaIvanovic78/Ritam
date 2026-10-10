// Dan (ili šablon) kao niz blokova složenih jedan za drugim: zalepljena traka (Sada + traka dana), redovi (blokovi i
// slobodno vreme), mesta za "Premesti", kraj dana, izbor ocene, list bloka (na desktopu u desnoj koloni), poruke, list
// "Novi blok" i Detalji. Ponašanje je u StackController-u; ovde je samo crtanje i vezivanje događaja.
//
// mode 'day': ocene, "sada", sidrenje prošlosti. mode 'template': isti pokreti, bez ocena i bez "sada" (Raspored).

import { useEffect, useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Category } from '../../../../shared/types.ts';
import { fmtClock } from '../../../../shared/time.ts';
import type { ItemId } from '../../../../shared/blockStack.ts';
import { useT } from '../../i18n/index.ts';
import { Icon, cx } from '../../ui/index.ts';
import { ActionBar, MsgRow } from './ActionBar.tsx';
import { BlockRow, TargetNote, targetAria, type RowView } from './BlockRow.tsx';
import type { StackController } from './controller.ts';
import { DetailsSheet } from './DetailsSheet.tsx';
import { FREE_H, FREE_PAST_H, heightOf, reduceMotion } from './geometry.ts';
import { NewBlockSheet } from './NewBlockSheet.tsx';
import { RatePopover } from './RatePopover.tsx';
import { StackBar, type CarryOver } from './StackBar.tsx';
import './blocks.css';

/** Visina mesta za "Premesti" i slobodnog vremena koje je cilj. */
const TARGET_H = 48;

export function BlockStack({
  ctl,
  categories,
  title,
  notice,
  carryOver = null,
  scrollKey,
  inspector = null,
  dayLabel,
}: {
  ctl: StackController;
  /** Kategorije za izbor (neobrisane): list "Novi blok" i Detalji. */
  categories: Category[];
  /** Naziv šablona (režim šablona). */
  title?: string;
  /** Dan bez "sada" (raniji / budući): "Juče" ili datum, gore u traci iznad broja blokova. */
  dayLabel?: string;
  /** Trake ispod trake "Sada" (pregled iz šablona, ponuda šablona, preklapanja, prazan dan, podsetnik za juče). */
  notice?: ReactNode;
  carryOver?: CarryOver | null;
  /** Kad se promeni (drugi dan), danas se ponovo skroluje do "sada". */
  scrollKey?: string;
  /** Mesto za list bloka u desnoj koloni (domaćin; koristi se od 1000 px). */
  inspector?: HTMLElement | null;
}) {
  useSyncExternalStore(ctl.subscribe, ctl.getVersion);
  const t = useT();
  const stackRef = useRef<HTMLOListElement>(null);
  const bsRef = useRef<HTMLElement>(null);
  const prevKeys = useRef<Set<string>>(new Set());

  const { mode, now } = ctl.cfg;
  const tpl = mode === 'template';
  const list = ctl.list;
  const A = ctl.anch();
  const M = ctl.M;
  const inf = M.info(list, A);
  const d = ctl.drag;

  // ---- Događaji: pokazivač, klik, tastatura (izvorni, da touchmove može da spreči skrol) ----
  useEffect(() => {
    const el = stackRef.current;
    if (!el) return;
    ctl.stackEl = el;
    const onTouchMove = (e: TouchEvent) => {
      if (ctl.blocksTouchScroll()) e.preventDefault();
    };
    const onContext = (e: Event) => {
      if ((e.target as HTMLElement).closest('.blk')) e.preventDefault();
    };
    // Fokus tastaturom (Tab): element ceo u vidljivom delu — ne pod zalepljenom trakom ni pod trakom akcija.
    // (scroll-padding na stranici bi pomerao stranicu i pri fokusu u samim trakama.)
    const onFocusIn = (e: FocusEvent) => {
      const tg = e.target as HTMLElement;
      if (tg.matches(':focus-visible')) requestAnimationFrame(() => ctl.revealEl(tg));
    };
    el.addEventListener('pointerdown', ctl.onDown);
    el.addEventListener('touchstart', ctl.onTouchStart, { passive: true });
    el.addEventListener('click', ctl.onStackClick);
    el.addEventListener('contextmenu', onContext);
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('keydown', ctl.onStackKey);
    el.addEventListener('focusin', onFocusIn);
    document.addEventListener('keydown', ctl.onDocKey);
    document.addEventListener('click', ctl.onDocClick);
    let raf = 0;
    const onScroll = () => {
      if (!raf)
        raf = requestAnimationFrame(() => {
          raf = 0;
          ctl.updateBar();
        });
    };
    const onResize = () => ctl.emit();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize);
    return () => {
      el.removeEventListener('pointerdown', ctl.onDown);
      el.removeEventListener('touchstart', ctl.onTouchStart);
      el.removeEventListener('click', ctl.onStackClick);
      el.removeEventListener('contextmenu', onContext);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('keydown', ctl.onStackKey);
      el.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('keydown', ctl.onDocKey);
      document.removeEventListener('click', ctl.onDocClick);
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onResize);
      cancelAnimationFrame(raf);
      if (ctl.stackEl === el) ctl.stackEl = null;
    };
  }, [ctl]);

  // ---- Posle svakog crtanja: novi redovi ulaze, FLIP / bljesak / skrol, ručica, traka ----
  useLayoutEffect(() => {
    ctl.bsEl = bsRef.current;
    ctl.pruneRows();
    const keys = new Set<string>();
    for (const c of list) keys.add(ctl.keyOf(c.id));
    if (ctl.animateNext && !reduceMotion() && prevKeys.current.size && !ctl.rs) {
      for (const c of list) {
        const k = ctl.keyOf(c.id);
        if (prevKeys.current.has(k)) continue;
        const li = ctl.els.get(c.id);
        const box = li?.querySelector<HTMLElement>('.blk-box');
        if (!li || !box) continue;
        box.classList.add('is-entering');
        box.style.height = '0px';
        li.style.marginTop = '0px';
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            box.classList.remove('is-entering');
            box.style.height = '';
            li.style.marginTop = '';
          }),
        );
      }
    }
    ctl.animateNext = false;
    prevKeys.current = keys;
    ctl.runAfter();
    ctl.updatePill();
    ctl.updateBar();
  });

  // ---- Otvaranje danas: blok pre "sada" odmah ispod trake ----
  const scrolled = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (scrollKey == null || scrolled.current === scrollKey || ctl.cfg.now == null) return;
    scrolled.current = scrollKey;
    // Prazan dan nema blok pre "sada": ostaje na vrhu, pa se vide kartica dobrodošlice i "Nema plana za ovaj dan."
    if (!list.some((x) => x.kind === 'block')) return;
    const k = Math.max(0, inf.cur - 1);
    const c = list[k];
    const el = c && ctl.els.get(c.id);
    const bar = ctl.barEl;
    if (!el || !bar) return;
    window.scrollTo(0, Math.max(0, el.getBoundingClientRect().top + window.scrollY - ctl.stuckBarBottom() - 14));
    ctl.updateBar();
  });

  // ---- Redovi ----
  const hyp = d?.hyp ?? null;
  const hypSt = new Map<ItemId, { st: number; dur: number }>();
  if (hyp) {
    const hs = M.startsOf(hyp);
    hyp.forEach((x, k) => hypSt.set(x.id, { st: hs[k], dur: x.dur }));
  }
  const statusWord = (s: Parameters<StackController['statusWord']>[0]) => ctl.statusWord(s);
  const register = (id: ItemId, el: HTMLLIElement | null) => ctl.registerRow(id, el);
  const move = ctl.moveSt;
  const slotAt = new Map<number, number>();
  if (move && !ctl.preview) move.targets.forEach((x, n) => x.kind === 'seam' && slotAt.set(x.k, n));
  const locked = ctl.cfg.locked;
  const pastDay = ctl.cfg.pastDay && now == null;

  const rows: ReactNode[] = [];
  const pushSlot = (k: number) => {
    const n = slotAt.get(k);
    if (n == null || !move) return;
    const x = ctl.targetLabel(move.targets[n]);
    rows.push(
      <li key={`slot-${k}`} className="blk-slot">
        <button type="button" className="blk-slot-btn" data-t={n} aria-label={targetAria(t, x)}>
          <b>{x.label}</b>
          <span className="blk-slot-range">· {x.range}</span>
          <TargetNote t={t} x={x} />
        </button>
      </li>,
    );
  };
  // Prazan dan: "+" u slobodnom vremenu bi bio treći poziv za dodavanje (uz "+" u traci i traku "Nema plana").
  const emptyDay = !tpl && !list.some((x) => x.kind === 'block' && x.id !== ctl.ghostId);

  list.forEach((c, i) => {
    pushSlot(i);
    const base = inf.st[i];
    // Tokom prevlačenja blokovi pokazuju opseg iz rasporeda posle spuštanja; slobodno vreme ostaje kakvo jeste (u tom
    // rasporedu se praznine spajaju, pa bi dva reda pokazala isto vreme).
    const shown = c.kind === 'block' ? hypSt.get(c.id) : undefined;
    const st = shown ? shown.st : base;
    const dur = shown ? shown.dur : c.dur;
    const end = base + c.dur;
    const free = c.kind === 'free';
    let splitting: RowView['splitting'] = null;
    if (ctl.splitSt && ctl.splitSt.id === c.id) {
      const cuts = ctl.splitSt.cuts;
      const even = M.cuts15(c.dur, cuts.length + 1);
      splitting = { cuts, custom: !even || even.join() !== [...cuts].sort((a, b) => a - b).join() };
    }
    const trailing = free && i === list.length - 1;
    const started = !!A && base <= A.now;
    const past = !!A && end <= A.now;
    const isNow = !!A && base <= A.now && A.now < end;
    const ghost = c.id === ctl.ghostId;
    const tgt = move && free && !ctl.preview ? move.targets.find((x) => x.kind === 'free' && x.freeId === c.id) : undefined;
    // Slobodno vreme koje je prošlo (ili bilo koje na ranijem danu) je nisko i bez "+".
    const pastFree = free && (pastDay || past);
    const h = free
      ? tgt
        ? TARGET_H
        : pastFree
          ? FREE_PAST_H
          : FREE_H
      : (ctl.resizeHeight(c) ?? (splitting ? ctl.splitHeight(c.dur) : heightOf(c.dur)));
    const canRate = mode === 'day' && !free && started && !ghost;
    const status = c.kind === 'block' ? c.status : 'pending';
    const name = c.kind === 'block' ? c.title : '';
    const v: RowView = {
      c,
      key: ctl.keyOf(c.id),
      st,
      dur,
      h,
      trailing,
      started,
      past,
      pastFree,
      now: isNow,
      nowMin: isNow && A ? A.now : null,
      due: ctl.isDue(c, base),
      ghost,
      placeholder: ghost && !!ctl.nb && !ctl.nb.free && ctl.nb.name.trim() === '',
      selected: ctl.sel === c.id,
      over: !free && base >= M.frame.end,
      moving: !!move && move.id === c.id,
      inMove: !!move,
      target: tgt ? ctl.targetLabel(tgt) : null,
      inDrag: !!d && d.id !== c.id,
      check: canRate
        ? {
            status,
            label: status === 'pending' ? t('blocks.check.mark', { name }) : t('blocks.check.change', { name, status: ctl.statusWord(status) }),
            popup: status !== 'pending',
            open: ctl.ratePop === c.id,
          }
        : null,
      prog: isNow && !free && A ? Math.min(1, Math.max(0, (A.now - base) / c.dur)) : null,
      // "+" samo dok se ništa drugo ne radi (ni "Premesti", ni prevlačenje, ni list "Novi blok").
      canAdd: free && !pastFree && !ghost && !locked && !move && !d && !ctl.preview && !emptyDay && M.freeRoom(list, i, A) != null,
      canResize: !free && !ghost && !pastDay && !locked && M.canResize(list, i, A),
      canResizeStart: !free && !ghost && !pastDay && !locked && M.canResizeStart(list, i, A),
      noLift: pastDay || locked || !M.canLift(list, i, A),
      splitting,
      lifted: !!d && d.id === c.id,
      liftedLabel: d && d.id === c.id ? d.extra : null,
      liftedInto: d && d.id === c.id && d.mode === 'free' ? (d.push ? 'push' : 'free') : null,
      hole: !!d && d.hole,
      // Blok koji je počeo ostavlja svoju visinu (slobodno vreme); ostali samo čip.
      holeH: d ? (d.started ? d.H : d.CH) : 0,
      fixedHole: !!d && d.started,
      shift: d && d.mode === 'order' && d.id !== c.id ? ctl.shiftOf(d, i) : 0,
      shifting: !!d && d.id !== c.id,
      drop: !!d && d.mode === 'free' && d.target === c.id,
      dropPush: !!d && d.mode === 'free' && d.target === c.id && d.push,
      color: free ? 'transparent' : ctl.catColor(c.categoryId),
      showNote: mode === 'day',
      register,
    };
    rows.push(<BlockRow key={v.key} v={v} statusWord={statusWord} />);
  });
  pushSlot(list.length);

  const endMin = M.frame.start + M.total(list);
  const over = ctl.overflowing(list).map((c) => c.title);
  const det = ctl.detId != null ? ctl.items.find((x) => x.id === ctl.detId) : undefined;
  const detIdx = det ? M.idxOf(ctl.items, det.id) : -1;
  const dockOpen = !d && ctl.cur() != null;
  // Desktop (≥ 1000 px, domaćin dao mesto u desnoj koloni): list bloka je tamo, ne preko niza.
  const side = !!inspector && window.innerWidth >= 1000;
  ctl.dockInSide = side;
  const names = det && det.kind === 'block' ? ctl.knownNames().filter((n) => n.name !== det.title) : [];
  // Gornji red trake ("još 22m · sledeće Ručak") ne računa nov blok dok nije dodat (traka dana ga pokazuje).
  const barList = ctl.ghostId != null && ctl.preview ? ctl.items : list;
  const barInf = barList === list ? inf : M.info(barList, A);

  return (
    <>
      <section
        ref={bsRef}
        className={cx('blk-section', tpl && 'is-tpl', d && 'is-dragging', (ctl.rs || ctl.cutDrag) && 'is-live', move && 'is-moving')}
        aria-labelledby="blk-section-title"
      >
        <h2 className="sr-only" id="blk-section-title">
          {tpl ? t('blocks.list.tpl') : t('blocks.list.day')}
        </h2>
        <StackBar
          ctl={ctl}
          list={barList}
          st={barInf.st}
          cur={barInf.cur}
          strip={barList === list ? undefined : { list, st: inf.st }}
          title={title}
          dayLabel={dayLabel}
          carryOver={carryOver}
        />
        {notice}
        <ol ref={stackRef} className="blk-stack" aria-label={tpl ? t('blocks.list.tpl') : t('blocks.list.day')}>
          {rows}
          <li className={cx('blk-end', over.length > 0 && 'is-over')} aria-hidden="true">
            <span>
              {t('blocks.endOfDay')} ·{' '}
              {endMin > M.frame.end ? t(tpl ? 'blocks.endNextDayTpl' : 'blocks.endNextDay', { time: fmtClock(endMin) }) : fmtClock(endMin)}
            </span>
          </li>
        </ol>
        {over.length > 0 && (
          <p className="blk-over-note" role="status">
            {/* Šablon se ne čuva dok blok počinje posle kraja dana (server bi ga prebacio na početak dana). */}
            {t(tpl ? 'blocks.overTpl' : 'blocks.over', { names: over.join(', ') })}
          </p>
        )}
        {d?.slot && (
          <div className={cx('blk-drop-slot', d.slotUnder && 'is-under')} style={{ top: d.slot.top, height: d.slot.h }}>
            {/* Gde bi blok pao: opseg iz rasporeda posle spuštanja. */}
            {d.hyp && <span>{ctl.rangeIn(d.hyp, d.id)}</span>}
          </div>
        )}
        <span className="blk-rs-pill" ref={(el) => void (ctl.pillEl = el)} hidden>
          <span className="t" />
          <span className="d" />
        </span>
        <RatePopover ctl={ctl} />
        {dockOpen && !side && <ActionBar ctl={ctl} />}
      </section>
      {side &&
        inspector &&
        createPortal(dockOpen ? <ActionBar ctl={ctl} /> : <p className="blk-inspector-idle">{t('blocks.inspector.idle')}</p>, inspector)}
      {ctl.msg && !dockOpen && (
        <div className="blk-toaster">
          <MsgRow ctl={ctl} msg={ctl.msg} className="blk-toast" />
        </div>
      )}
      <div className="sr-only" aria-live="polite" ref={(el) => void (ctl.liveEl = el)} />
      <div className="blk-as-ind" aria-hidden="true" ref={(el) => void (ctl.asIndEl = el)}>
        <Icon name="chevron-up" size={18} className="blk-as-up" />
        <Icon name="chevron-down" size={18} className="blk-as-down" />
      </div>
      {ctl.nb && <NewBlockSheet ctl={ctl} categories={categories} />}
      {det && det.kind === 'block' && (
        <DetailsSheet
          key={String(det.id)}
          block={det}
          range={ctl.rangeIn(ctl.items, det.id)}
          started={!!A && M.startsOf(ctl.items)[detIdx] <= A.now && mode === 'day'}
          withNote={mode === 'day'}
          categories={det.categoryId != null && !categories.some((c) => c.id === det.categoryId) && ctl.cfg.catMap.get(det.categoryId) ? [...categories, ctl.cfg.catMap.get(det.categoryId)!] : categories}
          names={names.slice(0, 10)}
          catColor={(id) => ctl.catColor(id)}
          focusName={ctl.detFocusName}
          onSave={(p) => ctl.saveDetails(det.id, p)}
          onDelete={() => ctl.deleteFromDetails(det.id)}
          onClose={() => ctl.closeDetails()}
        />
      )}
    </>
  );
}

/** Kartica "Tastatura" (desktop sa mišem): prečice niza blokova (šablon nema ocene). */
export function KeysCard({ mode = 'day' }: { mode?: 'day' | 'template' }) {
  const t = useT();
  const rows: Array<[string, string]> = [
    ['Tab / ↑↓', t('blocks.keys.go')],
    ['Enter', t('blocks.keys.select')],
    ['Alt+↑↓', t('blocks.keys.move')],
    ['Shift+↑↓', t('blocks.keys.length')],
    ['S', t('blocks.keys.split')],
    ['M', t('blocks.keys.moveTo')],
    ...(mode === 'day' ? [['1 2 3', t('blocks.keys.rate')] as [string, string]] : []),
    ['N', t('blocks.keys.new')],
    ['Del', t('blocks.keys.delete')],
    ['Ctrl+Z', t('blocks.keys.undo')],
  ];
  return (
    <section className="card blk-keys" aria-labelledby="blk-keys-title">
      <h2 className="card-title" id="blk-keys-title">
        {t('blocks.keys.title')}
      </h2>
      <dl>
        {rows.map(([k, v]) => (
          <div key={k} className="blk-keys-row">
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
