// Period (nedelja/mesec) za stranicu Napredak, formatiranje i pomoćne funkcije.

import type { Lang, StatsDay } from '../../../../shared/types.ts';
import {
  addDays,
  addMonths,
  endOfMonth,
  fmtDateLong,
  fmtDateRange,
  fmtDecimal,
  fmtMonthYear,
  fmtPercent,
  isValidISODate,
  startOfMonth,
  startOfWeek,
} from '../../../../shared/time.ts';
import { getLang, tIn } from '../../i18n/index.ts';

export type PeriodMode = 'week' | 'month';

export interface Period {
  mode: PeriodMode;
  start: string; // ponedeljak ili prvi u mesecu
  end: string; // nedelja ili poslednji u mesecu
}

/** Izabrani period. start = null znači "tekući period" (prati logičko danas). */
export interface PeriodSel {
  mode: PeriodMode;
  start: string | null;
}

export function periodContaining(mode: PeriodMode, date: string): Period {
  if (mode === 'week') {
    const start = startOfWeek(date);
    return { mode, start, end: addDays(start, 6) };
  }
  return { mode, start: startOfMonth(date), end: endOfMonth(date) };
}

export function shiftPeriod(p: Period, dir: 1 | -1): Period {
  return p.mode === 'week'
    ? periodContaining('week', addDays(p.start, 7 * dir))
    : periodContaining('month', addMonths(p.start, dir));
}

export function periodContains(p: Period, date: string): boolean {
  return p.start <= date && date <= p.end;
}

/** Period iz izbora; budući period (ne bi trebalo da se desi) vraća se na tekući. */
export function resolvePeriod(sel: PeriodSel, today: string): Period {
  if (sel.start == null) return periodContaining(sel.mode, today);
  const p = periodContaining(sel.mode, sel.start);
  return p.start > today ? periodContaining(sel.mode, today) : p;
}

/** Izbor za period: tekući period se pamti kao null da bi pratio promenu dana. */
export function selFor(p: Period, today: string): PeriodSel {
  return { mode: p.mode, start: periodContains(p, today) ? null : p.start };
}

/** Poslednji dan sa podacima: kraj perioda, ali ne posle danas (budući dani nemaju podatke). */
export function clampEnd(p: Period, today: string): string {
  return p.end < today ? p.end : today;
}

/**
 * Naslov perioda: "6–12. okt", "29. sep – 5. okt", "29. dec 2025. – 4. jan 2026." (en "Oct 6–12",
 * "Sep 29 – Oct 5", "Dec 29, 2025 – Jan 4, 2026"), mesec: "Oktobar 2026." / "October 2026".
 * Godina uz nedelju samo ako nije tekuća.
 */
export function periodTitle(p: Period, today: string, lang: Lang = getLang()): string {
  if (p.mode === 'month') return fmtMonthYear(p.start, lang);
  const cy = today.slice(0, 4);
  const showYear = p.start.slice(0, 4) !== cy || p.end.slice(0, 4) !== cy;
  return fmtDateRange(p.start, p.end, lang, showYear);
}

// ---- Pamćenje perioda u history.state ----
// Kad se iz kalendara ode na dan pa vrati nazad, prikazuje se isti period.
// Klik na tab "Napredak" pravi novi unos u istoriji, pa kreće od tekuće nedelje.

const HISTORY_KEY = 'ritamProgress';

export function readHistorySel(): PeriodSel | null {
  try {
    const raw = (window.history.state as Record<string, unknown> | null)?.[HISTORY_KEY] as
      | { mode?: unknown; start?: unknown }
      | undefined;
    if (!raw || (raw.mode !== 'week' && raw.mode !== 'month')) return null;
    if (raw.start === null) return { mode: raw.mode, start: null };
    if (typeof raw.start === 'string' && isValidISODate(raw.start)) return { mode: raw.mode, start: raw.start };
  } catch {
    // history.state nije dostupan — samo počni od tekuće nedelje
  }
  return null;
}

export function writeHistorySel(sel: PeriodSel): void {
  try {
    const prev = window.history.state;
    const base = prev && typeof prev === 'object' ? (prev as Record<string, unknown>) : {};
    window.history.replaceState({ ...base, [HISTORY_KEY]: sel }, '');
  } catch {
    // nije bitno ako ne uspe
  }
}

