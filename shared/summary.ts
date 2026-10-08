// Računanje ispunjenosti dana. Isti kod koriste server (statistika) i klijent
// (trenutni prikaz dana posle optimističkih izmena).

import type { Block, BlockSummary, Category, CategoryTime } from './types.ts';
import { addDays } from './time.ts';

export function blockDuration(b: Pick<Block, 'start' | 'end'>): number {
  return Math.max(0, b.end - b.start);
}

/** Odrađeni minuti bloka: done = actualMin ?? ceo blok, partial = actualMin ?? pola, ostalo 0. */
export function blockDoneMin(b: Pick<Block, 'start' | 'end' | 'status' | 'actualMin'>): number {
  const dur = blockDuration(b);
  if (b.status === 'done') return b.actualMin ?? dur;
  if (b.status === 'partial') return b.actualMin ?? Math.round(dur / 2);
  return 0;
}

/** Bodovi bloka: done = 1, partial = 0.5, ostalo 0. */
export function blockCredit(b: Pick<Block, 'status'>): number {
  if (b.status === 'done') return 1;
  if (b.status === 'partial') return 0.5;
  return 0;
}

/** Blok se računa u ispunjenost ako nema kategoriju ili mu kategorija ima counts = true. */
export function blockCounts(b: Pick<Block, 'categoryId'>, categories: Map<number, Category> | Category[]): boolean {
  if (b.categoryId == null) return true;
  const cat = Array.isArray(categories) ? categories.find((c) => c.id === b.categoryId) : categories.get(b.categoryId);
  return cat ? cat.counts : true;
}

export function sortBlocks<T extends Pick<Block, 'start' | 'end' | 'id'>>(blocks: T[]): T[] {
  return [...blocks].sort((a, b) => a.start - b.start || a.end - b.end || a.id - b.id);
}

export function summarizeBlocks(blocks: Block[], categories: Category[]): BlockSummary {
  const catMap = new Map(categories.map((c) => [c.id, c]));
  const byCat = new Map<number | null, CategoryTime>();
  let counted = 0;
  let done = 0;
  let partial = 0;
  let skipped = 0;
  let pending = 0;
  let plannedMin = 0;
  let doneMin = 0;

  for (const b of blocks) {
    const dur = blockDuration(b);
    const dm = blockDoneMin(b);
    const key = b.categoryId != null && catMap.has(b.categoryId) ? b.categoryId : null;
    let ct = byCat.get(key);
    if (!ct) {
      ct = { categoryId: key, plannedMin: 0, doneMin: 0, plannedCount: 0, doneCount: 0 };
      byCat.set(key, ct);
    }
    ct.plannedMin += dur;
    ct.doneMin += dm;
    ct.plannedCount += 1;
    ct.doneCount += blockCredit(b);

    if (!blockCounts(b, catMap)) continue;
    counted += 1;
    plannedMin += dur;
    doneMin += dm;
    if (b.status === 'done') done += 1;
    else if (b.status === 'partial') partial += 1;
    else if (b.status === 'skipped') skipped += 1;
    else pending += 1;
  }

  return {
    score: counted > 0 ? (done + 0.5 * partial) / counted : null,
    counted,
    done,
    partial,
    skipped,
    pending,
    plannedMin,
    doneMin,
    categories: [...byCat.values()].sort((a, b) => b.plannedMin - a.plannedMin),
  };
}

/** Sabira CategoryTime nizove (npr. za nedelju). */
export function mergeCategoryTimes(lists: CategoryTime[][]): CategoryTime[] {
  const map = new Map<number | null, CategoryTime>();
  for (const list of lists) {
    for (const ct of list) {
      const cur = map.get(ct.categoryId);
      if (cur) {
        cur.plannedMin += ct.plannedMin;
        cur.doneMin += ct.doneMin;
        cur.plannedCount += ct.plannedCount;
        cur.doneCount += ct.doneCount;
      } else {
        map.set(ct.categoryId, { ...ct });
      }
    }
  }
  return [...map.values()].sort((a, b) => b.plannedMin - a.plannedMin);
}

/**
 * Niz uzastopnih dana sa score >= threshold, unazad od `to`.
 * Ako `to` još traje (`toInProgress`, obično danas), ne prekida niz dok nije dostigao prag —
 * tada se kreće od juče. Za završen period (`toInProgress = false`) i `to` se računa normalno.
 * `scores`: mapa datum → score (null/odsutno = dan nije praćen ili nema blokova).
 */
export function computeStreak(
  scores: Map<string, number | null>,
  to: string,
  threshold: number,
  toInProgress = true,
): number {
  const ok = (d: string) => {
    const s = scores.get(d);
    return s != null && s >= threshold;
  };
  let d = ok(to) || !toInProgress ? to : addDays(to, -1);
  let n = 0;
  while (ok(d)) {
    n += 1;
    d = addDays(d, -1);
  }
  return n;
}
