// Dan (ili šablon) kao niz blokova koji se slažu jedan za drugim — čist model bez React-a i DOM-a. Deli se
// između web klijenta (Today i Raspored), servera (`layoutBase` za proveru konflikta) i testova
// (shared/blockStack.test.ts). TypeScript prenos testiranog prototipa (cubes-final/dev/model.js).
//
// Model
// - Dan je uređen niz stavki položenih od početka okvira (`frame.start`, obično settings.dayStart): blok
//   { kind: 'block', id, title, categoryId, dur, status, actualMin, note } ili slobodno vreme { kind: 'free', id, dur }.
//   Početak stavke je zbir trajanja pre nje, pa je dan uvek bez rupa i bez preklapanja.
// - Slobodno vreme na kraju dopunjava dan do 24h; poslednji blok sme da pređe kraj okvira (preko ponoći).
//   Blok koji POČINJE posle kraja okvira je dozvoljen (prikaz ga označava), ali nijedan blok ne sme da izađe iz
//   `isValidRange` (početak < 2880, trajanje ≤ 24h) — takvu izmenu operacija odbija (vraća null).
// - Mreža je 5 min, najkraći blok 5 min (stari podaci van mreže ostaju kakvi jesu dok ih korisnik ne menja).
//   Dugmad "Kraće"/"Duže" (i Shift+↑↓) i dalje menjaju trajanje za 15 min (`LEN_STEP_MIN`).
//
// Pravilo talasa: duže / ubacivanje gura stavke posle sebe samo do prvog slobodnog vremena, koje upija razliku;
// kraće / "završi sad" / zatvaranje praznine povlače stavke posle sebe, a sledeće slobodno vreme raste; brisanje
// ostavlja slobodno vreme na istom mestu (ništa se ne pomera). Ništa se ne preuređuje samo od sebe.
// Gornja ivica (početak bloka) je ogledalo: raniji početak prvo troši slobodno vreme odmah pre bloka, pa gura
// ranije stavke ranije do slobodnog vremena koje upija razliku (nikad pre početka okvira); kasniji početak ostavlja
// slobodno vreme pre bloka. Kraj bloka i sve posle njega ostaju.
//
// Sidrenje (samo danas, A = { now, nows }; nows = now zaokruženo naviše na mrežu): stavke koje su počele
// (start ≤ now) zadržavaju početak, prošao blok (kraj ≤ now) zadržava i kraj, tekući blok menja samo kraj (ne pre
// nows), ništa novo se ne stavlja pre nows. Počet blok bez ocene sme da napusti prošlost (ostavlja slobodno vreme i
// postaje 'pending'); ocenjen ne sme da se pomeri (sme da se oceni, podeli, preimenuje i obriše). `pastOk(prev, next,
// A)` to proverava posle svake izmene (osim deljenja, koje ne pomera vreme). Raniji dan: `anchor(Infinity)` — ništa se
// ne pomera. Budući dan i šablon: A = null.
//
// Sve operacije su čiste: primaju niz (ne menjaju ga) i vraćaju nov niz ili null (izmena nije moguća).

import type { Block, BlockInput, BlockStatus, DayBlockInput } from './types.ts';
import { DAY_MIN, isValidRange } from './time.ts';

/** Mreža (minuti): pomeranja, trajanja i rezovi se zaokružuju na nju. */
export const SNAP_MIN = 5;
/** Najkraći blok (minuti). */
export const MIN_BLOCK_MIN = 5;
/** Korak dugmadi "Kraće"/"Duže" i Shift+↑↓ (minuti); kraj se i dalje poravnava na mrežu. */
export const LEN_STEP_MIN = 15;
/** Koliko koraka unazad pamti istorija izmena jednog prikaza. */
export const HISTORY_LIMIT = 200;
/** Ponovljena ista izmena (npr. "Kraće" više puta) u ovom roku je jedan korak istorije. */
export const COALESCE_MS = 4000;

// ======================= Tipovi =======================

/** Id stavke: broj = blok sa servera (negativan = pregled iz šablona), string = klijentski id ('n1', 'f2'). */
export type ItemId = number | string;

export interface StackBlock {
  kind: 'block';
  id: ItemId;
  title: string;
  categoryId: number | null;
  /** Trajanje u minutima (> 0). */
  dur: number;
  status: BlockStatus;
  actualMin: number | null;
  note: string;
}

export interface StackFree {
  kind: 'free';
  /** Obično klijentski id; obrisan blok postaje slobodno vreme sa istim id-jem (red se preliva, ne nestaje). */
  id: ItemId;
  dur: number;
}

export type StackItem = StackBlock | StackFree;
/** Niz stavki dana; operacije ga nikad ne menjaju. */
export type Stack = readonly StackItem[];

/** Okvir dana: stavke se slažu od `start`; `end` = kraj logičkog dana (dayStart + 24h). */
export interface Frame {
  start: number;
  end: number;
}

/** "Sada" za sidrenje (samo danas): `now` = logički minut (sa decimalama), `nows` = now naviše na mrežu. */
export interface Anchor {
  now: number;
  nows: number;
}

export interface StackInfo {
  /** Početak svake stavke. */
  st: number[];
  /** Indeks tekuće stavke (start ≤ now < kraj), ili -1. */
  cur: number;
  /** Prvi indeks koji još nije počeo (prva "slobodna za izmene" stavka); bez sidra 0. */
  ff: number;
}

/** Gde ide nova stavka: u slobodno vreme (`off` minuta od njegovog početka) ili na šav pre stavke `at`. */
export type InsertSpec = { mode: 'free'; freeId: ItemId; off: number } | { mode: 'seam'; at: number };

/**
 * Mesto na koje stavka može da se premesti (režim "Premesti", tastatura, testovi). `start` = novi početak stavke;
 * null samo kad se premešteno slobodno vreme spoji sa susednim slobodnim vremenom (više nema svoj id).
 */
export type MoveTarget =
  | { kind: 'free'; freeId: ItemId; j: number; off: number; next: StackItem[]; start: number | null }
  | { kind: 'seam'; k: number; next: StackItem[]; start: number | null };

