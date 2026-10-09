// Stanje i ponašanje niza blokova (Danas i šablon): izbor, traka akcija, deljenje, premeštanje, trajanje,
// dodavanje, brisanje, poništavanje, prevlačenje (dodir: držanje 420 ms; miš: posle 5 px) i tastatura.
// Prenos prototipa (cubes-final/dev/app.js) nad modelom iz shared/blockStack.ts.
//
// React (BlockStack.tsx) crta sve iz ovog stanja (useSyncExternalStore nad `version`). Tokom prevlačenja se
// po kadru menjaju samo `--dy` podignutog bloka i automatski skrol (direktno u DOM-u); React se ponovo crta
// samo kad se promeni mesto na koje bi blok pao.
//
// Domaćin (DayPage / uređivač šablona) dobija svaku izmenu kroz `cfg.onCommit` i čuva je (PUT / PATCH), a
// stanje sa servera vraća kroz `replace` i `remap`.

import type { BlockStatus, Category } from '../../../../shared/types.ts';
import { fmtClock, fmtDuration } from '../../../../shared/time.ts';
import { blockCounts } from '../../../../shared/summary.ts';
import {
  createBlockStack,
  emptyHistory,
  historyRecord,
  historyRedo,
  historyUndo,
  makeBlock,
  makeFree,
  newItemId,
  type Anchor,
  type BlockFields,
  type BlockStackModel,
  type Frame,
  type History,
  type InsertSpec,
  type ItemId,
  type MoveTarget,
  type StackBlock,
  type StackItem,
  type StackSnapshot,
} from '../../../../shared/blockStack.ts';
import type { Lang, TFunction } from '../../i18n/index.ts';
import {
  CHIP_H,
  LONG_PRESS_MS,
  MOUSE_SLOP,
  ROW_GAP,
  STEP_PX,
  TABBAR_H,
  TOUCH_SLOP,
  clamp,
  fold,
  fmtRange,
  heightOf,
  isPhoneWidth,
  markBlockGesture,
  reduceMotion,
  splitHeightOf,
  vibrate,
} from './geometry.ts';

export type StackMode = 'day' | 'template';
export type CommitKind = 'edit' | 'rate' | 'undo' | 'redo';

export interface CommitEvent {
  items: StackItem[];
  kind: CommitKind;
  /** Ocena (✓ ◐ ✕) jednog bloka: domaćin je šalje odmah (PATCH) ako blok postoji na serveru. */
  rateId?: ItemId;
}

export interface StackConfig {
  mode: StackMode;
  /** Logički minut "sada" (danas, ili zadržano juče); null = budući dan ili šablon. */
  now: number | null;
  /** Raniji dan: sve je prošlost (ocene, deljenje, detalji i brisanje rade; ništa se ne pomera). */
  pastDay: boolean;
  /** Raspored se ne sme menjati (blokovi u podacima se preklapaju dok korisnik ne potvrdi "Popravi"). */
  locked: boolean;
  catMap: Map<number, Category>;
  t: TFunction;
  lang: Lang;
  /** Nazivi blokova iz šablona (predlozi pri dodavanju i preimenovanju), uz nazive iz samog niza. */
  extraNames: ReadonlyArray<{ title: string; categoryId: number | null }>;
  onCommit: (e: CommitEvent) => void;
  /** Samo dok je raspored zaključan: izmena polja bloka sa servera (PATCH) umesto celog rasporeda. */
  onPatchFields?: (id: ItemId, fields: BlockFields) => void;
}

export interface Msg {
  text: string;
  undo: boolean;
  actions: Array<{ label: string; fn: () => void }>;
  /** Stavka na koju se poruka odnosi (fokus posle Poništi / ×). */
  target?: ItemId;
}

interface Rect {
  top: number;
  h: number;
  mid: number;
  bottom: number;
}

export interface DragState {
  id: ItemId;
  from: number;
  c: StackItem;
  started: boolean;
  ff: number;
  rects: Rect[];
  el: HTMLElement;
  box: HTMLElement;
  H: number;
  CH: number;
  grab: number;
  top0: number;
  shift: number;
  mode: 'none' | 'order' | 'free';
  to: number;
  k: number;
  target: ItemId | null;
  off: number;
  key: string;
  enterShift: number;
  /** Raspored koji bi nastao spuštanjem (vremena u gutteru i opsezi se crtaju po njemu). */
  hyp: StackItem[] | null;
  extra: string | null;
  slot: { top: number; h: number; push: boolean } | null;
  hole: boolean;
}

interface Pending {
  id: ItemId;
  pointerId: number;
  type: string;
  x0: number;
  y0: number;
  lift: boolean;
  armed: boolean;
  timer: number;
}

interface ResizeState {
  id: ItemId;
  base: StackItem[];
  d0: number;
  st: number;
  y0: number;
  s0: number;
  cur: number;
  h0: number;
  min: number;
  /**
   * Automatski skrol tokom ovog poteza (px, ± najviše RS_AUTO_MAX_PX) i vreme poslednjeg koraka — samo uz miš (prst
   * nad trakom akcija bi produžavao blok satima).
   */
  auto: number;
  autoAt: number;
}

/** Ručica + miš na ivici vidljivog dela: jedan korak (15 min) na ovoliko ms… */
const RS_AUTO_MS = 190;
/** …najviše ±2h po potezu. */
const RS_AUTO_MAX_PX = 8 * STEP_PX;

export interface NewBlockState {
  spec: InsertSpec;
  id: string;
  name: string;
  cat: number | null;
  catTouched: boolean;
  dur: number;
  free: boolean;
  err: boolean;
  where: string;
  effect: string;
  effectCls: '' | 'is-moves' | 'is-over';
  canCloseGap: boolean;
}

export interface KnownName {
  name: string;
  cat: number | null;
  n: number;
}

export interface DockAction {
  act: 'split' | 'move' | 'endnow' | 'shorter' | 'longer' | 'delete' | 'details';
  icon: 'split' | 'move' | 'end-now' | 'shorter' | 'longer' | 'trash' | 'more';
  cls?: string;
  disabled?: boolean;
}

interface CommitOpts {
  trusted?: boolean;
  /** Menja samo polja bloka (ocena, naziv, detalji): dozvoljeno i dok je raspored zaključan. */
  fieldsOnly?: boolean;
  target?: ItemId;
  coalesce?: string;
  keepFam?: boolean;
  select?: ItemId | null;
  first?: Map<ItemId, number> | null;
  msg?: string;
  quietOthers?: boolean;
  actions?: Msg['actions'];
  say?: string;
  kind?: CommitKind;
  rateId?: ItemId;
}

const orderKey = (l: readonly StackItem[], keep: Set<ItemId>) =>
  l
    .filter((c) => keep.has(c.id))
    .map((c) => String(c.id))
    .join(',');

function orderChanged(a: readonly StackItem[], b: readonly StackItem[]): boolean {
  const sa = new Set(a.map((c) => c.id));
  const common = new Set(b.filter((c) => sa.has(c.id)).map((c) => c.id));
  return orderKey(a, common) !== orderKey(b, common);
}

const isActive = (s: BlockStatus) => s === 'done' || s === 'partial';

/** Naziv bloka u poruci: najviše ~26 znakova. */
const msgName = (s: string) => (s.length > 28 ? `${s.slice(0, 26).trimEnd()}…` : s);

export class StackController {
  cfg: StackConfig;
  M: BlockStackModel;
  items: StackItem[] = [];
  hist: History<StackSnapshot> = emptyHistory();
  sel: ItemId | null = null;
  selByTap = false;
  selAt = 0;
  splitSt: { id: ItemId; cuts: number[] } | null = null;
  splitFam: { orig: StackItem[]; origId: ItemId; n: number; ids: ItemId[] } | null = null;
  moveSt: { id: ItemId; targets: MoveTarget[] } | null = null;
  renaming = false;
  preview: StackItem[] | null = null;
  ghostId: ItemId | null = null;
  drag: DragState | null = null;
  rs: ResizeState | null = null;
  cutDrag: { k: number } | null = null;
  pend: Pending | null = null;
  suppressClick = false;
  msg: Msg | null = null;
  nb: NewBlockState | null = null;
  detId: ItemId | null = null;
  /** Stanje čuvanja (domaćin): prikazuje se u traci. */
  saveState: 'idle' | 'saving' | 'saved' = 'idle';
  /** Animiraj nove redove i promene u sledećem crtanju (samo posle izmene korisnika, ne posle učitavanja). */
  animateNext = false;

  // DOM (upisuje BlockStack)
  els = new Map<ItemId, HTMLLIElement>();
  stackEl: HTMLElement | null = null;
  barEl: HTMLElement | null = null;
  dockEl: HTMLElement | null = null;
  bsEl: HTMLElement | null = null;
  asIndEl: HTMLElement | null = null;
  pillEl: HTMLElement | null = null;
  liveEl: HTMLElement | null = null;
  mapViewEl: HTMLElement | null = null;
  mapEl: HTMLElement | null = null;
  /** Telefon, uređivač rezova: najveća visina bloka koja staje između trake i trake akcija (null = bez ograničenja). */
  splitCap: number | null = null;

  /** Stabilan ključ reda (React key) i kad blok dobije id sa servera ('n5' → 130). */
  private keys = new Map<ItemId, string>();
  private version = 0;
  private listeners = new Set<() => void>();
  private afterQueue: Array<() => void> = [];
  private afterRaf = 0;
  private msgTimer = 0;
  private sayTimer = 0;
  private raf = 0;
  private lastY = 0;

  constructor(cfg: StackConfig, items: StackItem[], frame: Frame | number) {
    this.cfg = cfg;
    this.M = createBlockStack(frame);
    this.items = items;
  }

  // ======================= Pretplata (React) =======================

  subscribe = (l: () => void) => {
    this.listeners.add(l);
    return () => {
      this.listeners.delete(l);
    };
  };

  getVersion = () => this.version;

  emit() {
    this.version += 1;
    this.listeners.forEach((l) => l());
  }

  /** Posle sledećeg crtanja (FLIP, bljesak, skrol do bloka, fokus). */
  after(fn: () => void) {
    this.afterQueue.push(fn);
    if (!this.afterRaf) this.afterRaf = requestAnimationFrame(() => this.runAfter());
  }

  runAfter() {
    if (this.afterRaf) cancelAnimationFrame(this.afterRaf);
    this.afterRaf = 0;
    const q = this.afterQueue;
    this.afterQueue = [];
    q.forEach((fn) => fn());
  }

  keyOf(id: ItemId): string {
    return this.keys.get(id) ?? String(id);
  }

  private rowIds = new WeakMap<Element, ItemId>();

  registerRow(id: ItemId, el: HTMLLIElement | null) {
    if (!el) return;
    if (this.els.get(id) !== el) {
      for (const [k, e] of this.els) if (e === el && k !== id) this.els.delete(k);
      this.els.set(id, el);
    }
    this.rowIds.set(el, id);
  }

  /** Posle crtanja: izbaci redove kojih više nema u DOM-u. */
  pruneRows() {
    for (const [k, e] of this.els) if (!e.isConnected) this.els.delete(k);
  }

  dispose() {
    window.clearTimeout(this.msgTimer);
    window.clearTimeout(this.sayTimer);
    cancelAnimationFrame(this.raf);
    if (this.afterRaf) cancelAnimationFrame(this.afterRaf);
    this.clearPend();
    this.unlistenMoves();
  }

  // ======================= Domaćin =======================

  get t(): TFunction {
    return this.cfg.t;
  }