// ---- Formatiranje ----

/** Broj odrađenih blokova (može biti x,5 zbog delimičnih): 3 → "3", 2.5 → en "2.5" / sr "2,5". */
export function fmtCount(n: number, lang: Lang = getLang()): string {
  const r = Math.round(n * 2) / 2;
  return Number.isInteger(r) ? String(r) : fmtDecimal(r, lang, 1);
}

/**
 * Broj i reč posle njega iz poruke sa množinom ("5 days" / "5 dana"), da se reč prikaže manjim slovima
 * (jedinica u KPI pločici): ("5 dana", 5) → { value: "5", unit: "dana" }.
 */
export function splitCount(text: string, n: number): { value: string; unit: string } {
  const value = String(n);
  const i = text.indexOf(value);
  if (i < 0) return { value, unit: text };
  return { value, unit: (text.slice(0, i) + text.slice(i + value.length)).trim() };
}

/** Datum za tooltip: "Utorak, 7. oktobar" / "Tuesday, October 7" (+ godina ako nije tekuća). */
export function fmtDayLabel(date: string, today: string, lang: Lang = getLang()): string {
  return fmtDateLong(date, lang, date.slice(0, 4) !== today.slice(0, 4));
}

/**
 * Danas, dok još traje i nije dostigao prag za niz: rezultat nije konačan, pa ne ulazi u prosek
 * ispunjenosti i u graficima se prikazuje neutralno ("u toku"), bez boje ocene.
 */
export function isLiveDay(date: string, day: StatsDay | undefined, today: string, threshold: number): boolean {
  const score = day?.summary?.score;
  return date === today && score != null && score < threshold;
}

/**
 * Tekst za tooltip/čitač ekrana jednog dana (live = dan je u toku, vidi isLiveDay):
 * "Tuesday, October 7: 73% · blocks 5 / 7 (+1 partial) · tasks 2 / 3" / "Utorak, 7. oktobar: 73% · blokovi 5 / 7 …".
 */
export function dayTip(
  date: string,
  day: StatsDay | undefined,
  today: string,
  live = false,
  lang: Lang = getLang(),
): string {
  const head = fmtDayLabel(date, today, lang);
  const sum = day?.summary;
  if (!day?.initialized || !sum) return `${head}: ${tIn(lang, 'progress.notTracked')}`;
  const parts: string[] = [];
  if (sum.score == null) parts.push(tIn(lang, 'progress.tip.noCounted'));
  else {
    parts.push(fmtPercent(sum.score));
    parts.push(
      sum.partial
        ? tIn(lang, 'progress.tip.blocksPartial', { done: sum.done, counted: sum.counted, partial: sum.partial })
        : tIn(lang, 'progress.tip.blocks', { done: sum.done, counted: sum.counted }),
    );
  }
  if (day.tasksTotal > 0) parts.push(tIn(lang, 'progress.tip.tasks', { done: day.tasksDone, total: day.tasksTotal }));
  if (live) parts.push(tIn(lang, 'progress.live'));
  return `${head}: ${parts.join(' · ')}`;
}

// ---- Heatmapa ----

/**
 * Nivo intenziteta (0..4) po score-u, null = dan nije praćen ili nema score.
 * 0: < 20%, 1: < 40%, 2: < 60%, 3: < 80%, 4: >= 80%.
 */
export type HeatLevel = 0 | 1 | 2 | 3 | 4;

export function heatLevel(score: number | null | undefined): HeatLevel | null {
  if (score == null || Number.isNaN(score)) return null;
  return Math.max(0, Math.min(4, Math.floor(score * 5))) as HeatLevel;
}

export function heatClass(level: HeatLevel | null): string {
  return level == null ? 'prog-heat-none' : `prog-heat-${level}`;
}

/** Klasa ćelije heatmape; dan u toku je neutralan (samo okvir). */
export function cellHeatClass(score: number | null | undefined, live: boolean): string {
  return live ? 'prog-heat-live' : heatClass(heatLevel(score));
}

export const HEAT_RANGES = ['0–19%', '20–39%', '40–59%', '60–79%', '80–100%'];

/** Mapa datum → dan iz statistike. */
export function byDate(days: StatsDay[]): Map<string, StatsDay> {
  return new Map(days.map((d) => [d.date, d]));
}