/** Polja bloka koja se menjaju bez pomeranja vremena (preimenovanje, kategorija, ocena, beleška). */
export type BlockFields = Partial<Pick<StackBlock, 'title' | 'categoryId' | 'status' | 'actualMin' | 'note'>>;

export interface StackOptions {
  /** Mreža (podrazumevano SNAP_MIN). */
  snap?: number;
  /** Najkraći blok (podrazumevano MIN_BLOCK_MIN). */
  minDur?: number;
  /** Generator klijentskih id-jeva (testovi); podrazumevano `newItemId`. */
  newId?: (prefix: 'n' | 'f') => string;
}

// ======================= Id-jevi i stavke =======================

let seq = 0;

/** Nov klijentski id: 'n…' za blok, 'f…' za slobodno vreme. Jedinstven za ceo život stranice (zajednički brojač). */
export function newItemId(prefix: 'n' | 'f' = 'n'): string {
  seq += 1;
  return `${prefix}${seq}`;
}

/** Nov blok (podrazumevano bez kategorije, 'pending', bez stvarnog vremena i beleške). */
export function makeBlock(p: {
  id?: ItemId;
  title: string;
  dur: number;
  categoryId?: number | null;
  status?: BlockStatus;
  actualMin?: number | null;
  note?: string;
}): StackBlock {
  return {
    kind: 'block',
    id: p.id ?? newItemId('n'),
    title: p.title,
    categoryId: p.categoryId ?? null,
    dur: p.dur,
    status: p.status ?? 'pending',
    actualMin: p.actualMin ?? null,
    note: p.note ?? '',
  };
}

export function makeFree(dur: number, id: ItemId = newItemId('f')): StackFree {
  return { kind: 'free', id, dur };
}

export const isBlock = (c: StackItem | undefined): c is StackBlock => c?.kind === 'block';
export const isFree = (c: StackItem | undefined): c is StackFree => c?.kind === 'free';