  /** Nešto je u toku (gest, sheet): stanje sa servera tada čeka. */
  isBusy(): boolean {
    return !!(this.drag || this.rs || this.cutDrag || this.pend || this.nb || this.detId != null || this.preview);
  }

  /** Nov niz sa servera (učitavanje, izmena sa drugog uređaja, vraćanje posle greške). */
  replace(items: StackItem[], frame: Frame, opts: { resetHistory?: boolean; silent?: boolean } = {}) {
    if (frame.start !== this.M.frame.start || frame.end !== this.M.frame.end) this.M = createBlockStack(frame);
    this.items = items;
    if (opts.resetHistory) this.hist = emptyHistory();
    const has = (id: ItemId | null | undefined) => id != null && items.some((c) => c.id === id && c.kind === 'block');
    if (!has(this.sel)) this.sel = null;
    if (this.splitSt && !has(this.splitSt.id)) this.splitSt = null;
    if (this.splitFam && (opts.resetHistory || !this.splitFam.ids.every(has))) this.splitFam = null;
    if (this.moveSt) this.moveSt = has(this.moveSt.id) ? { id: this.moveSt.id, targets: this.M.moveTargets(items, this.moveSt.id, this.anch()) } : null;
    if (this.renaming && !has(this.sel)) this.renaming = false;
    this.animateNext = false;
    // Tokom crtanja domaćina: BlockStack se crta posle njega i čita novo stanje (bez obaveštavanja).
    if (opts.silent) this.version += 1;
    else this.emit();
  }

  /** Drugi dan na ekranu: ništa od prethodnog dana ne ostaje (izbor, režimi, sheet-ovi, istorija, poruka). */
  resetForDay() {
    if (this.drag) this.endDragVisual(this.drag);
    this.drag = null;
    this.rs = null;
    this.cutDrag = null;
    this.clearPend();
    this.unlistenMoves();
    this.preview = null;
    this.ghostId = null;
    this.nb = null;
    this.detId = null;
    this.sel = null;
    this.cancelTransient();
    this.hist = emptyHistory();
    window.clearTimeout(this.msgTimer);
    this.msg = null;
    this.version += 1;
  }

  /** Trenutni raspored postaje izmena (npr. "Popravi" preklapanja): jedan korak istorije, domaćin ga čuva. */
  commitAll() {
    this.commit([...this.items], { trusted: true });
  }

  /** Klijentski id-jevi su dobili id sa servera (odgovor PUT-a): isti redovi, isti izbor, ista istorija. */
  remap(map: Map<ItemId, ItemId>) {
    if (map.size === 0) return;
    const cache = new Map<readonly StackItem[], StackItem[]>();
    const id = (x: ItemId) => map.get(x) ?? x;
    const list = (l: readonly StackItem[]): StackItem[] => {
      let out = cache.get(l);
      if (!out) {
        out = l.map((c) => (map.has(c.id) ? { ...c, id: map.get(c.id)! } : c));
        cache.set(l, out);
      }
      return out;
    };
    const snap = (s: StackSnapshot): StackSnapshot => ({ items: list(s.items), sel: s.sel == null ? null : id(s.sel) });
    for (const [from, to] of map) {
      this.keys.set(to, this.keyOf(from));
      const el = this.els.get(from);
      if (el) {
        this.els.delete(from);
        this.els.set(to, el);
      }
    }
    this.items = list(this.items);
    this.hist = {
      past: this.hist.past.map((e) => ({ ...e, snap: snap(e.snap) })),
      future: this.hist.future.map((e) => ({ ...e, snap: snap(e.snap) })),
    };
    if (this.sel != null) this.sel = id(this.sel);
    if (this.splitSt) this.splitSt = { ...this.splitSt, id: id(this.splitSt.id) };
    if (this.splitFam)
      this.splitFam = { ...this.splitFam, orig: list(this.splitFam.orig), origId: id(this.splitFam.origId), ids: this.splitFam.ids.map(id) };
    if (this.moveSt) this.moveSt = { id: id(this.moveSt.id), targets: this.M.moveTargets(this.items, id(this.moveSt.id), this.anch()) };
    if (this.detId != null) this.detId = id(this.detId);
    // Odgovor može da stigne usred gesta (držanje, prevlačenje, ručica): gest nastavlja sa novim id-jevima.
    if (this.pend) this.pend.id = id(this.pend.id);
    const d = this.drag;
    if (d) {
      d.id = id(d.id);
      if (map.has(d.c.id)) d.c = { ...d.c, id: map.get(d.c.id)! };
      if (d.target != null) d.target = id(d.target);
      if (d.hyp) d.hyp = list(d.hyp);
    }
    if (this.rs) this.rs = { ...this.rs, id: id(this.rs.id), base: list(this.rs.base) };
    if (this.preview) this.preview = list(this.preview);
    this.emit();
  }

  setSaveState(s: 'idle' | 'saving' | 'saved') {
    if (s === this.saveState) return;
    this.saveState = s;
    this.emit();
  }

  // ======================= Pomoćne =======================

  anch(): Anchor | null {
    const { mode, now, pastDay } = this.cfg;
    if (mode !== 'day') return null;
    if (now != null) return this.M.anchor(now);
    return pastDay ? { now: Infinity, nows: Infinity } : null;
  }

  /** Sidro za mesto novog bloka: raniji dan dozvoljava slobodno vreme (ništa se ne pomera). */
  private insA(): Anchor | null {
    return this.cfg.pastDay && this.cfg.now == null ? null : this.anch();
  }

  get list(): StackItem[] {
    return this.preview ?? this.items;
  }

  catColor(id: number | null): string {
    return (id != null && this.cfg.catMap.get(id)?.color) || '#9a9890';
  }

  counts(c: StackItem): boolean {
    return c.kind === 'block' && blockCounts({ categoryId: c.categoryId }, this.cfg.catMap);
  }

  /** Prošao je, a nije ocenjen (samo danas i zadržano juče). */
  isDue(c: StackItem, st: number): boolean {
    const now = this.cfg.now;
    return this.cfg.mode === 'day' && now != null && c.kind === 'block' && c.status === 'pending' && st + c.dur <= now && this.counts(c) && c.id !== this.ghostId;
  }

  statusWord(s: BlockStatus): string {
    const t = this.t;
    return s === 'pending' ? t('status.pendingHint') : s === 'done' ? t('status.done') : s === 'partial' ? t('status.partial') : t('status.skipped');
  }

  cur(): StackBlock | null {
    const c = this.items.find((x) => x.id === this.sel);
    return c && c.kind === 'block' ? c : null;
  }

  rangeIn(list: readonly StackItem[], id: ItemId): string {
    const i = this.M.idxOf(list, id);
    if (i < 0) return '';
    const st = this.M.startsOf(list)[i];
    return fmtRange(st, st + list[i].dur);
  }

  /** Raspored je zaključan (preklapanja): šta i dalje radi (šablon nema ocene). */
  private lockedMsg(): string {
    return this.t(this.cfg.mode === 'template' ? 'blocks.overlap.lockedTpl' : 'blocks.overlap.locked');
  }

  /** Naziv u poruci (dugačak se skraćuje: poruka u traci akcija ima dva reda, a opseg i "N pomereno" su bitniji). */
  private nameOf(c: StackItem): string {
    return c.kind === 'free' ? this.t('blocks.freeTime') : msgName(c.title);
  }

  private overNames(l: readonly StackItem[]): string[] {
    return this.M.overflowing(l).map((c) => c.title);
  }

