// Čiste funkcije za prikaz dana (bez React-a).

import type { Block, Category } from '../../../../shared/types.ts';
import { DAY_MIN } from '../../../../shared/time.ts';
import { blockCounts } from '../../../../shared/summary.ts';

/** Najmanja praznina između blokova koja se prikazuje kao "slobodno". */
export const MIN_GAP = 15;

export type TimelineItem =
  | { kind: 'block'; block: Block; index: number }
  | { kind: 'gap'; start: number; end: number };

/** Blokovi (već sortirani) + praznine >= MIN_GAP između njih. Preklapanja su dozvoljena. */
export function timelineItems(blocks: Block[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  let maxEnd = -Infinity;
  blocks.forEach((b, i) => {
    if (i > 0 && b.start - maxEnd >= MIN_GAP) items.push({ kind: 'gap', start: maxEnd, end: b.start });
    items.push({ kind: 'block', block: b, index: i });
    maxEnd = Math.max(maxEnd, b.end);
  });
  return items;
}

/** Blokovi koji traju u datom minutu (start <= minute < end). */
export function blocksAt(blocks: Block[], minute: number): Block[] {
  return blocks.filter((b) => b.start <= minute && minute < b.end);
}

/** Trenutni blok za "Sada" karticu: od onih koji traju, onaj koji je poslednji počeo. */
export function currentBlock(blocks: Block[], minute: number): Block | null {
  let cur: Block | null = null;
  for (const b of blocks) {
    if (b.start <= minute && minute < b.end && (!cur || b.start >= cur.start)) cur = b;
  }
  return cur;
}

/** Prvi blok koji počinje posle datog minuta. */
export function nextBlock(blocks: Block[], minute: number): Block | null {
  let next: Block | null = null;
  for (const b of blocks) {
    if (b.start > minute && (!next || b.start < next.start)) next = b;
  }
  return next;
}

/**
 * Prošao je, a još nije ocenjen ("čeka ocenu"). Blok čija se kategorija ne računa u ispunjenost
 * (pauza, slobodno vreme) ne čeka ocenu — ne utiče na procenat dana.
 */
export function isDue(b: Block, minute: number, catMap: Map<number, Category>): boolean {
  return b.id > 0 && b.status === 'pending' && b.end <= minute && blockCounts(b, catMap);
}

/** Prošli blokovi koji još nisu ocenjeni. */
export function dueBlocks(blocks: Block[], minute: number, catMap: Map<number, Category>): Block[] {
  return blocks.filter((b) => isDue(b, minute, catMap));
}

/**
 * Predlog vremena za novi blok (do 60 min, nikad preko sledećeg bloka ni kraja dana):
 * - danas (`minute` = logički minut sada): prva slobodna praznina od bar 15 min od sledećeg punog
 *   ili polovine sata — ne prošlo vreme;
 * - inače (ili kad danas više nema mesta): od kraja poslednjeg bloka koji se završava pre kraja
 *   dana (blok koji traje preko kraja dana, npr. noćni do jutra, se preskače);
 * - pa prva praznina od početka dana; prazan dan (osim danas, gore) i pun dan: 09:00–10:00.
 */
export function suggestNewRange(
  blocks: Block[],
  dayStart: number,
  minute: number | null = null,
): { start: number; end: number } {
  const dayEnd = dayStart + DAY_MIN;
  const sorted = [...blocks].sort((a, c) => a.start - c.start || a.end - c.end);

  /** Prvo slobodno mesto od bar MIN_GAP minuta od `from` (preskače blokove koji ga pokrivaju). */
  const gapFrom = (from: number): { start: number; end: number } | null => {
    let cursor = from;
    for (const b of sorted) {
      if (b.end <= cursor) continue;
      if (b.start - cursor >= MIN_GAP) return { start: cursor, end: Math.min(cursor + 60, b.start) };
      cursor = Math.max(cursor, b.end);
    }
    return dayEnd - cursor >= MIN_GAP ? { start: cursor, end: Math.min(cursor + 60, dayEnd) } : null;
  };

  if (minute != null) {
    const now = gapFrom(Math.max(dayStart, Math.ceil(minute / 30) * 30));
    if (now) return now;
  }

  const fallback = { start: 540, end: 600 };
  if (blocks.length === 0) return fallback;
  const ends = blocks.map((b) => b.end).filter((e) => e >= dayStart && e <= dayEnd - MIN_GAP);
  const afterLast = ends.length > 0 ? gapFrom(Math.max(...ends)) : null;
  return afterLast ?? gapFrom(dayStart) ?? fallback;
}

/**
 * Zidno vreme (0..1439) → minut unutar bloka [start, end] (blok može da prelazi ponoć).
 * null ako vreme nije strogo unutar bloka.
 */
export function clockInside(clock: number, start: number, end: number): number | null {
  for (let at = clock; at < end; at += DAY_MIN) {
    if (at > start) return at;
  }
  return null;
}

/** Glatko pomeranje do elementa (bez animacije kad korisnik to ne želi). */
export function scrollToEl(el: Element | null) {
  if (!el) return;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  el.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
}