/** Okvir logičkog dana za dati početak dana. */
export function frameOf(dayStart: number): Frame {
  return { start: dayStart, end: dayStart + DAY_MIN };
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// ======================= Model =======================

export type BlockStackModel = ReturnType<typeof createBlockStack>;

/**
 * Model vezan za okvir dana (`dayStart` ili `Frame` iz `fromBlocks`). Funkcije su čiste; jedino stanje je
 * generator id-jeva za nove stavke.
 */
export function createBlockStack(frameOrDayStart: Frame | number, opts: StackOptions = {}) {
  const frame: Frame = typeof frameOrDayStart === 'number' ? frameOf(frameOrDayStart) : { ...frameOrDayStart };
  const LEN = frame.end - frame.start;
  const SNAP = opts.snap ?? SNAP_MIN;
  const MIN = opts.minDur ?? MIN_BLOCK_MIN;
  const nid = opts.newId ?? newItemId;

  const total = (l: Stack): number => l.reduce((s, c) => s + c.dur, 0);
  const startsOf = (l: Stack): number[] => {
    const out = new Array<number>(l.length);
    let t = frame.start;
    for (let i = 0; i < l.length; i++) {
      out[i] = t;
      t += l[i].dur;
    }
    return out;
  };
  const idxOf = (l: Stack, id: ItemId): number => l.findIndex((c) => c.id === id);
  const startOf = (l: Stack, id: ItemId): number | null => {
    const i = idxOf(l, id);
    return i < 0 ? null : startsOf(l)[i];
  };
  /** Sidro za "sada" (null = bez sidra). `Infinity` = ceo dan je prošlost (raniji dan). */
  const anchor = (now: number | null | undefined): Anchor | null =>
    now == null ? null : { now, nows: Math.ceil(now / SNAP) * SNAP };
  /** Potpis rasporeda (isti raspored = isti potpis); za uklanjanje duplih mesta u `moveTargets`. */
  const sig = (l: Stack): string =>
    l.map((c) => (c.kind === 'free' ? `F${c.dur}` : `${typeof c.id}:${c.id}:${c.dur}:${c.status}`)).join('|');

  /** Spaja susedna slobodna vremena, izbacuje prazne stavke i dopunjava dan slobodnim vremenom do kraja okvira. */
  function normalize(list: Stack): StackItem[] {
    const out: StackItem[] = [];
    for (const c of list) {
      if (!(c.dur > 0)) continue;
      const prev = out[out.length - 1];
      if (c.kind === 'free' && prev?.kind === 'free') {
        out[out.length - 1] = { ...prev, dur: prev.dur + c.dur };
        continue;
      }
      out.push(c);
    }
    const last = out[out.length - 1];
    const trailing = last?.kind === 'free' ? (out.pop() as StackFree) : null;
    const body = total(out);
    if (body < LEN) out.push(trailing ? { ...trailing, dur: LEN - body } : makeFree(LEN - body, nid('f')));
    return out;
  }

  /** Svaki blok u ispravnom opsegu (`isValidRange`): početak < 2880, trajanje ≤ 24h. */
  function fits(l: Stack): boolean {
    let t = frame.start;
    for (const c of l) {
      if (c.kind === 'block' && !isValidRange(t, t + c.dur)) return false;
      t += c.dur;
    }
    return true;
  }

  const finish = (l: Stack): StackItem[] | null => {
    const n = normalize(l);
    return fits(n) ? n : null;
  };

  // delta > 0: slobodna vremena od `from` daju vreme; delta < 0: prvo slobodno vreme od `from` raste.
  function absorbIn(l: StackItem[], from: number, delta: number): void {
    if (delta > 0) {
      let rest = delta;
      for (let i = from; i < l.length && rest > 0; i++) {
        const f = l[i];
        if (f.kind !== 'free') continue;
        const take = Math.min(f.dur, rest);
        l[i] = { ...f, dur: f.dur - take };
        rest -= take;
      }
    } else if (delta < 0) {
      for (let i = from; i < l.length; i++) {
        const f = l[i];
        if (f.kind === 'free') {
          l[i] = { ...f, dur: f.dur - delta };
          return;
        }
      }
    }
  }

  /** Pravilo talasa kao čista funkcija (bez normalize): vraća nov niz. */
  function absorb(list: Stack, from: number, delta: number): StackItem[] {
    const l = list.slice();
    absorbIn(l, from, delta);
    return l;
  }

  /**
   * Ogledalo `absorbIn` za gornju ivicu stavke `i`: slobodna vremena pre nje (od najbližeg ka početku dana) daju do
   * `delta` minuta. Danas staje na stavci koja je počela; slobodno vreme daje samo deo posle nows (ako je sada tačno na
   * mreži, posle sledećeg koraka: stavka koja počinje u `now` je već počela). Vraća neupijen ostatak.
   */
  function absorbBeforeIn(l: StackItem[], i: number, delta: number, A: Anchor | null): number {
    const st = startsOf(l);
    const floor = A ? (A.nows > A.now ? A.nows : A.nows + SNAP) : 0;
    let rest = delta;
    for (let k = i - 1; k >= 0 && rest > 0; k--) {
      const f = l[k];
      if (f.kind === 'free') {
        const room = A ? clamp(st[k] + f.dur - Math.max(st[k], floor), 0, f.dur) : f.dur;
        const take = Math.min(room, rest);
        l[k] = { ...f, dur: f.dur - take };
        rest -= take;
      }
      if (A && st[k] <= A.now) break;
    }
    return rest;
  }

  function info(list: Stack, A: Anchor | null): StackInfo {
    const st = startsOf(list);
    let cur = -1;
    let ff = 0;
    if (A) {
      for (let i = 0; i < list.length; i++) {
        if (st[i] <= A.now) {
          ff = i + 1;
          if (A.now < st[i] + list[i].dur) cur = i;
        }
      }
    }
    return { st, cur, ff };
  }

  /** Najraniji pomeraj u slobodnom vremenu `j` od kog sme da počne nešto novo (null = nema mesta). */
  function freeRoom(list: Stack, j: number, A: Anchor | null): number | null {
    const f = list[j];
    if (!f || f.kind !== 'free') return null;
    if (!A) return 0;
    const st = startsOf(list)[j];
    const off = Math.max(0, A.nows - st);
    return off < f.dur ? off : null;
  }

  function pastSig(list: Stack, A: Anchor): Map<ItemId, string> {
    const st = startsOf(list);
    const m = new Map<ItemId, string>();
    list.forEach((c, i) => {
      if (c.kind === 'free' || st[i] > A.now) return;
      const end = st[i] + c.dur;
      m.set(c.id, end <= A.now ? `${st[i]}-${end}` : `${st[i]}+`);
    });
    return m;
  }

  /** Prošlost je netaknuta: počeli blokovi zadržavaju početak (prošli i kraj); ništa novo pre sada; ocenjen ostaje. */
  function pastOk(prev: Stack, next: Stack, A: Anchor | null): boolean {
    if (!A) return true;
    const p = pastSig(prev, A);
    const n = pastSig(next, A);
    for (const [id, s] of n) if (p.get(id) !== s) return false;
    for (const [id] of p) {
      const c = prev[idxOf(prev, id)];
      const j = idxOf(next, id);
      // Ocenjen blok ne sme da napusti prošlost. Sme da bude obrisan: tada je na njegovom mestu slobodno vreme sa
      // istim id-jem (prototip je to greškom odbijao).
      if (c.kind === 'block' && c.status !== 'pending' && !n.has(id) && j >= 0 && next[j].kind === 'block') return false;
    }
    return true;
  }

  const isTrailing = (list: Stack, i: number): boolean => list[i]?.kind === 'free' && i === list.length - 1;

  /** Stavka sme da se podigne (prevuče / premesti). */
  function canLift(list: Stack, i: number, A: Anchor | null): boolean {
    const c = list[i];
    if (!c || isTrailing(list, i)) return false;
    if (!A) return true;
    if (i >= info(list, A).ff) return true;
    return c.kind === 'block' && c.status === 'pending';
  }

  /** Stavci sme da se menja trajanje (budući blok / slobodno vreme, ili tekuća stavka). */
  function canResize(list: Stack, i: number, A: Anchor | null): boolean {
    const c = list[i];
    if (!c || isTrailing(list, i)) return false;
    if (!A) return true;
    const { cur, ff } = info(list, A);
    return i >= ff || i === cur;
  }

  /** Bloku sme da se menja početak (gornja ručica): samo blok koji još nije počeo. */
  function canResizeStart(list: Stack, i: number, A: Anchor | null): boolean {
    if (list[i]?.kind !== 'block') return false;
    return !A || i >= info(list, A).ff;
  }

  /** Najkraće trajanje stavke `i`: tekuća ne može da se završi pre nows. */
  function minDurAt(list: Stack, i: number, A: Anchor | null): number {
    if (!A) return MIN;
    const { st, cur } = info(list, A);
    return i === cur ? Math.max(MIN, A.nows - st[i]) : MIN;
  }

  // ---------------- Operacije ----------------

  /**
   * Novo trajanje stavke; razliku upija prvo sledeće slobodno vreme. Stvarno vreme duže od novog trajanja se briše
   * (isto pravilo kao na serveru).
   */
  function opResize(list: Stack, id: ItemId, dur: number): StackItem[] | null {
    const i = idxOf(list, id);
    if (i < 0 || !Number.isInteger(dur) || dur <= 0 || dur > DAY_MIN) return null;
    const c = list[i];
    const d = dur - c.dur;
    if (!d) return null;
    const l = list.slice();
    l[i] = c.kind === 'block' && c.actualMin != null && c.actualMin > dur ? { ...c, dur, actualMin: null } : { ...c, dur };
    absorbIn(l, i + 1, d);
    return finish(l);
  }

  /**
   * Trajanje posle koraka `delta` ("Kraće"/"Duže", Shift+↑↓): kraj bloka se poravnava na mrežu (naviše za kraće,
   * naniže za duže), najmanje `minDurAt`, najviše 24h. Slobodno vreme: ±delta, MIN..24h. null = ne sme.
   */
  function stepDur(list: Stack, id: ItemId, delta: number, A: Anchor | null): number | null {
    const i = idxOf(list, id);
    if (i < 0 || !delta || !canResize(list, i, A)) return null;
    const c = list[i];
    if (c.kind === 'free') return clamp(c.dur + delta, MIN, DAY_MIN);
    const st = startsOf(list)[i];
    let end = st + c.dur + delta;
    end = delta > 0 ? Math.floor(end / SNAP) * SNAP : Math.ceil(end / SNAP) * SNAP;
    return clamp(end - st, minDurAt(list, i, A), DAY_MIN);
  }

  function opResizeBy(list: Stack, id: ItemId, delta: number, A: Anchor | null): StackItem[] | null {
    const dur = stepDur(list, id, delta, A);
    return dur == null ? null : opResize(list, id, dur);
  }

  /**
   * Najraniji i najkasniji početak bloka za gornju ručicu (kraj ostaje): najranije koliko slobodnog vremena pre njega
   * sme da se potroši, najkasnije kraj − MIN. null = početak ne sme da se menja.
   */
  function startRange(list: Stack, id: ItemId, A: Anchor | null): { min: number; max: number } | null {
    const i = idxOf(list, id);
    if (i < 0 || !canResizeStart(list, i, A)) return null;
    const st = startsOf(list)[i];
    const end = st + list[i].dur;
    const room = LEN - absorbBeforeIn(list.slice(), i, LEN, A);
    return { min: Math.max(st - room, end - DAY_MIN), max: Math.max(st, end - MIN) };
  }

  /**
   * Nov početak bloka, kraj ostaje (gornja ručica). Raniji: prvo se troši slobodno vreme odmah pre bloka, pa se ranije
   * stavke guraju ranije do slobodnog vremena koje upija razliku (nikad pre početka okvira; danas ništa što je počelo
   * i ništa pre nows). Kasniji: pre bloka ostaje slobodno vreme. Stvarno vreme duže od novog trajanja se briše.
   */
  function opResizeStart(list: Stack, id: ItemId, start: number, A: Anchor | null): StackItem[] | null {
    const i = idxOf(list, id);
    if (i < 0 || !Number.isInteger(start) || !canResizeStart(list, i, A)) return null;
    const c = list[i] as StackBlock;
    const d = startsOf(list)[i] - start;
    const dur = c.dur + d;
    if (!d || (d < 0 && dur < MIN) || dur > DAY_MIN) return null;
    const l = list.slice();
    l[i] = c.actualMin != null && c.actualMin > dur ? { ...c, dur, actualMin: null } : { ...c, dur };
    if (d > 0) {
      if (absorbBeforeIn(l, i, d, A) > 0) return null;
    } else l.splice(i, 0, makeFree(-d, nid('f')));
    const next = finish(l);
    return next && pastOk(list, next, A) ? next : null;
  }

  /** "Završi sad": tekući blok se završava u nows, sledeće stavke idu ranije. */
  function opEndNow(list: Stack, id: ItemId, A: Anchor | null): StackItem[] | null {
    if (!A) return null;
    const i = idxOf(list, id);
    const c = list[i];
    if (!c || c.kind !== 'block' || i !== info(list, A).cur) return null;
    const dur = minDurAt(list, i, A);
    return dur >= c.dur ? null : opResize(list, id, dur);
  }

  /**
   * Premesti stavku `id` ispred `list[k]` (k = 0..n u indeksima trenutnog niza). Počet blok bez ocene napušta
   * prošlost: prošao ostavlja slobodno vreme svoje dužine, tekući ostavlja slobodno vreme od početka do nows (ostatak
   * dana ide ranije, do nows); premešten blok postaje 'pending'.
   */
  function opMoveTo(list: Stack, id: ItemId, k: number, A: Anchor | null): StackItem[] | null {
    const from = idxOf(list, id);
    if (from < 0 || !Number.isInteger(k) || k < 0 || k > list.length) return null;
    const c = list[from];
    const { st, cur, ff } = info(list, A);
    if (A && from < ff) {
      if (c.kind === 'free' || k < ff) return null;
      const keep = from === cur ? Math.min(c.dur, Math.max(0, A.nows - st[from])) : c.dur;
      const l = list.slice();
      l[from] = makeFree(keep, nid('f'));
      l.splice(k, 0, { ...c, status: 'pending', actualMin: null });
      absorbIn(l, k + 1, keep);
      return finish(l);
    }
    if (A && k < ff) return null;
    const to = k > from ? k - 1 : k;
    if (to === from) return null;
    const l = list.slice();
    l.splice(from, 1);
    l.splice(to, 0, c);
    return finish(l);
  }

  /** Jedno mesto gore (dir −1) ili dole (dir +1) — Alt+↑↓. */
  function opMoveBy(list: Stack, id: ItemId, dir: -1 | 1, A: Anchor | null): StackItem[] | null {
    const i = idxOf(list, id);
    if (i < 0) return null;
    return opMoveTo(list, id, dir < 0 ? i - 1 : i + 2, A);
  }

  function placeInto(l: StackItem[], freeId: ItemId, off: number, item: StackItem): StackItem[] | null {
    const j = idxOf(l, freeId);
    const f = l[j];
    if (j < 0 || f.kind !== 'free' || !Number.isFinite(off)) return null;
    off = Math.max(0, Math.min(off, f.dur));
    const after = f.dur - off - item.dur;
    const parts: StackItem[] = [];
    if (off > 0) parts.push({ ...f, dur: off });
    parts.push(item);
    if (after > 0) parts.push(makeFree(after, off > 0 ? nid('f') : f.id));
    l.splice(j, 1, ...parts);
    if (after < 0) absorbIn(l, j + parts.length, -after);
    return finish(l);
  }

  /**
   * Blok u slobodno vreme `freeId`, `off` minuta od njegovog početka. Staro mesto postaje slobodno; ništa drugo se ne
   * pomera (osim ako je blok duži od slobodnog vremena: višak gura stavke do sledećeg slobodnog vremena).
   */
  function opPlace(list: Stack, id: ItemId, freeId: ItemId, off: number, A: Anchor | null): StackItem[] | null {
    const i = idxOf(list, id);
    const c = list[i];
    if (i < 0 || freeId === id || c.kind !== 'block') return null;
    const started = !!A && startsOf(list)[i] <= A.now;
    const l = list.slice();
    l[i] = makeFree(c.dur, nid('f'));
    return placeInto(l, freeId, off, started ? { ...c, status: 'pending', actualMin: null } : c);
  }

  /** Nova stavka u slobodno vreme; ništa se ne pomera ako stane. */
  function opInsertInFree(list: Stack, freeId: ItemId, off: number, item: StackItem): StackItem[] | null {
    if (idxOf(list, item.id) >= 0 || !(item.dur > 0)) return null;
    return placeInto(list.slice(), freeId, off, item);
  }

  /** Nova stavka na šav pre `list[at]`; stavke posle nje se guraju do prvog slobodnog vremena. */
  function opInsert(list: Stack, at: number, item: StackItem): StackItem[] | null {
    if (!Number.isInteger(at) || at < 0 || at > list.length || idxOf(list, item.id) >= 0 || !(item.dur > 0)) return null;
    const l = list.slice();
    l.splice(at, 0, item);
    absorbIn(l, at + 1, item.dur);
    return finish(l);
  }

  /** Nova stavka po `InsertSpec` (list "Novi blok"). */
  function opInsertAt(list: Stack, spec: InsertSpec, item: StackItem): StackItem[] | null {
    return spec.mode === 'free' ? opInsertInFree(list, spec.freeId, spec.off, item) : opInsert(list, spec.at, item);
  }

  /**
   * Podrazumevano mesto novog bloka ("+" u traci, N): danas u tekuće slobodno vreme od nows, ili posle tekuće stavke;
   * bez sidra u slobodno vreme na kraju (ili na kraj dana).
   */
  function defaultInsertSpec(list: Stack, A: Anchor | null): InsertSpec {
    if (A) {
      const { cur, ff } = info(list, A);
      const c = list[cur];
      if (c?.kind === 'free') {
        const room = freeRoom(list, cur, A);
        if (room != null) return { mode: 'free', freeId: c.id, off: room };
      }
      const n = list[ff];
      if (n?.kind === 'free') return { mode: 'free', freeId: n.id, off: 0 };
      return { mode: 'seam', at: Math.min(ff, list.length) };
    }
    const last = list[list.length - 1];
    return last?.kind === 'free' ? { mode: 'free', freeId: last.id, off: 0 } : { mode: 'seam', at: list.length };
  }

  /**
   * Priprema list "Novi blok": u slobodnom vremenu pomeraj ide na [nows, kraj − MIN], trajanje = min(1h, ostatak
   * slobodnog vremena) na mreži (MIN..3h); na šavu 1h. null = tu ne sme ništa novo (prošlost).
   */
  function prepareInsert(list: Stack, spec: InsertSpec, A: Anchor | null): { spec: InsertSpec; dur: number } | null {
    if (spec.mode === 'free') {
      const j = idxOf(list, spec.freeId);
      const f = list[j];
      if (!f || f.kind !== 'free') return null;
      const room = freeRoom(list, j, A);
      if (room == null) return null;
      const off = clamp(Math.round(spec.off), room, Math.max(room, f.dur - MIN));
      const dur = clamp(Math.floor(Math.min(60, f.dur - off) / SNAP) * SNAP, MIN, 180);
      return { spec: { mode: 'free', freeId: f.id, off }, dur };
    }
    if (!Number.isInteger(spec.at) || spec.at < 0 || spec.at > list.length) return null;
    if (A && spec.at < info(list, A).ff) return null;
    return { spec, dur: 60 };
  }

  /** Izmena polja bloka (vreme se ne menja). */
  function opUpdate(list: Stack, id: ItemId, patch: BlockFields): StackItem[] | null {
    const i = idxOf(list, id);
    const c = list[i];
    if (!c || c.kind !== 'block') return null;
    const l = list.slice();
    l[i] = { ...c, ...patch };
    return l;
  }

  /**
   * Ocena (✓ ◐ ✕): isti status ponovo = nazad na 'pending'. 'pending' i 'skipped' brišu stvarno vreme. Ne menja
   * redosled ni vreme.
   */
  function opRate(list: Stack, id: ItemId, status: Exclude<BlockStatus, 'pending'>): StackItem[] | null {
    const c = list[idxOf(list, id)];
    if (!c || c.kind !== 'block') return null;
    const next: BlockStatus = c.status === status ? 'pending' : status;
    return opUpdate(list, id, {
      status: next,
      actualMin: next === 'pending' || next === 'skipped' ? null : c.actualMin,
    });
  }

  /** Blok postaje slobodno vreme na istom mestu (isti id); ništa se ne pomera. */
  function opDelete(list: Stack, id: ItemId): StackItem[] | null {
    const i = idxOf(list, id);
    const c = list[i];
    if (!c || c.kind !== 'block') return null;
    const l = list.slice();
    l[i] = makeFree(c.dur, c.id);
    return finish(l);
  }

  /** Slobodno vreme koje posle brisanja (i spajanja sa susedima) pokriva minut `at` — za "Zatvori prazninu". */
  function freeAt(list: Stack, at: number): StackFree | null {
    const st = startsOf(list);
    const k = list.findIndex((c, i) => c.kind === 'free' && st[i] <= at && at < st[i] + c.dur);
    return k < 0 ? null : (list[k] as StackFree);
  }

  /** Zatvara prazninu: stavke posle nje idu ranije (danas ne pre nows; tekuća praznina se skraćuje do nows). */
  function opCloseGap(list: Stack, id: ItemId, A: Anchor | null): StackItem[] | null {
    const j = idxOf(list, id);
    const f = list[j];
    if (j < 0 || f.kind !== 'free' || j === list.length - 1) return null;
    const st = startsOf(list)[j];
    let keep = 0;
    if (A) {
      if (st + f.dur <= A.now) return null;
      keep = Math.max(0, A.nows - st);
      if (keep >= f.dur) return null;
    }
    const delta = f.dur - keep;
    const l = list.slice();
    if (keep > 0) l[j] = { ...f, dur: keep };
    else l.splice(j, 1);
    absorbIn(l, keep > 0 ? j + 1 : j, -delta);
    return finish(l);
  }

  /**
   * Deli blok na rezovima `cuts` (minuti od početka bloka, rastući, svaki deo ≥ MIN). Pravilo kao na serveru:
   * prvi deo zadržava id, status i belešku (stvarno vreme se briše ako je duže od dela); ostali delovi su novi
   * nezavisni blokovi sa istim nazivom i kategorijom, 'pending', bez stvarnog vremena i beleške. Vreme se ne pomera.
   */
  function opSplit(list: Stack, id: ItemId, cuts: readonly number[]): { list: StackItem[]; ids: ItemId[] } | null {
    const i = idxOf(list, id);
    const c = list[i];
    if (!c || c.kind !== 'block' || cuts.length === 0) return null;
    const pts = [0, ...cuts, c.dur];
    const pieces: StackBlock[] = [];
    for (let k = 0; k < pts.length - 1; k++) {
      const dur = pts[k + 1] - pts[k];
      if (!Number.isInteger(pts[k + 1]) || dur < MIN) return null;
      pieces.push(
        k === 0
          ? { ...c, dur, actualMin: c.actualMin != null && c.actualMin > dur ? null : c.actualMin }
          : { ...c, id: nid('n'), dur, status: 'pending', actualMin: null, note: '' },
      );
    }
    const l = list.slice();
    l.splice(i, 1, ...pieces);
    return { list: normalize(l), ids: pieces.map((p) => p.id) };
  }

  /**
   * `n` jednakih delova na mreži: floor(slotova / n), ostatak ide prvim delovima (70m / 3 = 25 + 25 + 20); minuti van
   * mreže idu poslednjem delu. null = blok je prekratak (svaki deo bar jedan korak mreže).
   */
  function cuts15(dur: number, n: number): number[] | null {
    const slots = Math.floor(dur / SNAP);
    if (!Number.isInteger(n) || n < 2 || slots < n) return null;
    const base = Math.floor(slots / n);
    const rem = slots % n;
    const out: number[] = [];
    let acc = 0;
    for (let k = 0; k < n - 1; k++) {
      acc += (base + (k < rem ? 1 : 0)) * SNAP;
      out.push(acc);
    }
    return out;
  }

  /** Rez na mreži: `raw` minuta od početka bloka koji počinje u `blockStart` → najbliži minut na mreži dana. */
  const snapCut = (blockStart: number, raw: number): number => Math.round((blockStart + raw) / SNAP) * SNAP - blockStart;

  /** Dodaje rez (bar MIN od krajeva i od drugih rezova); null = tu ne može. */
  function cutAdd(dur: number, cuts: readonly number[], m: number): number[] | null {
    if (!Number.isInteger(m) || m < MIN || m > dur - MIN || cuts.some((x) => Math.abs(x - m) < MIN)) return null;
    return [...cuts, m].sort((a, b) => a - b);
  }

  /** Pomera rez `k` na `m`, ograničeno susednim rezovima (bar MIN razmaka) i krajevima bloka. */
  function cutMove(dur: number, cuts: readonly number[], k: number, m: number): number[] {
    const sorted = [...cuts].sort((a, b) => a - b);
    if (k < 0 || k >= sorted.length) return sorted;
    const lo = k > 0 ? sorted[k - 1] + MIN : MIN;
    const hi = k < sorted.length - 1 ? sorted[k + 1] - MIN : dur - MIN;
    if (lo > hi) return sorted;
    sorted[k] = clamp(Math.round(m), lo, hi);
    return sorted;
  }

  /** Blok klizi jedan korak mreže kroz susedno slobodno vreme (dir −1 gore, +1 dole); ništa drugo se ne pomera. */
  function opNudge(list: Stack, id: ItemId, dir: -1 | 1): StackItem[] | null {
    const i = idxOf(list, id);
    const c = list[i];
    const n = list[i + dir];
    if (i < 0 || c.kind !== 'block' || !n || n.kind !== 'free') return null;
    const step = Math.min(SNAP, n.dur);
    const l = list.slice();
    l[i + dir] = { ...n, dur: n.dur - step };
    l.splice(dir < 0 ? i + 1 : i, 0, makeFree(step, nid('f')));
    return finish(l);
  }

  /** Sva mesta na koja stavka može da ode, bez duplikata po rezultatu, po vremenu početka. */
  function moveTargets(list: Stack, id: ItemId, A: Anchor | null): MoveTarget[] {
    const i = idxOf(list, id);
    if (i < 0 || !canLift(list, i, A)) return [];
    const out: MoveTarget[] = [];
    const seen = new Set([sig(list)]);
    const push = (t: MoveTarget) => {
      if (!pastOk(list, t.next, A)) return;
      const s = sig(t.next);
      if (seen.has(s)) return;
      seen.add(s);
      out.push(t);
    };
    if (list[i].kind === 'block') {
      list.forEach((f, j) => {
        if (f.kind !== 'free' || j === i) return;
        const off = freeRoom(list, j, A);
        if (off == null) return;
        const next = opPlace(list, id, f.id, off, A);
        if (next) push({ kind: 'free', freeId: f.id, j, off, next, start: startOf(next, id) });
      });
    }
    for (let k = 0; k <= list.length; k++) {
      // Šav ispred slobodnog vremena koje je već cilj: isti početak kao "u slobodno vreme".
      if (list[i].kind === 'block' && list[k]?.kind === 'free' && out.some((t) => t.kind === 'free' && t.j === k)) continue;
      const next = opMoveTo(list, id, k, A);
      if (!next) continue;
      push({ kind: 'seam', k, next, start: startOf(next, id) });
    }
    return out.sort((a, b) => (a.start ?? 0) - (b.start ?? 0) || (a.kind === 'free' ? -1 : 1));
  }

  /** Blokovi (osim `exceptId`) kojima se promenio početak: { id, d = pomak u minutima }. */
  function movedBlocks(prev: Stack, next: Stack, exceptId?: ItemId): Array<{ id: ItemId; d: number }> {
    const ps = startsOf(prev);
    const before = new Map<ItemId, number>();
    prev.forEach((c, i) => {
      if (c.kind === 'block') before.set(c.id, ps[i]);
    });
    const ns = startsOf(next);
    const out: Array<{ id: ItemId; d: number }> = [];
    next.forEach((c, i) => {
      if (c.kind !== 'block' || c.id === exceptId) return;
      const b = before.get(c.id);
      if (b !== undefined && ns[i] !== b) out.push({ id: c.id, d: ns[i] - b });
    });
    return out;
  }

  /** Blokovi koji počinju posle kraja dana (upozorenje "Posle kraja dana: …"). */
  function overflowing(list: Stack): StackBlock[] {
    const st = startsOf(list);
    return list.filter((c, i): c is StackBlock => c.kind === 'block' && st[i] >= frame.end);
  }

  return {
    frame,
    LEN,
    SNAP,
    MIN,
    nid,
    total,
    startsOf,
    idxOf,
    startOf,
    anchor,
    sig,
    normalize,
    fits,
    absorb,
    info,
    freeRoom,
    pastOk,
    isTrailing,
    canLift,
    canResize,
    canResizeStart,
    minDurAt,
    opResize,
    stepDur,
    opResizeBy,
    startRange,
    opResizeStart,
    opEndNow,
    opMoveTo,
    opMoveBy,
    opPlace,
    opInsertInFree,
    opInsert,
    opInsertAt,
    defaultInsertSpec,
    prepareInsert,
    opUpdate,
    opRate,
    opDelete,
    freeAt,
    opCloseGap,
    opSplit,
    cuts15,
    snapCut,
    cutAdd,
    cutMove,
    opNudge,
    moveTargets,
    movedBlocks,
    overflowing,
  };
}

// ======================= Konverzije (server ↔ niz) =======================

/** Blok dana ili šablona kako stiže sa servera (šablon nema status, stvarno vreme ni belešku). */
export interface BlockLike {
  id: number;
  start: number;
  end: number;
  title: string;
  categoryId: number | null;
  status?: BlockStatus;
  actualMin?: number | null;
  note?: string;
}

export interface FromBlocksResult {
  items: StackItem[];
  /** Okvir: od dayStart (ili ranije, ako sačuvan blok počinje pre dayStart) do dayStart + 24h. */
  frame: Frame;
  /**
   * Preklapanja u podacima (server ih dozvoljava, niz ne može da ih prikaže): parovi id-jeva (`a` počinje ranije).
   * Tada `items` već ima kasniji blok pomeren iza ranijeg (redosled ostaje) — to je raspored posle "Popravi";
   * dok korisnik to ne potvrdi, prikaz ne sme da menja raspored (ocene i detalji rade, PATCH po id-ju).
   */
  overlaps: Array<{ a: number; b: number }>;
}

/**
 * Blokovi sa servera → niz: po start, end, id; razmaci postaju slobodno vreme (i razmak od početka dana), dan se
 * dopunjava do 24h. Poslednji blok sme da pređe kraj dana (preko ponoći). Blok koji počinje pre dayStart (sačuvan pre
 * promene početka dana) pomera početak okvira na sebe — ništa se ne pomera bez korisnika.
 */
export function fromBlocks(
  blocks: readonly BlockLike[],
  dayStart: number,
  opts: Pick<StackOptions, 'newId'> = {},
): FromBlocksResult {
  const nid = opts.newId ?? newItemId;
  const sorted = [...blocks].sort((a, b) => a.start - b.start || a.end - b.end || a.id - b.id);
  const frame: Frame = { start: Math.min(dayStart, sorted[0]?.start ?? dayStart), end: dayStart + DAY_MIN };
  const items: StackItem[] = [];
  const overlaps: Array<{ a: number; b: number }> = [];
  let cursor = frame.start;
  let maxEnd = -Infinity;
  let maxId = 0;
  for (const b of sorted) {
    if (b.start < maxEnd) overlaps.push({ a: maxId, b: b.id });
    if (b.end > maxEnd) {
      maxEnd = b.end;
      maxId = b.id;
    }
    if (b.start > cursor) items.push(makeFree(b.start - cursor, nid('f')));
    const dur = b.end - b.start;
    items.push({
      kind: 'block',
      id: b.id,
      title: b.title,
      categoryId: b.categoryId,
      dur,
      status: b.status ?? 'pending',
      actualMin: b.actualMin ?? null,
      note: b.note ?? '',
    });
    cursor = Math.max(cursor, b.start) + dur;
  }
  return { items: createBlockStack(frame, { newId: nid }).normalize(items), frame, overlaps };
}

export interface ToBlocksResult<T> {
  blocks: T[];
  /** Id-jevi blokova čiji opseg ne bi bio ispravan (`isValidRange`) — takav niz se ne šalje. */
  invalid: ItemId[];
}

/** Uzastopni opsezi blokova niza (slobodno vreme se preskače). */
function layOut(items: Stack, frame: Frame): Array<{ b: StackBlock; start: number; end: number }> {
  const out: Array<{ b: StackBlock; start: number; end: number }> = [];
  let t = frame.start;
  for (const c of items) {
    if (c.kind === 'block') out.push({ b: c, start: t, end: t + c.dur });
    t += c.dur;
  }
  return out;
}

/**
 * Niz → telo za `PUT /api/days/:date/blocks`. Id se šalje samo za blok koji server ima (`confirmed` = blokovi
 * poslednjeg DayPayload-a; bez njega svaki pozitivan id); ostali (novi delovi, blok vraćen poništavanjem brisanja,
 * pregled iz šablona) idu bez id-ja, sa svojim statusom/stvarnim vremenom/beleškom. Za blok koji server ima, status,
 * stvarno vreme i beleška se šalju samo ako se razlikuju od `confirmed` (izmena sa drugog uređaja ostaje).
 */
export function toBlocks(
  items: Stack,
  frame: Frame,
  opts: { confirmed?: readonly Block[] } = {},
): ToBlocksResult<DayBlockInput> {
  const known = opts.confirmed ? new Map(opts.confirmed.map((b) => [b.id, b])) : null;
  const blocks: DayBlockInput[] = [];
  const invalid: ItemId[] = [];
  for (const { b, start, end } of layOut(items, frame)) {
    if (!isValidRange(start, end)) invalid.push(b.id);
    const out: DayBlockInput = { start, end, title: b.title, categoryId: b.categoryId };
    const serverId = typeof b.id === 'number' && b.id > 0 && (!known || known.has(b.id)) ? b.id : null;
    const was = serverId != null ? known?.get(serverId) : undefined;
    if (serverId != null) out.id = serverId;
    if (serverId != null && !known) {
      out.status = b.status;
      out.actualMin = b.actualMin;
      out.note = b.note;
    } else if (was) {
      if (b.status !== was.status) out.status = b.status;
      if (b.actualMin !== was.actualMin) out.actualMin = b.actualMin;
      if (b.note !== was.note) out.note = b.note;
    } else {
      if (b.status !== 'pending') out.status = b.status;
      if (b.actualMin != null) out.actualMin = b.actualMin;
      if (b.note !== '') out.note = b.note;
    }
    blocks.push(out);
  }
  return { blocks, invalid };
}

/** Niz → blokovi šablona za `PUT /api/templates/:id/blocks` (bez id-jeva i ocena; server zamenjuje sve). */
export function toTemplateBlocks(items: Stack, frame: Frame): ToBlocksResult<BlockInput> {
  const blocks: BlockInput[] = [];
  const invalid: ItemId[] = [];
  for (const { b, start, end } of layOut(items, frame)) {
    if (!isValidRange(start, end)) invalid.push(b.id);
    blocks.push({ start, end, title: b.title, categoryId: b.categoryId });
  }
  return { blocks, invalid };
}

// ======================= Provera konflikta (`base`) =======================

/** 53-bitni heš teksta (cyrb53) — isti rezultat u browseru i na serveru. */
function hash53(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * `base` za `PUT /api/days/:date/blocks`: otisak serverske liste blokova na koju se izmena oslanja (id, vreme,
 * status, naziv, kategorija; redosled ulaza nije bitan). Klijent ga računa iz poslednjeg DayPayload-a (pregled =
 * blokovi sa negativnim id-jevima) u trenutku slanja; server iz trenutnog stanja dana — razlika = 409.
 */
export function layoutBase(
  blocks: readonly Pick<Block, 'id' | 'start' | 'end' | 'status' | 'title' | 'categoryId'>[],
): string {
  const rows = [...blocks]
    .sort((a, b) => a.start - b.start || a.end - b.end || a.id - b.id)
    .map((b) => [b.id, b.start, b.end, b.status, b.categoryId, b.title]);
  return `${rows.length}-${hash53(JSON.stringify(rows))}`;
}

/**
 * `base` za `PUT /api/templates/:id/blocks`: otisak SADRŽAJA blokova šablona (vreme, naziv, kategorija; bez id-jeva —
 * server ih pri svakom čuvanju daje ponovo — i bez obzira na redosled). Klijent ga računa iz poslednje verzije
 * šablona sa servera u trenutku slanja; server iz sačuvanih blokova — razlika (izmena sa drugog uređaja) = 409.
 */
export function templateBase(blocks: readonly Pick<BlockInput, 'start' | 'end' | 'title' | 'categoryId'>[]): string {
  const rows = blocks
    .map((b) => [b.start, b.end, b.categoryId ?? -1, b.title] as const)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || (a[3] < b[3] ? -1 : a[3] > b[3] ? 1 : 0));
  return `${rows.length}-${hash53(JSON.stringify(rows))}`;
}

// ======================= Istorija izmena (poništi / ponovi) =======================

/** Snimak prikaza za istoriju: niz i izabrana stavka (poništavanje vraća i izbor). */
export interface StackSnapshot {
  items: Stack;
  sel: ItemId | null;
}

export interface HistoryEntry<S = StackSnapshot> {
  snap: S;
  /** Oznaka za spajanje ponovljenih izmena ('len:<id>', 'nudge:<id>'…); null = ne spaja se. */
  tag: string | null;
  /** Vreme izmene (ms, npr. performance.now()). */
  at: number;
}

export interface History<S = StackSnapshot> {
  past: readonly HistoryEntry<S>[];
  future: readonly HistoryEntry<S>[];
}

export function emptyHistory<S = StackSnapshot>(): History<S> {
  return { past: [], future: [] };
}

/**
 * Upisuje stanje PRE izmene (`prev`). Ista oznaka u roku od 4 s samo produžava poslednji korak (više "Kraće" = jedan
 * korak). Najviše 200 koraka; budućnost (ponovi) se briše.
 */
export function historyRecord<S>(
  h: History<S>,
  prev: S,
  opts: { tag?: string | null; at: number; limit?: number; coalesceMs?: number },
): History<S> {
  const tag = opts.tag ?? null;
  const top = h.past[h.past.length - 1];
  if (tag && top && top.tag === tag && opts.at - top.at < (opts.coalesceMs ?? COALESCE_MS)) {
    return { past: [...h.past.slice(0, -1), { ...top, at: opts.at }], future: [] };
  }
  const past = [...h.past, { snap: prev, tag, at: opts.at }];
  const limit = opts.limit ?? HISTORY_LIMIT;
  return { past: past.length > limit ? past.slice(past.length - limit) : past, future: [] };
}

/** Poništi: vraća prethodni snimak, a trenutni ide u budućnost. null = nema šta. */
export function historyUndo<S>(h: History<S>, current: S): { history: History<S>; snap: S } | null {
  const top = h.past[h.past.length - 1];
  if (!top) return null;
  return {
    history: { past: h.past.slice(0, -1), future: [...h.future, { snap: current, tag: null, at: 0 }] },
    snap: top.snap,
  };
}

/** Ponovi: suprotno od `historyUndo`. */
export function historyRedo<S>(h: History<S>, current: S): { history: History<S>; snap: S } | null {
  const top = h.future[h.future.length - 1];
  if (!top) return null;
  return {
    history: { past: [...h.past, { snap: current, tag: null, at: 0 }], future: h.future.slice(0, -1) },
    snap: top.snap,
  };
}