  /** Korisnikovi nazivi blokova (iz ovog niza i šablona), po učestalosti. */
  knownNames(): KnownName[] {
    const m = new Map<string, KnownName>();
    const add = (name: string, cat: number | null) => {
      if (!name.trim()) return;
      const k = fold(name);
      const e = m.get(k) ?? { name, cat, n: 0 };
      e.n += 1;
      m.set(k, e);
    };
    for (const c of this.items) if (c.kind === 'block' && c.id !== this.ghostId) add(c.title, c.categoryId);
    for (const b of this.cfg.extraNames) add(b.title, b.categoryId);
    return [...m.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name, this.cfg.lang));
  }

  // ======================= Poruke, najave, bljesak =======================

  /** Poruka (u traci akcija ili iznad donje trake); čitač ekrana je čuje kroz stalni aria-live region. */
  message(text: string, o: { undo?: boolean; actions?: Msg['actions']; target?: ItemId } = {}) {
    this.msg = { text, undo: !!o.undo, actions: o.actions ?? [], target: o.target };
    window.clearTimeout(this.msgTimer);
    this.msgTimer = window.setTimeout(() => this.closeMsg(), this.msg.actions.length ? 7000 : 4500);
    this.emit();
    this.say(text);
  }

  /** Stavka koja sada pokriva minut `m` (posle izmene koja je uklonila stavku na koju se poruka odnosila). */
  private itemAt(m: number): StackItem | null {
    const st = this.M.startsOf(this.items);
    return this.items.find((c, i) => st[i] <= m && m < st[i] + c.dur) ?? null;
  }

  /** Gde ide fokus posle poruke: izabran blok, stavka iz poruke ili ono što je sada na njenom mestu. */
  private msgFocus(m: Msg, at: number | null): ItemId | null {
    if (this.sel != null) return this.sel;
    if (m.target != null && this.items.some((c) => c.id === m.target)) return m.target;
    return at != null ? (this.itemAt(at)?.id ?? null) : null;
  }

  /** "Poništi" u poruci: fokus ostaje u nizu (izabran blok ili stavka na koju se poruka odnosila). */
  undoFromMsg(m: Msg) {
    const at = m.target != null ? this.M.startOf(this.items, m.target) : null;
    this.closeMsg();
    this.undo();
    this.focusRow(this.msgFocus(m, at));
  }

  /** × u poruci: fokus (ako je bio u poruci) ide na blok, ne na <body>. */
  dismissMsg(m: Msg, hadFocus: boolean) {
    const at = m.target != null ? this.M.startOf(this.items, m.target) : null;
    this.closeMsg();
    if (hadFocus) this.focusRow(this.msgFocus(m, at));
  }

  closeMsg() {
    window.clearTimeout(this.msgTimer);
    if (!this.msg) return;
    this.msg = null;
    this.emit();
  }

  /** Najava za čitače ekrana (aria-live). */
  say(text: string) {
    window.clearTimeout(this.sayTimer);
    const el = this.liveEl;
    if (!el) return;
    el.textContent = '';
    this.sayTimer = window.setTimeout(() => {
      el.textContent = text;
    }, 50);
  }

  boxOf(id: ItemId): HTMLElement | null {
    return (this.els.get(id)?.querySelector('.blk-box') as HTMLElement | null) ?? null;
  }

  flash(id: ItemId, cls: 'is-flash' | 'is-shifted' | 'is-shake' = 'is-flash') {
    this.after(() => {
      const box = this.boxOf(id);
      if (!box) return;
      box.classList.remove(cls);
      void box.offsetWidth;
      box.classList.add(cls);
      window.setTimeout(() => box.classList.remove(cls), 950);
    });
  }

  shake(id: ItemId) {
    this.flash(id, 'is-shake');
    vibrate([6, 40, 6]);
  }

  focusRow(id: ItemId | null) {
    if (id == null) return;
    this.after(() => (this.els.get(id)?.querySelector('.blk-main') as HTMLElement | null)?.focus({ preventScroll: true }));
  }

  /** Fokus na prvu oznaku reza (uređivač rezova; strelice je pomeraju). */
  private focusCut() {
    this.after(() => this.stackEl?.querySelector<HTMLElement>('.cut-drag')?.focus({ preventScroll: true }));
  }

  // ======================= FLIP i skrol =======================

  measure(): Map<ItemId, number> {
    const m = new Map<ItemId, number>();
    for (const [id, el] of this.els) if (el.isConnected) m.set(id, el.getBoundingClientRect().top);
    return m;
  }

  flip(first: Map<ItemId, number> | null) {
    if (reduceMotion() || !first) return;
    const moved: HTMLElement[] = [];
    for (const [id, el] of this.els) {
      const f = first.get(id);
      if (f == null || !el.isConnected) continue;
      const dy = f - el.getBoundingClientRect().top;
      if (Math.abs(dy) < 0.5) continue;
      el.style.transition = 'none';
      el.style.transform = `translateY(${dy}px)`;
      moved.push(el);
    }
    if (!moved.length) return;
    void document.body.offsetHeight;
    for (const el of moved) {
      el.style.transition = 'transform 180ms var(--ease)';
      el.style.transform = '';
    }
    window.setTimeout(() => moved.forEach((el) => (el.style.transition = '')), 230);
  }

  /**
   * Granice vidljivog dela niza: ispod trake, iznad trake akcija (telefon: iznad donje trake; desktop: zalepljena na
   * dnu kolone — njen vrh nikad nije iznad redova koje pokriva) ili iznad donje trake.
   */
  band(): { top: number; bottom: number } {
    const top = Math.max(0, this.barEl?.getBoundingClientRect().bottom ?? 0);
    const dock = this.dockEl?.isConnected ? this.dockEl : null;
    const floor = window.innerHeight - (isPhoneWidth() ? TABBAR_H : 0);
    const bottom = dock ? Math.min(dock.getBoundingClientRect().top, floor) : floor;
    return { top, bottom };
  }

  /** Donja ivica trake kad je zalepljena (ispod trake "Nema interneta", --offline-h). */
  stuckBarBottom(): number {
    const off = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--offline-h')) || 0;
    return off + (this.barEl?.offsetHeight ?? 0);
  }

  /** Skrol (odmah) tako da je element ceo u vidljivom delu niza — umesto scrollIntoView, koji ne zna za trake. */
  revealEl(el: Element | null | undefined) {
    if (!el) return;
    const r = el.getBoundingClientRect();
    const b = this.band();
    const top = b.top + 8;
    const bottom = b.bottom - 8;
    let dy = 0;
    if (r.bottom > bottom) dy = Math.min(r.bottom - bottom, r.top - top);
    else if (r.top < top) dy = r.top - top;
    if (dy) window.scrollBy(0, dy);
  }

  /** Fokus na element u nizu (strelice) i skrol do njega u vidljivom delu. */
  private focusEl(el: HTMLElement | null | undefined) {
    if (!el) return;
    el.focus({ preventScroll: true });
    this.revealEl(el);
  }

  reveal(id: ItemId, center = false) {
    this.after(() =>
      requestAnimationFrame(() => {
        const box = this.boxOf(id);
        if (!box) return;
        const r = box.getBoundingClientRect();
        const b = this.band();
        const topLimit = b.top + 10;
        const bottomLimit = b.bottom - 30;
        let dy = 0;
        if (center) {
          const h = Math.min(r.height, bottomLimit - topLimit);
          dy = r.top - (topLimit + (bottomLimit - topLimit - h) / 2);
          if (Math.abs(dy) < 30) dy = 0;
        } else if (r.bottom > bottomLimit) dy = Math.min(r.bottom - bottomLimit, r.top - topLimit);
        else if (r.top < topLimit) dy = r.top - topLimit;
        if (dy) window.scrollBy({ top: dy, behavior: reduceMotion() ? 'auto' : 'smooth' });
      }),
    );
  }

  /** Geometrija redova u koordinatama dokumenta (mapa dana, skok na vreme). */
  rowsGeo(): Array<{ s: number; e: number; top: number; h: number }> {
    const list = this.list;
    const st = this.M.startsOf(list);
    return list.map((c, i) => {
      const box = this.boxOf(c.id);
      const r = box ? box.getBoundingClientRect() : { top: 0, height: 0 };
      return { s: st[i], e: st[i] + c.dur, top: r.top + window.scrollY, h: r.height };
    });
  }

  yToTime(g: ReturnType<StackController['rowsGeo']>, y: number): number {
    for (const r of g) {
      if (y < r.top) return r.s;
      if (y <= r.top + r.h) return r.s + ((y - r.top) / Math.max(1, r.h)) * (r.e - r.s);
    }
    return g.length ? g[g.length - 1].e : this.M.frame.start;
  }

  timeToY(g: ReturnType<StackController['rowsGeo']>, m: number): number {
    for (const r of g) if (m < r.e) return r.top + (Math.max(0, m - r.s) / (r.e - r.s)) * r.h;
    const l = g[g.length - 1];
    return l ? l.top + l.h : 0;
  }

  scrollToTime(m: number, smooth: boolean) {
    const g = this.rowsGeo();
    const b = this.band();
    const y = this.timeToY(g, m);
    window.scrollTo({ top: Math.max(0, y - b.top - (b.bottom - b.top) * 0.25), behavior: smooth && !reduceMotion() ? 'smooth' : 'auto' });
  }

  /** Okvir vidljivog dela dana na mapi i linija ispod trake kad je zalepljena. */
  updateMapView() {
    const v = this.mapViewEl;
    if (v && this.els.size) {
      const g = this.rowsGeo();
      const b = this.band();
      const { start, end } = this.M.frame;
      const pct = (m: number) => clamp(((m - start) / this.M.LEN) * 100, 0, 100);
      const t0 = this.yToTime(g, b.top + window.scrollY);
      const t1 = this.yToTime(g, b.bottom + window.scrollY);
      v.style.left = `${pct(t0)}%`;
      v.style.width = `${Math.max(1, pct(t1) - pct(t0))}%`;
      // Klizač mape: vreme od kog ←/→ skaču (četvrtina vidljivog dela), da čitač ekrana čuje promenu.
      const map = this.mapEl;
      if (map) {
        const m = clamp(Math.round(this.yToTime(g, b.top + window.scrollY + (b.bottom - b.top) * 0.25)), start, end);
        const now = String(m - start);
        if (map.getAttribute('aria-valuenow') !== now) {
          map.setAttribute('aria-valuenow', now);
          map.setAttribute('aria-valuetext', fmtClock(m));
        }
      }
    }
    const bar = this.barEl;
    if (bar) bar.classList.toggle('is-stuck', bar.getBoundingClientRect().top <= 0.5 && window.scrollY > 0);
  }

  // ======================= Izmene, istorija =======================

  commit(next: StackItem[] | null, o: CommitOpts = {}): boolean {
    if (!next) return false;
    const t = this.t;
    const prev = this.items;
    const A = this.anch();
    if (this.cfg.locked && !o.fieldsOnly) {
      if (o.target != null) this.shake(o.target);
      this.message(this.lockedMsg());
      return false;
    }
    if (A && !o.trusted && !this.M.pastOk(prev, next, A)) {
      if (o.target != null) this.shake(o.target);
      this.message(t('blocks.msg.past'));
      return false;
    }
    this.hist = historyRecord(this.hist, { items: prev, sel: this.sel }, { tag: o.coalesce ?? null, at: performance.now() });
    if (!o.keepFam) this.splitFam = null;
    this.moveSt = null;
    this.splitSt = null;
    this.renaming = false;
    const first = o.first ?? (orderChanged(prev, next) ? this.measure() : null);
    this.apply(next, o.select !== undefined ? o.select : this.sel, first);
    this.selByTap = false;
    const moved = this.M.movedBlocks(prev, next, o.target);
    moved.forEach((m) => this.flash(m.id, 'is-shifted'));
    if (o.msg) {
      let text = o.msg;
      if (moved.length && !o.quietOthers) text += ' · ' + t('blocks.msg.others', { n: moved.length });
      const was = new Set(this.overNames(prev));
      const nowOver = this.overNames(next).filter((n) => !was.has(n));
      if (nowOver.length) text += ' · ' + t('blocks.msg.overflow', { name: nowOver[0] });
      this.message(text, { undo: true, actions: o.actions, target: o.target });
    } else if (o.say) this.say(o.say);
    this.cfg.onCommit({ items: next, kind: o.kind ?? 'edit', rateId: o.rateId });
    return true;
  }

  private apply(list: StackItem[], newSel: ItemId | null, first: Map<ItemId, number> | null) {
    this.items = list;
    this.sel = newSel != null && list.some((c) => c.id === newSel && c.kind === 'block') ? newSel : null;
    if (this.splitSt && !list.some((c) => c.id === this.splitSt!.id)) this.splitSt = null;
    this.animateNext = true;
    if (first) this.after(() => this.flip(first));
    this.emit();
  }

  cancelTransient() {
    this.splitSt = null;
    this.splitFam = null;
    this.moveSt = null;
    this.renaming = false;
  }

  undo() {
    if (this.drag || this.rs) return;
    const r = historyUndo(this.hist, { items: this.items, sel: this.sel });
    if (!r) {
      this.message(this.t('blocks.msg.nothingToUndo'));
      return;
    }
    this.cancelTransient();
    const prev = this.items;
    const first = orderChanged(this.items, r.snap.items) ? this.measure() : null;
    this.hist = r.history;
    this.apply([...r.snap.items], r.snap.sel, first);
    this.selByTap = false;
    this.closeMsg();
    this.say(this.t('blocks.msg.undone'));
    this.emitHistory(prev, 'undo');
  }

  /**
   * Poništi / ponovi → domaćin. Dok je raspored zaključan (preklapanja) istorija ima samo ocene: svaka promenjena ocena
   * ide pojedinačno, nikad ceo raspored (on bi sačuvao raspored "Popravi" bez potvrde).
   */
  private emitHistory(prev: readonly StackItem[], kind: 'undo' | 'redo') {
    if (!this.cfg.locked) {
      this.cfg.onCommit({ items: this.items, kind });
      return;
    }
    const was = new Map(prev.map((c) => [c.id, c]));
    for (const c of this.items) {
      const p = was.get(c.id);
      if (c.kind === 'block' && p?.kind === 'block' && (p.status !== c.status || p.actualMin !== c.actualMin))
        this.cfg.onCommit({ items: this.items, kind: 'rate', rateId: c.id });
    }
  }

  redo() {
    if (this.drag || this.rs) return;
    const r = historyRedo(this.hist, { items: this.items, sel: this.sel });
    if (!r) return;
    this.cancelTransient();
    const prev = this.items;
    const first = orderChanged(this.items, r.snap.items) ? this.measure() : null;
    this.hist = r.history;
    this.apply([...r.snap.items], r.snap.sel, first);
    this.closeMsg();
    this.say(this.t('blocks.msg.redone'));
    this.emitHistory(prev, 'redo');
  }

  // ======================= Izbor =======================

  select(id: ItemId | null, o: { byTap?: boolean; reveal?: boolean } = {}) {
    if (this.splitSt && this.splitSt.id !== id) this.splitSt = null;
    if (this.splitFam && id != null && !this.splitFam.ids.includes(id)) this.splitFam = null;
    this.renaming = false;
    this.moveSt = null;
    this.sel = id;
    this.selByTap = !!o.byTap;
    this.selAt = performance.now();
    this.emit();
    if (id != null && o.reveal !== false) this.reveal(id);
  }

  deselect() {
    if (this.sel == null && !this.splitSt && !this.moveSt) return;
    this.sel = null;
    this.cancelTransient();
    this.emit();
  }

  /** × u traci akcija: traka se zatvara, fokus ostaje na bloku (ne pada na <body>). */
  closeDock() {
    const id = this.sel;
    this.deselect();
    this.focusRow(id);
  }

  // ======================= Akcije bloka =======================

  setStatus(id: ItemId, s: Exclude<BlockStatus, 'pending'>) {
    const c = this.items.find((x) => x.id === id);
    if (!c || c.kind !== 'block') return;
    const next = this.M.opRate(this.items, id, s);
    const status = c.status === s ? 'pending' : s;
    this.commit(next, {
      say: this.t('blocks.msg.status', { name: c.title, status: this.statusWord(status) }),
      keepFam: true,
      fieldsOnly: true,
      trusted: true,
      kind: 'rate',
      rateId: id,
    });
  }

  resizeTo(id: ItemId, dur: number, o: { coalesce?: string; ended?: boolean } = {}) {
    const c = this.items.find((x) => x.id === id);
    const next = this.M.opResize(this.items, id, dur);
    if (!next || !c) return;
    const name = this.nameOf(c);
    const range = this.rangeIn(next, id);
    const msg = (o.ended ? this.t('blocks.msg.ended', { name, range }) : this.t('blocks.msg.resized', { name, range })) + ' · ' + fmtDuration(dur);
    this.commit(next, { target: id, coalesce: o.coalesce, msg });
  }

  resizeBy(id: ItemId, delta: number) {
    const list = this.items;
    const A = this.anch();
    const i = this.M.idxOf(list, id);
    const c = list[i];
    if (!c) return;
    if (this.cfg.locked) {
      this.shake(id);
      this.message(this.lockedMsg());
      return;
    }
    if (!this.M.canResize(list, i, A) || this.cfg.pastDay) {
      this.shake(id);
      this.message(this.t('blocks.msg.past'));
      return;
    }
    const dur = this.M.stepDur(list, id, delta, A);
    if (dur == null || dur === c.dur) {
      if (delta < 0) {
        this.shake(id);
        this.message(this.t('blocks.msg.minLen'));
      }
      return;
    }
    if (c.kind === 'free') {
      const next = this.M.opResize(list, id, dur);
      if (next) this.commit(next, { target: id, coalesce: `len:${id}`, msg: `${this.t('blocks.freeTime')} ${this.rangeIn(next, id)}` });
      return;
    }
    this.resizeTo(id, dur, { coalesce: `len:${id}` });
  }

  endNow(id: ItemId) {
    const next = this.M.opEndNow(this.items, id, this.anch());
    if (!next) return;
    const i = this.M.idxOf(next, id);
    this.resizeTo(id, next[i].dur, { ended: true });
  }

  moveBy(id: ItemId, dir: -1 | 1) {
    const list = this.items;
    const i = this.M.idxOf(list, id);
    const c = list[i];
    if (!c) return;
    const A = this.anch();
    const next = this.cfg.pastDay ? null : this.M.opMoveBy(list, id, dir, A);
    if (!next) {
      this.shake(id);
      if (this.cfg.locked) this.message(this.lockedMsg());
      else if (this.cfg.pastDay || (A && i <= this.M.info(list, A).ff)) this.message(this.t('blocks.msg.past'));
      return;
    }
    if (this.commit(next, { target: id, select: c.kind === 'free' ? null : id, msg: this.t('blocks.msg.moved', { name: this.nameOf(c), range: this.rangeIn(next, id) }) }))
      this.reveal(id);
  }

  nudge(id: ItemId, dir: -1 | 1) {
    const next = this.cfg.pastDay ? null : this.M.opNudge(this.items, id, dir);
    if (!next) {
      this.message(dir < 0 ? this.t('blocks.msg.noFreeUp') : this.t('blocks.msg.noFreeDown'));
      return;
    }
    const c = this.items.find((x) => x.id === id)!;
    this.commit(next, { target: id, coalesce: `nudge:${id}`, msg: this.t('blocks.msg.moved', { name: this.nameOf(c), range: this.rangeIn(next, id) }) });
  }

  closable(id: ItemId): boolean {
    return !this.cfg.pastDay && !this.cfg.locked && this.M.opCloseGap(this.items, id, this.anch()) != null;
  }

  del(id: ItemId) {
    const c = this.items.find((x) => x.id === id);
    if (!c) return;
    if (c.kind === 'free') {
      this.closeGap(id);
      return;
    }
    const next = this.M.opDelete(this.items, id);
    if (!next) return;
    // Novo slobodno vreme se može spojiti sa susednim (i uzeti njegov id): nađi ono koje sada pokriva to vreme.
    const st0 = this.M.startOf(this.items, id) ?? 0;
    const holder = this.M.freeAt(next, st0);
    const after = holder && !this.cfg.pastDay && this.M.opCloseGap(next, holder.id, this.anch());
    if (
      this.commit(next, {
        select: null,
        target: id,
        trusted: true,
        msg: this.t('blocks.msg.deleted', { name: msgName(c.title) }),
        actions: after && holder ? [{ label: this.t('blocks.closeGap'), fn: () => this.closeGap(holder.id) }] : [],
      })
    )
      // Fokus na slobodno vreme koje je ostalo (traka akcija se zatvara, red je možda spojen sa susedom).
      this.focusRow(holder?.id ?? id);
  }

  closeGap(id: ItemId) {
    const list = this.items;
    const i = this.M.idxOf(list, id);
    if (i < 0 || this.cfg.pastDay) return;
    const next = this.M.opCloseGap(list, id, this.anch());
    if (!next) return;
    const before = this.M.startsOf(list);
    const nst = this.M.startsOf(next);
    const firstAfter = list.findIndex((c, k) => k > i && c.kind === 'block');
    const dt = firstAfter >= 0 ? before[firstAfter] - nst[this.M.idxOf(next, list[firstAfter].id)] : 0;
    const focus = firstAfter >= 0 ? list[firstAfter].id : null;
    if (this.commit(next, { target: id, quietOthers: true, msg: this.t('blocks.msg.gapClosed', { time: fmtDuration(dt) }) }))
      // Praznina je nestala (ili se skratila): fokus na prvi blok posle nje.
      this.focusRow(focus ?? (next.some((c) => c.id === id) ? id : null));
  }

  splitHalf(id: ItemId) {
    const c = this.items.find((x) => x.id === id);
    if (!c || c.kind !== 'block') return;
    const cuts = this.M.cuts15(c.dur, 2);
    const r = cuts && this.M.opSplit(this.items, id, cuts);
    if (!r) {
      this.shake(id);
      this.message(this.t('blocks.split.tooShort'));
      return;
    }
    const orig = this.items;
    this.splitFam = { orig, origId: id, n: 2, ids: r.ids };
    if (
      !this.commit(r.list, {
        trusted: true,
        select: r.ids[1],
        target: id,
        keepFam: true,
        say: this.t('blocks.msg.split', { n: 2, name: c.title }),
      })
    ) {
      this.splitFam = null;
      return;
    }
    this.closeMsg();
    r.ids.forEach((p) => this.flash(p));
    this.reveal(r.ids[1]);
  }

  resplit(n: number) {
    const f = this.splitFam;
    if (!f) return;
    const c = f.orig.find((x) => x.id === f.origId);
    const cuts = c && this.M.cuts15(c.dur, n);
    const top = this.hist.past[this.hist.past.length - 1];
    if (!c || c.kind !== 'block' || !cuts || top?.snap.items !== f.orig) return;
    const r = this.M.opSplit(f.orig, f.origId, cuts);
    if (!r) return;
    this.splitFam = { ...f, n, ids: r.ids };
    this.items = r.list;
    this.hist = { past: this.hist.past, future: [] };
    this.sel = r.ids[n - 1];
    this.selByTap = false;
    this.animateNext = true;
    this.emit();
    r.ids.forEach((p) => this.flash(p));
    this.say(this.t('blocks.msg.split', { n, name: c.title }));
    this.cfg.onCommit({ items: this.items, kind: 'edit' });
  }

  customCuts() {
    const f = this.splitFam;
    const top = this.hist.past[this.hist.past.length - 1];
    if (!f || top?.snap.items !== f.orig) {
      this.splitFam = null;
      this.emit();
      return;
    }
    this.hist = { past: this.hist.past.slice(0, -1), future: [] };
    this.items = f.orig;
    const c = f.orig.find((x) => x.id === f.origId)!;
    this.sel = f.origId;
    this.selByTap = false;
    this.splitFam = null;
    this.splitSt = { id: f.origId, cuts: this.M.cuts15(c.dur, f.n) ?? [] };
    this.closeMsg();
    this.animateNext = true;
    this.emit();
    this.fitSplit(f.origId);
    this.focusCut();
    this.cfg.onCommit({ items: this.items, kind: 'edit' });
  }

  startSplitEditor(id: ItemId) {
    if (this.cfg.locked) return;
    const c = this.items.find((x) => x.id === id);
    if (!c || c.kind !== 'block' || c.dur < 2 * this.M.MIN) return;
    this.renaming = false;
    this.moveSt = null;
    this.splitFam = null;
    this.closeMsg();
    this.splitSt = { id, cuts: this.M.cuts15(c.dur, 2) ?? [] };
    this.emit();
    this.fitSplit(id);
    this.focusCut();
  }

  /** Visina bloka u uređivaču rezova: clamp(2 × trajanje, 168, 400), na telefonu najviše koliko staje iznad trake. */
  splitHeight(dur: number): number {
    const h = splitHeightOf(dur);
    return this.splitCap != null ? Math.max(Math.min(h, this.splitCap), Math.min(h, 168)) : h;
  }

  /**
   * Uređivač rezova je otvoren: posle crtanja (traka akcija je tada viša) blok staje ceo između trake i trake akcija —
   * na telefonu se po potrebi i skrati — i vrh mu je odmah ispod trake. Visina se računa iz ciljne, ne iz izmerene
   * (blok se izdužuje animacijom).
   */
  private fitSplit(id: ItemId) {
    this.after(() => {
      const dock = this.dockEl?.isConnected ? this.dockEl : null;
      const c = this.items.find((x) => x.id === id);
      if (!c || !dock) return;
      const barBottom = this.stuckBarBottom();
      const dockTop = dock.getBoundingClientRect().top;
      const cap = isPhoneWidth() ? Math.max(0, Math.floor(dockTop - barBottom - 16)) : null;
      if (cap !== this.splitCap) {
        this.splitCap = cap;
        this.emit();
      }
      this.after(() => {
        const box = this.boxOf(id);
        if (!box || !this.splitSt) return;
        const r = box.getBoundingClientRect();
        const h = this.splitHeight(c.dur);
        const top = Math.max(0, this.barEl?.getBoundingClientRect().bottom ?? 0);
        const bottom = this.band().bottom;
        // Ceo blok je već vidljiv: ništa se ne pomera.
        if (r.top >= top + 8 && r.top + h <= bottom - 8) return;
        window.scrollBy({ top: r.top - (barBottom + 8), behavior: reduceMotion() ? 'auto' : 'smooth' });
      });
    });
  }

  setCuts(cuts: number[]) {
    if (!this.splitSt) return;
    this.splitSt = { ...this.splitSt, cuts };
    this.emit();
  }

  confirmSplit() {
    const s = this.splitSt;
    if (!s) return;
    const c = this.items.find((x) => x.id === s.id);
    const cuts = [...s.cuts].sort((a, b) => a - b);
    if (!c || c.kind !== 'block' || !cuts.length) return;
    const r = this.M.opSplit(this.items, c.id, cuts);
    if (!r) return;
    const n = r.ids.length;
    if (
      this.commit(r.list, {
        trusted: true,
        select: r.ids[n - 1],
        target: c.id,
        msg: this.t('blocks.msg.split', { n, name: msgName(c.title) }),
      })
    ) {
      r.ids.forEach((p) => this.flash(p));
      this.focusRow(r.ids[n - 1]);
    }
  }

  startMove(id: ItemId, viaKeys: boolean) {
    const targets = this.cfg.pastDay || this.cfg.locked ? [] : this.M.moveTargets(this.items, id, this.anch());
    if (!targets.length) {
      this.shake(id);
      this.message(this.cfg.locked ? this.lockedMsg() : this.t('blocks.move.none'));
      return;
    }
    const el = this.els.get(id);
    const y0 = el ? el.getBoundingClientRect().top : 0;
    this.splitSt = null;
    this.renaming = false;
    this.splitFam = null;
    this.closeMsg();
    this.moveSt = { id, targets };
    this.emit();
    this.after(() => {
      const e = this.els.get(id);
      if (e) {
        const y1 = e.getBoundingClientRect().top;
        if (Math.abs(y1 - y0) > 1) window.scrollBy(0, y1 - y0);
      }
      if (viaKeys) {
        const f = this.moveTargetEls();
        this.focusEl(f.find((b) => !!e && !!(e.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING)) ?? f[f.length - 1]);
      }
    });
  }

  moveTargetEls(): HTMLElement[] {
    return this.stackEl ? [...this.stackEl.querySelectorAll<HTMLElement>('.blk-slot-btn, .blk.is-target .blk-main')] : [];
  }

  cancelMove() {
    const id = this.moveSt?.id ?? null;
    this.moveSt = null;
    this.emit();
    this.focusRow(id);
  }

  placeAt(n: number) {
    const x = this.moveSt?.targets[n];
    if (!x || !this.moveSt) return;
    const id = this.moveSt.id;
    const c = this.items.find((y) => y.id === id);
    if (!c) return;
    const first = this.measure();
    const key = x.kind === 'free' ? 'blocks.msg.movedFree' : 'blocks.msg.moved';
    if (
      this.commit(x.next, {
        first,
        select: c.kind === 'free' ? null : id,
        target: id,
        msg: this.t(key, { name: this.nameOf(c), range: this.rangeIn(x.next, id) }),
      })
    ) {
      this.flash(id);
      this.reveal(id);
      // Mesto ("Ovde") je nestalo: fokus na premešten blok, ne na <body>.
      this.focusRow(id);
    }
  }

  startRename() {
    if (!this.cur()) return;
    this.renaming = true;
    this.closeMsg();
    this.emit();
  }

  cancelRename() {
    this.renaming = false;
    this.emit();
    this.focusRow(this.sel);
  }

  rename(id: ItemId, name: string, cat?: number | null) {
    const title = name.trim();
    this.renaming = false;
    const c = this.items.find((x) => x.id === id);
    if (!c || c.kind !== 'block' || !title || (title === c.title && (cat === undefined || cat === c.categoryId))) {
      this.emit();
      return;
    }
    const patch: BlockFields = { title };
    if (cat !== undefined) patch.categoryId = cat;
    if (this.cfg.locked) {
      this.cfg.onPatchFields?.(id, patch);
      this.emit();
      return;
    }
    this.commit(this.M.opUpdate(this.items, id, patch), { keepFam: true, fieldsOnly: true, trusted: true, msg: this.t('blocks.msg.renamed', { name: msgName(title) }) });
  }

  /** Akcije u traci za blok `i` (budući / tekući / prošao bez ocene / ocenjen / šablon). */
  dockActions(list: readonly StackItem[], i: number): { acts: DockAction[]; past: boolean } {
    const A = this.anch();
    const inf = this.M.info(list, A);
    const c = list[i];
    const past = !!A && inf.st[i] + c.dur <= A.now;
    const current = !!A && i === inf.cur;
    if (this.cfg.locked) return { acts: [{ act: 'details', icon: 'more' }], past };
    const acts: DockAction[] = [{ act: 'split', icon: 'split', disabled: c.dur < 2 * this.M.MIN }];
    if (!this.cfg.pastDay && this.M.canLift(list, i, A)) acts.push({ act: 'move', icon: 'move' });
    if (current && this.M.minDurAt(list, i, A) < c.dur) acts.push({ act: 'endnow', icon: 'end-now', cls: 'is-now' });
    if (!past)
      acts.push(
        { act: 'shorter', icon: 'shorter', disabled: c.dur <= this.M.minDurAt(list, i, A) },
        { act: 'longer', icon: 'longer' },
      );
    acts.push({ act: 'delete', icon: 'trash', cls: 'is-danger' }, { act: 'details', icon: 'more' });
    return { acts, past };
  }

  dockAction(act: DockAction['act'], viaKeyboard: boolean) {
    const c = this.cur();
    if (!c) return;
    switch (act) {
      case 'split':
        this.splitHalf(c.id);
        break;
      case 'move':
        this.startMove(c.id, viaKeyboard);
        break;
      case 'endnow':
        this.endNow(c.id);
        break;
      case 'shorter':
        this.resizeBy(c.id, -this.M.SNAP);
        break;
      case 'longer':
        this.resizeBy(c.id, this.M.SNAP);
        break;
      case 'delete':
        this.del(c.id);
        break;
      case 'details':
        this.openDetails(c.id);
        break;
    }
  }

  // ======================= Rezovi =======================

  minuteAt(c: StackItem, clientY: number): number {
    const box = this.boxOf(c.id);
    if (!box) return 0;
    const r = box.getBoundingClientRect();
    const st = this.M.startOf(this.items, c.id) ?? 0;
    return this.M.snapCut(st, ((clientY - r.top) / r.height) * c.dur);
  }

  addCutAt(clientY: number) {
    const s = this.splitSt;
    const c = s && this.items.find((x) => x.id === s.id);
    if (!s || !c) return;
    const m = this.minuteAt(c, clientY);
    const cuts = this.M.cutAdd(c.dur, s.cuts, m);
    if (!cuts) return;
    this.setCuts(cuts);
    this.say(this.t('blocks.split.cutSay', { time: fmtClock((this.M.startOf(this.items, c.id) ?? 0) + m) }));
  }

  moveCut(k: number, m: number) {
    const s = this.splitSt;
    const c = s && this.items.find((x) => x.id === s.id);
    if (!s || !c) return;
    const next = this.M.cutMove(c.dur, s.cuts, k, m);
    if (next.join() !== [...s.cuts].sort((a, b) => a - b).join()) this.setCuts(next);
  }

  removeCut(k: number) {
    const s = this.splitSt;
    if (!s) return;
    const sorted = [...s.cuts].sort((a, b) => a - b);
    sorted.splice(k, 1);
    this.setCuts(sorted);
  }

  // ======================= Prevlačenje, trajanje, rezovi (pokazivač) =======================

  private listenMoves() {
    window.addEventListener('pointermove', this.onMove, { passive: false });
    window.addEventListener('pointerup', this.onUp);
    window.addEventListener('pointercancel', this.onCancel);
  }

  private unlistenMoves() {
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    window.removeEventListener('pointercancel', this.onCancel);
  }

  clearPend() {
    if (this.pend) {
      window.clearTimeout(this.pend.timer);
      this.pend = null;
    }
  }

  /** Dok je blok podignut (ili se menja trajanje / pomera rez) stranica se ne skroluje prstom. */
  blocksTouchScroll(): boolean {
    return !!(this.drag || this.rs || this.cutDrag || this.pend?.armed);
  }

  onDown = (e: PointerEvent) => {
    if (e.button !== 0 || this.pend || this.drag || this.rs || this.cutDrag || this.preview) return;
    const tg = e.target as HTMLElement;
    const row = tg.closest<HTMLElement>('.blk');
    if (!row || row.classList.contains('is-ghost')) return;
    const id = this.idOfRow(row);
    if (id == null) return;
    if (tg.closest('.blk-grip')) {
      this.startResize(e, id);
      return;
    }
    const cut = tg.closest<HTMLElement>('.cut-drag');
    if (cut) {
      this.startCutDrag(e, Number(cut.dataset.cut));
      return;
    }
    // Dugmad (ocena, "+", ×, zatvori prazninu): samo klik — ni držanje ni prevlačenje.
    if (tg.closest('.day-status, .blk-ins, .cut-x, .blk-gap')) return;
    if (this.splitSt || this.moveSt || !tg.closest('.blk-box')) return;
    const i = this.M.idxOf(this.items, id);
    if (i < 0) return;
    const lift = !this.cfg.pastDay && !this.cfg.locked && this.M.canLift(this.items, i, this.anch());
    this.pend = { id, pointerId: e.pointerId, type: e.pointerType, x0: e.clientX, y0: e.clientY, lift, armed: false, timer: 0 };
    this.lastY = e.clientY;
    if (e.pointerType !== 'mouse') this.pend.timer = window.setTimeout(this.onHold, LONG_PRESS_MS);
    this.listenMoves();
  };

  idOfRow(row: Element | null): ItemId | null {
    return row ? (this.rowIds.get(row) ?? null) : null;
  }

  private onHold = () => {
    const p = this.pend;
    if (!p) return;
    if (p.lift) {
      p.armed = true;
      markBlockGesture();
      this.startDrag(this.lastY);
      return;
    }
    const c = this.items.find((x) => x.id === p.id);
    this.clearPend();
    this.suppressClick = true;
    markBlockGesture();
    if (c && c.kind === 'block') {
      this.shake(p.id);
      this.message(this.cfg.locked ? this.lockedMsg() : this.t('blocks.msg.past'));
    }
  };

  private onMove = (e: PointerEvent) => {
    if (this.pend && e.pointerId !== this.pend.pointerId) return;
    this.lastY = e.clientY;
    if (this.drag) {
      e.preventDefault();
      markBlockGesture();
      this.dragMove(e.clientY);
      return;
    }
    if (this.rs) {
      markBlockGesture();
      this.resizeMove(e.clientY);
      return;
    }
    if (this.cutDrag) {
      markBlockGesture();
      this.cutMoveTo(e.clientY);
      return;
    }
    const p = this.pend;
    if (!p) return;
    const dist = Math.hypot(e.clientX - p.x0, e.clientY - p.y0);
    if (p.type === 'mouse') {
      if (dist > MOUSE_SLOP) {
        if (p.lift) {
          p.armed = true;
          this.startDrag(e.clientY);
        } else this.clearPend();
      }
    } else if (dist > TOUCH_SLOP && !p.armed) this.clearPend(); // to je skrol
  };

  private onUp = () => {
    if (this.suppressClick) window.setTimeout(() => (this.suppressClick = false), 350);
    if (this.drag) this.dropDrag();
    else if (this.rs) this.endResize(false);
    else if (this.cutDrag) this.endCutDrag();
    this.clearPend();
    this.unlistenMoves();
  };

  private onCancel = () => {
    if (this.suppressClick) window.setTimeout(() => (this.suppressClick = false), 350);
    if (this.drag) this.cancelDrag();
    else if (this.rs) this.endResize(true);
    else if (this.cutDrag) this.endCutDrag();
    this.clearPend();
    this.unlistenMoves();
  };

  // --- Prevlačenje ---

  private startDrag(clientY: number) {
    const p = this.pend;
    if (!p) return;
    const id = p.id;
    const list = this.items;
    const A = this.anch();
    const inf = this.M.info(list, A);
    const from = this.M.idxOf(list, id);
    const c = list[from];
    const el = this.els.get(id);
    const box = this.boxOf(id);
    if (!c || !el || !box) return;
    const rects = list.map((x) => {
      const r = this.els.get(x.id)?.getBoundingClientRect() ?? { top: 0, height: 0, bottom: 0 };
      const top = r.top + window.scrollY;
      return { top, h: r.height, mid: top + r.height / 2, bottom: r.bottom + window.scrollY };
    });
    const br = box.getBoundingClientRect();
    const H = br.height;
    const CH = Math.min(H, CHIP_H);
    try {
      this.stackEl?.setPointerCapture(p.pointerId);
    } catch {
      // pokazivač je već pušten
    }
    const started = !!A && from < inf.ff;
    this.drag = {
      id,
      from,
      c,
      started,
      ff: A ? inf.ff : 0,
      rects,
      el,
      box,
      H,
      CH,
      grab: clamp(clientY - br.top, 16, CH - 16),
      top0: br.top + window.scrollY,
      shift: H + ROW_GAP,
      mode: 'none',
      to: from,
      k: from,
      target: null,
      off: 0,
      key: '',
      enterShift: 0,
      hyp: null,
      extra: null,
      slot: null,
      hole: started,
    };
    this.suppressClick = true;
    this.cancelTransient();
    this.sel = null;
    this.closeMsg();
    this.emit();
    vibrate(8);
    this.say(this.t('blocks.msg.lifted', { name: this.nameOf(c) }));
    this.dragMove(clientY);
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(this.autoScroll);
  }

  shiftOf(d: DragState, j: number): number {
    if (d.mode !== 'order' || j === d.from) return 0;
    if (d.started) return j >= d.k ? d.shift : 0;
    return d.from < j && j <= d.to ? -d.shift : d.to <= j && j < d.from ? d.shift : 0;
  }

  private bsTop(): number {
    return (this.bsEl?.getBoundingClientRect().top ?? 0) + window.scrollY;
  }

  private setSlot(d: DragState, topDoc: number, h: number, push = false) {
    d.slot = { top: topDoc - this.bsTop(), h: Math.max(18, h), push };
  }

  private paintNone(d: DragState) {
    d.mode = 'none';
    d.key = 'none';
    d.hyp = null;
    d.extra = null;
    d.slot = null;
    d.hole = d.started;
    this.emit();
  }

  dragMove(clientY: number) {
    const d = this.drag;
    if (!d) return;
    const list = this.items;
    const A = this.anch();
    const n = list.length;
    const fy = clientY + window.scrollY;
    const boxTop = fy - d.grab;
    d.el.style.setProperty('--dy', `${boxTop - d.top0}px`);
    // 1) Iznad slobodnog vremena: blok ide u njega od vremena pod gornjom ivicom; ništa drugo se ne pomera.
    let fi = -1;
    if (d.c.kind === 'block') {
      list.forEach((f, j) => {
        if (fi >= 0 || f.kind !== 'free' || j === d.from || this.M.freeRoom(list, j, A) == null) return;
        const r = d.rects[j];
        let top: number;
        let bot: number;
        if (d.mode === 'free' && d.target === f.id) {
          top = Math.min(r.top, r.top + d.enterShift);
          bot = Math.max(r.bottom, r.bottom + d.enterShift);
        } else {
          const s = this.shiftOf(d, j);
          top = r.top + s;
          bot = r.bottom + s;
        }
        if (fy >= top && fy < bot) fi = j;
      });
    }
    if (fi >= 0) {
      const f = list[fi];
      const r = d.rects[fi];
      const room = this.M.freeRoom(list, fi, A) ?? 0;
      const raw = ((boxTop - r.top) / r.h) * f.dur;
      const off = clamp(Math.round(raw / this.M.SNAP) * this.M.SNAP, room, Math.max(room, f.dur - d.c.dur));
      const key = `f${f.id}:${off}`;
      if (d.key !== key) {
        if (d.mode !== 'free') d.enterShift = this.shiftOf(d, fi);
        d.mode = 'free';
        d.key = key;
        d.target = f.id;
        d.off = off;
        d.hole = true;
        const hyp = this.M.opPlace(list, d.id, f.id, off, A);
        if (!hyp || !this.M.pastOk(list, hyp, A)) {
          this.paintNone(d);
          return;
        }
        d.hyp = hyp;
        d.extra = this.t('blocks.intoFreeShort');
        const top = r.top + (off / f.dur) * r.h;
        this.setSlot(d, top, Math.min(r.bottom - top, (d.c.dur / f.dur) * r.h), d.c.dur > f.dur - off);
        this.emit();
      }
      return;
    }
    if (d.mode === 'free') {
      d.mode = 'none';
      d.key = '';
      d.hole = d.started;
    }
    // 2) Između blokova: mesto određuje prst (ne veličina bloka).
    if (d.started) {
      if (d.ff >= n || fy < d.rects[d.ff].top) {
        if (d.key !== 'none') this.paintNone(d);
        return;
      }
      let k = n;
      for (let j = d.ff; j < n; j++)
        if (fy < d.rects[j].mid) {
          k = j;
          break;
        }
      const key = `k${k}`;
      if (d.key === key) return;
      const hyp = this.M.opMoveTo(list, d.id, k, A);
      if (!hyp || !this.M.pastOk(list, hyp, A)) {
        if (d.key !== 'none') this.paintNone(d);
        return;
      }
      d.mode = 'order';
      d.k = k;
      d.key = key;
      d.hyp = hyp;
      d.extra = null;
      this.setSlot(d, k < n ? d.rects[k].top : d.rects[n - 1].bottom + ROW_GAP, d.H);
      this.emit();
      return;
    }
    let to = d.from;
    for (let j = d.from + 1; j < n; j++) {
      if (fy > d.rects[j].mid) to = j;
      else break;
    }
    if (to === d.from)
      for (let j = d.from - 1; j >= 0; j--) {
        if (fy < d.rects[j].mid) to = j;
        else break;
      }
    if (A) to = Math.max(to, d.ff);
    const key = `o${to}`;
    if (d.key === key) return;
    d.mode = 'order';
    d.to = to;
    d.key = key;
    const hyp = to === d.from ? list : this.M.opMoveTo(list, d.id, to > d.from ? to + 1 : to, A);
    d.hyp = hyp ?? list;
    d.extra = null;
    this.setSlot(d, to > d.from ? d.rects[to].bottom - d.H : d.rects[to].top, d.H);
    this.emit();
  }

  private autoScroll = () => {
    const ind = this.asIndEl;
    if (!this.drag && !this.rs) {
      ind?.classList.remove('is-on');
      return;
    }
    if (!this.drag && this.rs) {
      this.resizeAutoScroll();
      this.raf = requestAnimationFrame(this.autoScroll);
      return;
    }
    const phone = isPhoneWidth();
    const topZ = Math.max(0, this.barEl?.getBoundingClientRect().bottom ?? 0) + 40;
    const botEdge = phone ? (this.dockEl ? this.dockEl.getBoundingClientRect().top : window.innerHeight - TABBAR_H) : window.innerHeight;
    const botZ = botEdge - 40;
    let v = 0;
    if (this.lastY < topZ) v = -Math.min(8, Math.ceil((topZ - this.lastY) / 5));
    else if (this.lastY > botZ) v = Math.min(8, Math.ceil((this.lastY - botZ) / 5));
    if (v) {
      const before = window.scrollY;
      window.scrollBy(0, v);
      if (window.scrollY !== before) {
        if (ind) {
          ind.dataset.dir = v < 0 ? 'up' : 'down';
          ind.style.top = `${v < 0 ? topZ - 34 : botZ + 10}px`;
          ind.classList.add('is-on');
        }
        this.dragMove(this.lastY);
      } else ind?.classList.remove('is-on');
    } else ind?.classList.remove('is-on');
    this.raf = requestAnimationFrame(this.autoScroll);
  };

  /**
   * Ručica uz miš (dodir nema automatski skrol): tek kad je pokazivač iza ivice vidljivog dela (preko trake akcija ili
   * iznad trake), jedan korak (15 min) na RS_AUTO_MS, bez obzira na dubinu, i najviše ±2h po potezu.
   */
  private resizeAutoScroll() {
    const rs = this.rs;
    const ind = this.asIndEl;
    if (!rs) return;
    const b = this.band();
    const dir = this.lastY >= b.bottom ? 1 : this.lastY <= b.top ? -1 : 0;
    if (!dir || Math.abs(rs.auto + dir * STEP_PX) > RS_AUTO_MAX_PX) {
      ind?.classList.remove('is-on');
      return;
    }
    const at = performance.now();
    if (at - rs.autoAt < RS_AUTO_MS) return;
    const before = window.scrollY;
    window.scrollBy(0, dir * STEP_PX);
    const moved = window.scrollY - before;
    if (!moved) {
      ind?.classList.remove('is-on');
      return;
    }
    rs.auto += moved;
    rs.autoAt = at;
    if (ind) {
      ind.dataset.dir = dir < 0 ? 'up' : 'down';
      ind.style.top = `${dir < 0 ? b.top + 6 : b.bottom - 34}px`;
      ind.classList.add('is-on');
    }
    this.resizeMove(this.lastY);
  }

  private endDragVisual(d: DragState) {
    cancelAnimationFrame(this.raf);
    this.asIndEl?.classList.remove('is-on');
    d.el.style.removeProperty('--dy');
  }

  private dropDrag() {
    const d = this.drag;
    if (!d) return;
    const A = this.anch();
    const first = this.measure();
    first.set(d.id, d.box.getBoundingClientRect().top);
    this.drag = null;
    this.endDragVisual(d);
    vibrate(5);
    let next: StackItem[] | null = null;
    let key: 'blocks.msg.moved' | 'blocks.msg.movedFree' = 'blocks.msg.moved';
    if (d.mode === 'free' && d.target != null) {
      next = this.M.opPlace(this.items, d.id, d.target, d.off, A);
      key = 'blocks.msg.movedFree';
    } else if (d.mode === 'order')
      next = d.started
        ? this.M.opMoveTo(this.items, d.id, d.k, A)
        : d.to !== d.from
          ? this.M.opMoveTo(this.items, d.id, d.to > d.from ? d.to + 1 : d.to, A)
          : null;
    const name = this.nameOf(d.c);
    if (!next || !this.commit(next, { first, select: d.c.kind === 'free' ? null : d.id, target: d.id, msg: this.t(key, { name, range: this.rangeIn(next, d.id) }) })) {
      if (d.c.kind === 'block') this.sel = d.id;
      this.emit();
      this.after(() => this.flip(first));
      return;
    }
    this.reveal(d.id);
  }

  cancelDrag() {
    const d = this.drag;
    if (!d) return;
    const first = this.measure();
    first.set(d.id, d.box.getBoundingClientRect().top);
    this.drag = null;
    this.endDragVisual(d);
    this.emit();
    this.after(() => this.flip(first));
  }

  // --- Trajanje: ručica izabranog bloka (kreće od prvog pomeranja, 20 px = 15 min) ---

  private startResize(e: PointerEvent, id: ItemId) {
    e.preventDefault();
    const list = this.items;
    const A = this.anch();
    const i = this.M.idxOf(list, id);
    const c = list[i];
    if (!c || c.kind === 'free' || this.cfg.pastDay || this.cfg.locked || !this.M.canResize(list, i, A)) return;
    try {
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // pokazivač je već pušten
    }
    if (this.sel !== id) {
      this.sel = id;
      this.splitSt = null;
      this.renaming = false;
      this.moveSt = null;
    }
    const box = this.boxOf(id);
    this.rs = {
      id,
      base: list,
      d0: c.dur,
      st: this.M.startsOf(list)[i],
      y0: e.clientY,
      s0: window.scrollY,
      cur: c.dur,
      h0: box?.getBoundingClientRect().height ?? heightOf(c.dur),
      min: this.M.minDurAt(list, i, A),
      auto: 0,
      autoAt: 0,
    };
    this.lastY = e.clientY;
    this.suppressClick = true;
    markBlockGesture();
    this.closeMsg();
    this.listenMoves();
    this.emit();
    cancelAnimationFrame(this.raf);
    // Dodir: trajanje prati samo prst (opseg je u traci i na oznaci kraja); dalje od ekrana = Duže ili prevlačenje.
    if (e.pointerType === 'mouse') this.raf = requestAnimationFrame(this.autoScroll);
  }

  resizeMove(clientY: number) {
    const rs = this.rs;
    if (!rs) return;
    const dy = clientY - rs.y0 + (window.scrollY - rs.s0);
    const steps = Math.round(dy / STEP_PX);
    const SNAP = this.M.SNAP;
    const end = Math.round((rs.st + rs.d0 + steps * SNAP) / SNAP) * SNAP;
    const dur = clamp(end - rs.st, rs.min, this.M.LEN);
    if (dur === rs.cur) return;
    const next = dur === rs.d0 ? rs.base : this.M.opResize(rs.base, rs.id, dur);
    if (!next) return;
    rs.cur = dur;
    this.preview = next;
    this.emit();
    vibrate(3);
  }

  /** Visina bloka koji se upravo produžava (prati prst u koracima od 20 px). */
  resizeHeight(c: StackItem): number | null {
    const rs = this.rs;
    if (!rs || rs.id !== c.id) return null;
    return Math.max(heightOf(this.M.MIN), Math.round(rs.h0 + ((c.dur - rs.d0) / this.M.SNAP) * STEP_PX));
  }

  updatePill() {
    const pill = this.pillEl;
    if (!pill) return;
    const rs = this.rs;
    const box = rs && this.boxOf(rs.id);
    if (!rs || !box) {
      pill.hidden = true;
      return;
    }
    const r = box.getBoundingClientRect();
    pill.hidden = false;
    pill.textContent = fmtClock(rs.st + rs.cur);
    pill.style.top = `${r.bottom + window.scrollY - this.bsTop()}px`;
  }

  private endResize(cancel: boolean) {
    cancelAnimationFrame(this.raf);
    this.asIndEl?.classList.remove('is-on');
    const r = this.rs;
    this.rs = null;
    const next = this.preview;
    this.preview = null;
    if (!r || cancel || !next || r.cur === r.d0) {
      this.emit();
      return;
    }
    const c = r.base.find((x) => x.id === r.id);
    this.commit(next, {
      target: r.id,
      msg: this.t('blocks.msg.resized', { name: c ? this.nameOf(c) : '', range: this.rangeIn(next, r.id) }) + ' · ' + fmtDuration(r.cur),
    });
  }

  // --- Rezovi ---

  private startCutDrag(e: PointerEvent, k: number) {
    e.preventDefault();
    try {
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // pokazivač je već pušten
    }
    this.cutDrag = { k };
    this.suppressClick = true;
    markBlockGesture();
    this.listenMoves();
    this.emit();
  }

  private cutMoveTo(clientY: number) {
    const s = this.splitSt;
    const c = s && this.items.find((x) => x.id === s.id);
    if (!s || !c || !this.cutDrag) return;
    this.moveCut(this.cutDrag.k, this.minuteAt(c, clientY));
  }

  private endCutDrag() {
    this.cutDrag = null;
    this.emit();
  }

  // ======================= Dodiri i klikovi =======================

  onStackClick = (e: MouseEvent) => {
    if (this.suppressClick) {
      this.suppressClick = false;
      e.preventDefault();
      return;
    }
    const tg = e.target as HTMLElement;
    const slot = tg.closest<HTMLElement>('.blk-slot-btn');
    if (slot) {
      this.placeAt(Number(slot.dataset.t));
      return;
    }
    const row = tg.closest<HTMLElement>('.blk');
    if (!row || row.classList.contains('is-ghost')) return;
    if (!tg.closest('.blk-box')) {
      // dodir pored blokova zatvara traku
      if (this.sel != null || this.moveSt || this.splitSt) this.deselect();
      return;
    }
    const id = this.idOfRow(row);
    const list = this.items;
    const i = id == null ? -1 : this.M.idxOf(list, id);
    const c = list[i];
    if (id == null || !c) return;
    const sb = tg.closest<HTMLElement>('.day-status-btn');
    if (sb) {
      this.setStatus(id, sb.dataset.status as Exclude<BlockStatus, 'pending'>);
      return;
    }
    const ins = tg.closest<HTMLElement>('.blk-ins');
    if (ins) {
      this.openNew({ mode: 'seam', at: ins.classList.contains('is-top') ? i : i + 1 });
      return;
    }
    if (tg.closest('.blk-gap')) {
      this.closeGap(id);
      return;
    }
    const cx = tg.closest<HTMLElement>('.cut-x');
    if (cx) {
      this.removeCut(Number(cx.dataset.cutx));
      return;
    }
    if (tg.closest('.cut-drag')) return;
    if (this.splitSt) {
      if (this.splitSt.id === id) {
        if (e.detail !== 0) this.addCutAt(e.clientY);
        return;
      }
      this.splitSt = null;
      this.emit();
      return;
    }
    if (this.moveSt) {
      if (c.kind === 'free') {
        const n = this.moveSt.targets.findIndex((x) => x.kind === 'free' && x.freeId === id);
        if (n >= 0) this.placeAt(n);
      }
      return;
    }
    if (!tg.closest('.blk-main')) return;
    if (c.kind === 'free') {
      if (this.sel != null) {
        // prvi dodir samo zatvara traku akcija
        this.deselect();
        return;
      }
      const room = this.M.freeRoom(list, i, this.insA());
      if (room == null) return;
      // Od početka praznine (natpis "+ Slobodno" je po sredini reda, a visina reda nije srazmerna trajanju). Samo u
      // praznini dužoj od 2h dodir ispod natpisa bira vreme pod prstom (srazmerni deo visine, bez 19 px gore i dole).
      let off = room;
      if (e.detail !== 0 && c.dur > 120) {
        const r = (row.querySelector('.blk-box') as HTMLElement).getBoundingClientRect();
        const label = row.querySelector('.blk-text')?.getBoundingClientRect();
        if (label && e.clientY > label.bottom) {
          const m = ((e.clientY - r.top - 19) / Math.max(1, r.height - 38)) * c.dur;
          off = Math.floor(m / this.M.SNAP) * this.M.SNAP;
        }
      }
      this.openNew({ mode: 'free', freeId: id, off: clamp(off, room, Math.max(room, c.dur - this.M.MIN)) });
      return;
    }
    if (this.sel === id) {
      if (this.selByTap && performance.now() - this.selAt > 300) this.openDetails(id);
      else {
        this.selByTap = true;
        this.selAt = performance.now();
      }
      return;
    }
    this.select(id, { byTap: true });
  };

  /** Dodir van blokova i trake zatvara izbor (skrol nije klik). */
  onDocClick = (e: MouseEvent) => {
    if (this.sel == null && !this.splitSt && !this.moveSt) return;
    const tg = e.target as HTMLElement | null;
    if (!tg || !tg.isConnected) return;
    if (tg.closest('.blk-stack, .blk-dock, dialog, .blk-toaster, .blk-bar, .day-menu, .day-menu-wrap, .shell-tabbar, .shell-side'))
      return;
    this.deselect();
  };

  // ======================= Tastatura =======================

  onStackKey = (e: KeyboardEvent) => {
    const tg = e.target as HTMLElement;
    const cutBtn = tg.closest<HTMLElement>('.cut-drag');
    const s = this.splitSt;
    if (cutBtn && s) {
      const k = Number(cutBtn.dataset.cut);
      const sorted = [...s.cuts].sort((a, b) => a - b);
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        this.moveCut(k, sorted[k] + (e.key === 'ArrowUp' ? -this.M.SNAP : this.M.SNAP));
      } else if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        this.removeCut(k);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        this.confirmSplit();
      }
      return;
    }
    const grip = tg.closest<HTMLElement>('.blk-grip');
    if (grip && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      const id = this.idOfRow(grip.closest('.blk'));
      if (id != null) this.resizeBy(id, e.key === 'ArrowUp' ? -this.M.SNAP : this.M.SNAP);
      return;
    }
    const vert = e.key === 'ArrowUp' || e.key === 'ArrowDown';
    const dir: -1 | 1 = e.key === 'ArrowUp' ? -1 : 1;
    if (this.moveSt && vert && !e.altKey && !e.shiftKey) {
      // "Premesti": strelice idu samo po mestima
      e.preventDefault();
      const f = this.moveTargetEls();
      const k = f.indexOf(tg.closest<HTMLElement>('.blk-slot-btn, .blk-main')!);
      this.focusEl(k < 0 ? f[0] : f[k + dir]);
      return;
    }
    if (tg.closest('.blk-slot-btn')) return;
    const main = tg.closest<HTMLElement>('.blk-main');
    if (!main) return;
    const id = this.idOfRow(main.closest('.blk'));
    const c = id == null ? undefined : this.items.find((x) => x.id === id);
    if (id == null || !c) return;
    const A = this.anch();
    const i = this.M.idxOf(this.items, id);
    const inf = this.M.info(this.items, A);
    const ensureSel = () => {
      if (c.kind === 'block' && this.sel !== id) this.select(id, { reveal: false });
    };
    const refocus = () => this.focusRow(id);
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
    if (vert && e.altKey && e.shiftKey) {
      e.preventDefault();
      ensureSel();
      this.nudge(id, dir);
      refocus();
    } else if (vert && e.altKey) {
      e.preventDefault();
      ensureSel();
      this.moveBy(id, dir);
      refocus();
    } else if (vert && e.shiftKey) {
      e.preventDefault();
      if (c.kind === 'block') ensureSel();
      this.resizeBy(id, dir * this.M.SNAP);
      refocus();
    } else if (vert) {
      e.preventDefault();
      const f = this.stackEl ? [...this.stackEl.querySelectorAll<HTMLElement>('.blk:not(.is-ghost) .blk-main:not(:disabled), .blk-slot-btn')] : [];
      this.focusEl(f[f.indexOf(main) + dir]);
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      if (c.kind === 'free') this.closeGap(id);
      else this.del(id);
    } else if (e.key === 'F2' && c.kind === 'block') {
      e.preventDefault();
      ensureSel();
      this.startRename();
    } else if ((e.key === 's' || e.key === 'S') && c.kind === 'block' && plain) {
      e.preventDefault();
      ensureSel();
      this.splitHalf(id);
      this.focusRow(this.sel);
    } else if ((e.key === 'm' || e.key === 'M') && plain) {
      e.preventDefault();
      ensureSel();
      if (c.kind === 'block') this.startMove(id, true);
    } else if ((e.key === 'n' || e.key === 'N') && plain) {
      e.preventDefault();
      if (c.kind === 'free') {
        const room = this.M.freeRoom(this.items, i, this.insA());
        if (room != null) this.openNew({ mode: 'free', freeId: id, off: room });
      } else if (!A || i + 1 >= inf.ff) this.openNew({ mode: 'seam', at: i + 1 });
    } else if (['1', '2', '3'].includes(e.key) && plain && c.kind === 'block' && A && inf.st[i] <= A.now) {
      e.preventDefault();
      this.setStatus(id, (['done', 'partial', 'skipped'] as const)[Number(e.key) - 1]);
    }
  };

  onDocKey = (e: KeyboardEvent) => {
    const tg = e.target as HTMLElement | null;
    // Polja za unos: prečice niza ne rade; Esc samo u poljima niza i trake akcija (ne u Beleškama ili Zadacima).
    const field = tg?.closest?.('input, textarea, select, [contenteditable]');
    if (field && (e.key !== 'Escape' || !field.closest('.blk-dock, .blk-stack'))) return;
    if (document.querySelector('dialog[open]')) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === 'z') {
      e.preventDefault();
      if (e.shiftKey) this.redo();
      else this.undo();
      return;
    }
    if (mod && k === 'y') {
      e.preventDefault();
      this.redo();
      return;
    }
    if (e.key === 'Escape') {
      if (document.querySelector('[role="menu"]')) return;
      if (this.drag) {
        this.cancelDrag();
        this.clearPend();
        e.preventDefault();
        return;
      }
      if (this.moveSt) {
        e.preventDefault();
        this.cancelMove();
        return;
      }
      if (this.splitSt) {
        e.preventDefault();
        this.splitSt = null;
        this.emit();
        this.focusRow(this.sel);
        return;
      }
      if (this.renaming) {
        e.preventDefault();
        this.cancelRename();
        return;
      }
      if (this.sel != null) {
        e.preventDefault();
        const id = this.sel;
        this.deselect();
        this.focusRow(id);
      }
      return;
    }
    if (e.key === 'Enter' && this.splitSt && !tg?.closest?.('.blk-dock, .cut-x, .cut-drag, button')) {
      e.preventDefault();
      this.confirmSplit();
    }
  };

  // ======================= Nov blok =======================

  defaultNewSpec(): InsertSpec {
    const A = this.insA();
    // Prazan dan (bez "sada"): nov blok u 09:00, kao i ranije, a ne u ponoć.
    const only = this.items.length === 1 ? this.items[0] : null;
    if (!A && only?.kind === 'free') return { mode: 'free', freeId: only.id, off: clamp(9 * 60 - this.M.frame.start, 0, only.dur - this.M.MIN) };
    return this.M.defaultInsertSpec(this.items, A);
  }

  openNew(spec?: InsertSpec) {
    if (this.drag || this.rs) return;
    if (this.cfg.locked) {
      this.message(this.lockedMsg());
      return;
    }
    const prep = this.M.prepareInsert(this.items, spec ?? this.defaultNewSpec(), this.insA());
    if (!prep) return;
    this.cancelTransient();
    this.sel = null;
    this.closeMsg();
    this.nb = {
      spec: prep.spec,
      id: newItemId('n'),
      name: '',
      cat: null,
      catTouched: false,
      dur: prep.dur,
      free: false,
      err: false,
      where: '',
      effect: '',
      effectCls: '',
      canCloseGap: prep.spec.mode === 'free' && this.closable(prep.spec.freeId),
    };
    this.updateNewPreview();
  }

  private newItem(real: boolean): StackItem | null {
    const nb = this.nb;
    if (!nb) return null;
    if (nb.free) return makeFree(nb.dur, nb.id);
    return makeBlock({ id: nb.id, title: nb.name.trim() || (real ? '' : this.t('day.block.newTitle')), categoryId: nb.cat, dur: nb.dur });
  }

  private computeNew(item: StackItem): StackItem[] | null {
    const nb = this.nb;
    return nb ? this.M.opInsertAt(this.items, nb.spec, item) : null;
  }

  updateNewPreview() {
    const nb = this.nb;
    const item = this.newItem(false);
    const next = item && this.computeNew(item);
    if (!nb || !next) {
      this.emit();
      return;
    }
    const t = this.t;
    this.preview = next;
    this.ghostId = nb.id;
    const i = this.M.idxOf(next, nb.id);
    const st = this.M.startsOf(next)[i];
    const range = fmtRange(st, st + nb.dur);
    const above = next[i - 1];
    nb.where =
      nb.spec.mode === 'free'
        ? t('blocks.new.inFree', { range })
        : above && above.kind === 'block'
          ? t('blocks.new.after', { range, name: above.title })
          : t('blocks.new.at', { range });
    const moved = this.M.movedBlocks(this.items, next, nb.id);
    const was = new Set(this.overNames(this.items));
    const over = this.overNames(next).filter((n) => !was.has(n));
    nb.effectCls = over.length ? 'is-over' : moved.length ? 'is-moves' : '';
    nb.effect =
      (moved.length
        ? t('blocks.new.moves', { n: moved.length, time: fmtDuration(Math.max(...moved.map((m) => Math.abs(m.d)))) })
        : t('blocks.new.nothingMoves')) + (over.length ? ' ' + t('blocks.new.overflow', { name: over[0] }) : '');
    this.emit();
  }

  /**
   * List "Novi blok" je na ekranu (NewBlockSheet ga meri posle rasporeda i pri svakoj promeni visine): isprekidan novi
   * blok i ono što pomera staju između trake i lista. Telefon: list je najviše toliko visok da iznad njega ostane bar
   * min(visina bloka, 80 px) (telo lista se tada skroluje), a blok je odmah ispod trake.
   */
  fitNewSheet(dialog: HTMLElement, tries = 0) {
    const nb = this.nb;
    if (!nb) return;
    const box = this.boxOf(nb.id);
    if (!box) {
      if (tries < 6) this.after(() => this.fitNewSheet(dialog, tries + 1));
      return;
    }
    const phone = isPhoneWidth();
    const barBottom = this.stuckBarBottom();
    const r = box.getBoundingClientRect();
    const gh = Math.min(r.height, 80);
    if (phone) {
      const max = `${Math.max(200, Math.floor(window.innerHeight - barBottom - gh - 24))}px`;
      if (dialog.style.getPropertyValue('--nb-max') !== max) dialog.style.setProperty('--nb-max', max);
    }
    const top = Math.max(0, this.barEl?.getBoundingClientRect().bottom ?? 0) + 8;
    const bottom = (phone ? dialog.getBoundingClientRect().top : this.band().bottom) - 8;
    if (r.top >= top && r.top + gh <= bottom) return;
    window.scrollBy(0, r.top - (barBottom + 8));
  }

  nbSetName(name: string) {
    const nb = this.nb;
    if (!nb) return;
    nb.name = name;
    nb.err = false;
    if (!nb.catTouched) {
      const hit = this.knownNames().find((s) => fold(s.name) === fold(name));
      nb.cat = hit ? hit.cat : null;
    }
    this.updateNewPreview();
  }

  nbPick(name: string, cat: number | null) {
    const nb = this.nb;
    if (!nb) return;
    nb.name = name;
    nb.cat = cat;
    nb.err = false;
    this.updateNewPreview();
  }

  nbSetCat(cat: number | null) {
    const nb = this.nb;
    if (!nb) return;
    nb.cat = cat;
    nb.catTouched = true;
    this.updateNewPreview();
  }

  nbSetDur(dur: number) {
    const nb = this.nb;
    if (!nb) return;
    nb.dur = dur;
    this.updateNewPreview();
  }

  nbSetFree(on: boolean) {
    const nb = this.nb;
    if (!nb) return;
    nb.free = on;
    nb.name = '';
    nb.err = false;
    this.updateNewPreview();
  }

  /** Zatvaranje lista "Novi blok": 'ok' = dodaj, 'gap' = zatvori prazninu, 'cancel'. false = ostaje otvoren. */
  closeNew(result: 'ok' | 'cancel' | 'gap'): boolean {
    const nb = this.nb;
    if (!nb) return true;
    if (result === 'ok' && !nb.free && !nb.name.trim()) {
      nb.err = true;
      this.emit();
      return false;
    }
    const item = result === 'ok' ? this.newItem(true) : null;
    const spec = nb.spec;
    this.nb = null;
    this.preview = null;
    this.ghostId = null;
    if (result === 'ok' && item) {
      this.insertNew(item, spec);
      return true;
    }
    this.emit();
    if (result === 'gap' && nb.spec.mode === 'free') this.closeGap(nb.spec.freeId);
    return true;
  }

  private insertNew(item: StackItem, spec: InsertSpec) {
    const prev = this.items;
    const next = this.M.opInsertAt(prev, spec, item);
    if (!next) {
      this.emit();
      return;
    }
    // Raniji dan: novo sme samo u slobodno vreme, i to tako da se ništa drugo ne pomeri.
    const pastOnly = this.cfg.pastDay && this.cfg.now == null;
    if (pastOnly && this.M.movedBlocks(prev, next, item.id).length) {
      this.message(this.t('blocks.msg.past'));
      this.emit();
      return;
    }
    const range = this.rangeIn(next, item.id);
    const at = this.M.startOf(next, item.id);
    const free = item.kind === 'free';
    if (
      this.commit(next, {
        trusted: pastOnly,
        select: free ? null : item.id,
        target: item.id,
        msg: free ? this.t('blocks.msg.addedFree', { range }) : this.t('blocks.msg.added', { name: msgName((item as StackBlock).title), range }),
      })
    ) {
      this.flash(item.id);
      this.reveal(item.id);
      // Fokus na nov blok (traka akcija pokazuje njega): sledeća prečica menja njega, ne blok sa kog je list otvoren.
      // Slobodno vreme se može spojiti sa susednim — fokus na red koji ga sada sadrži.
      const holder = this.items.some((c) => c.id === item.id) ? item.id : at != null ? (this.itemAt(at)?.id ?? null) : null;
      this.focusRow(holder);
    }
  }

  // ======================= Detalji =======================

  openDetails(id: ItemId) {
    const c = this.items.find((x) => x.id === id);
    if (!c || c.kind !== 'block') return;
    this.detId = id;
    this.emit();
  }

  closeDetails() {
    const id = this.detId;
    this.detId = null;
    this.emit();
    this.focusRow(id);
  }

  /** Detalji: naziv, kategorija, ocena, stvarno vreme i beleška (vreme se ne menja). */
  saveDetails(id: ItemId, patch: BlockFields) {
    const c = this.items.find((x) => x.id === id);
    this.detId = null;
    if (!c || c.kind !== 'block') {
      this.emit();
      return;
    }
    const same = (Object.keys(patch) as Array<keyof BlockFields>).every((k) => (patch[k] ?? null) === (c[k] ?? null));
    if (same) {
      this.emit();
      this.focusRow(id);
      return;
    }
    if (this.cfg.locked) {
      this.cfg.onPatchFields?.(id, patch);
      this.emit();
      this.focusRow(id);
      return;
    }
    const fixed: BlockFields = { ...patch };
    if (patch.status && !isActive(patch.status)) fixed.actualMin = null;
    this.commit(this.M.opUpdate(this.items, id, fixed), {
      keepFam: true,
      fieldsOnly: true,
      trusted: true,
      msg: this.t('blocks.msg.saved', { name: msgName(patch.title ?? c.title) }),
    });
    this.focusRow(id);
  }

  deleteFromDetails(id: ItemId) {
    this.detId = null;
    this.emit();
    this.del(id);
  }

  /** Pomoćno za React: blokovi koji počinju posle kraja dana. */
  overflowing(list: readonly StackItem[]): StackBlock[] {
    return this.M.overflowing(list);
  }
}
