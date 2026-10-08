// Pomoćne funkcije za stranicu Raspored (bez React-a).

import type { Category, SchedulePayload, Weekday, WeekdayMap } from '../../../../shared/types.ts';
import { WEEKDAY_NAMES } from '../../../../shared/time.ts';

export const WEEKDAYS: Weekday[] = [1, 2, 3, 4, 5, 6, 7];

// Ograničenja iz API-ja (SPEC 5 — Raspored).
export const MAX_TEMPLATE_BLOCKS = 100;
export const TEMPLATE_NAME_MAX = 60;
export const CATEGORY_NAME_MAX = 40;
export const BLOCK_TITLE_MAX = 120;

// Paleta je zajednička (i izbor kategorije u sheet-u bloka/zadatka pravi kategoriju u hodu).
export { PALETTE, nextFreeColor, sameColor } from '../../lib/palette.ts';

/** Srpska množina: 1 blok, 2 bloka, 5 blokova, 11 blokova, 21 blok. */
export function plural(n: number, one: string, few: string, many: string): string {
  const n10 = Math.abs(n) % 10;
  const n100 = Math.abs(n) % 100;
  if (n10 === 1 && n100 !== 11) return one;
  if (n10 >= 2 && n10 <= 4 && (n100 < 12 || n100 > 14)) return few;
  return many;
}

export function blocksLabel(n: number): string {
  return `${n} ${plural(n, 'blok', 'bloka', 'blokova')}`;
}

/** Dani u nedelji kojima je dodeljen šablon. */
export function weekdaysUsing(weekdays: WeekdayMap, templateId: number): Weekday[] {
  return WEEKDAYS.filter((w) => weekdays[w] === templateId);
}

/** ["a", "b", "c"] → "a, b i c" */
export function joinAnd(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} i ${items[items.length - 1]}`;
}

/** "ponedeljak, utorak i petak" */
export function weekdayList(days: Weekday[]): string {
  return joinAnd(days.map((d) => WEEKDAY_NAMES[d - 1]));
}

/** Najveći id u listi (novi šablon je onaj sa najvećim id-jem). */
export function maxId(list: Array<{ id: number }>): number | null {
  let max: number | null = null;
  for (const x of list) if (max == null || x.id > max) max = x.id;
  return max;
}

/** Naziv kopije: "X (kopija)", skraćen da stane u ograničenje dužine. */
export function copyName(name: string): string {
  const suffix = ' (kopija)';
  return `${name.slice(0, TEMPLATE_NAME_MAX - suffix.length).trimEnd()}${suffix}`;
}

export function roundTo5(min: number): number {
  return Math.round(min / 5) * 5;
}

export interface PlanRow {
  categoryId: number | null;
  category: Category | null;
  minutes: number;
}

export interface WeeklyPlan {
  /** Zbir po kategoriji za celu nedelju, opadajuće. */
  rows: PlanRow[];
  /** Broj dana u nedelji koji imaju šablon. */
  plannedDays: number;
  /** Ukupno planirano u nedelji. */
  totalMin: number;
  /** Kategorije koje se računaju u ispunjenost (i blokovi bez kategorije, kao u shared/summary.ts). */
  countedMin: number;
  /** Kategorije koje se ne računaju u ispunjenost. */
  uncountedMin: number;
}

/** Planirani minuti po kategoriji iz mapiranja dan u nedelji → šablon. */
export function weeklyPlan(data: SchedulePayload): WeeklyPlan {
  const tplMap = new Map(data.templates.map((t) => [t.id, t]));
  const catMap = new Map(data.categories.map((c) => [c.id, c]));
  const totals = new Map<number | null, number>();
  let plannedDays = 0;

  for (const w of WEEKDAYS) {
    const tid = data.weekdays[w];
    const tpl = tid != null ? tplMap.get(tid) : undefined;
    if (!tpl) continue;
    plannedDays += 1;
    for (const b of tpl.blocks) {
      const key = b.categoryId != null && catMap.has(b.categoryId) ? b.categoryId : null;
      totals.set(key, (totals.get(key) ?? 0) + Math.max(0, b.end - b.start));
    }
  }

  const rows: PlanRow[] = [...totals.entries()]
    .filter(([, min]) => min > 0)
    .map(([id, minutes]) => ({ categoryId: id, category: id != null ? (catMap.get(id) ?? null) : null, minutes }))
    .sort((a, b) => b.minutes - a.minutes);

  let countedMin = 0;
  let uncountedMin = 0;
  for (const r of rows) {
    // Blok bez kategorije se računa (isto pravilo kao shared/summary.ts).
    if (!r.category || r.category.counts) countedMin += r.minutes;
    else uncountedMin += r.minutes;
  }

  return { rows, plannedDays, totalMin: countedMin + uncountedMin, countedMin, uncountedMin };
}
