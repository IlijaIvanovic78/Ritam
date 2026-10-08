// Rad sa vremenom i datumima. Datumi su uvek ISO stringovi 'YYYY-MM-DD' i
// računaju se preko UTC-a da letnje/zimsko računanje vremena ne pomera dane.

import type { Weekday } from './types.ts';

export const DAY_MIN = 1440;

const pad = (n: number) => String(n).padStart(2, '0');

/** "09:15" → 555. Prihvata H:MM i HH:MM od 00:00 do 23:59; inače null. */
export function parseClock(s: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (h > 23 || mm > 59) return null;
  return h * 60 + mm;
}

/** Minuti (i >= 1440) → zidni sat "HH:MM". */
export function fmtClock(min: number): string {
  const m = ((Math.round(min) % DAY_MIN) + DAY_MIN) % DAY_MIN;
  return `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
}

/** Minuti → zidni sat 0..1439. */
export function toClock(min: number): number {
  return ((Math.round(min) % DAY_MIN) + DAY_MIN) % DAY_MIN;
}

/** 285 → "4h 45m", 60 → "1h", 45 → "45m", 0 → "0m". */
export function fmtDuration(min: number): string {
  const total = Math.max(0, Math.round(min));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}m`;
}

/**
 * Zidno vreme početka/kraja (0..1439) → minuti relativni na dan.
 * Početak pre `dayStart` pripada kraju dana (+1440). Kraj koji nije posle
 * početka prelazi ponoć (+1440).
 *   dayStart 60: 01:00–09:00 → 60–540, 23:00–00:00 → 1380–1440, 00:00–01:00 → 1440–1500
 */
export function normalizeRange(startClock: number, endClock: number, dayStart: number): { start: number; end: number } {
  const start = startClock < dayStart ? startClock + DAY_MIN : startClock;
  let end = endClock;
  while (end <= start) end += DAY_MIN;
  return { start, end };
}

/** Validan opseg bloka: 0 <= start < 2880, start < end, trajanje <= 24h. */
export function isValidRange(start: number, end: number): boolean {
  return (
    Number.isInteger(start) &&
    Number.isInteger(end) &&
    start >= 0 &&
    start < 2 * DAY_MIN &&
    end > start &&
    end - start <= DAY_MIN
  );
}

// ---- Datumi ----

export function isValidISODate(s: string): boolean {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function toUTC(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

function fromUTC(dt: Date): string {
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

export function addDays(iso: string, n: number): string {
  const dt = toUTC(iso);
  dt.setUTCDate(dt.getUTCDate() + n);
  return fromUTC(dt);
}

/** Broj dana od a do b (b - a). */
export function diffDays(a: string, b: string): number {
  return Math.round((toUTC(b).getTime() - toUTC(a).getTime()) / 86_400_000);
}

/** 1 = ponedeljak … 7 = nedelja. */
export function isoWeekday(iso: string): Weekday {
  return (((toUTC(iso).getUTCDay() + 6) % 7) + 1) as Weekday;
}

/** Ponedeljak nedelje u kojoj je datum. */
export function startOfWeek(iso: string): string {
  return addDays(iso, 1 - isoWeekday(iso));
}

export function startOfMonth(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

export function endOfMonth(iso: string): string {
  const [y, m] = iso.split('-').map(Number);
  return fromUTC(new Date(Date.UTC(y, m, 0)));
}

/** Pomeri za n meseci, uvek vraća prvi dan meseca. */
export function addMonths(iso: string, n: number): string {
  const [y, m] = iso.split('-').map(Number);
  return fromUTC(new Date(Date.UTC(y, m - 1 + n, 1)));
}

/** Svi datumi od `from` do `to`, uključivo. */
export function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  const n = diffDays(from, to);
  for (let i = 0; i <= n; i++) out.push(addDays(from, i));
  return out;
}

/** Lokalni kalendarski datum uređaja. */
export function localISODate(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Logičko "sada": pre `dayStart` (npr. 00:30 kad dan počinje u 01:00) još traje juče,
 * pa je minut >= 1440. `minute` je sa decimalama (sekunde) radi glatkih indikatora.
 */
export function logicalNow(dayStart: number, now: Date = new Date()): { date: string; minute: number } {
  const mins = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
  const today = localISODate(now);
  if (mins < dayStart) return { date: addDays(today, -1), minute: mins + DAY_MIN };
  return { date: today, minute: mins };
}

// ---- Formatiranje (srpski, latinica) ----

export const WEEKDAY_NAMES = ['ponedeljak', 'utorak', 'sreda', 'četvrtak', 'petak', 'subota', 'nedelja'];
export const WEEKDAY_SHORT = ['pon', 'uto', 'sre', 'čet', 'pet', 'sub', 'ned'];
export const MONTH_NAMES = [
  'januar', 'februar', 'mart', 'april', 'maj', 'jun',
  'jul', 'avgust', 'septembar', 'oktobar', 'novembar', 'decembar',
];
export const MONTH_SHORT = ['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'avg', 'sep', 'okt', 'nov', 'dec'];

export function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/** "Utorak, 7. oktobar" (sa godinom ako withYear: "Utorak, 7. oktobar 2026.") */
export function fmtDateLong(iso: string, withYear = false): string {
  const [y, m, d] = iso.split('-').map(Number);
  const wd = WEEKDAY_NAMES[isoWeekday(iso) - 1];
  return `${capitalize(wd)}, ${d}. ${MONTH_NAMES[m - 1]}${withYear ? ` ${y}.` : ''}`;
}

/** "uto, 7. okt" */
export function fmtDateMedium(iso: string): string {
  const [, m, d] = iso.split('-').map(Number);
  return `${WEEKDAY_SHORT[isoWeekday(iso) - 1]}, ${d}. ${MONTH_SHORT[m - 1]}`;
}

/** "7. okt" */
export function fmtDateShort(iso: string): string {
  const [, m, d] = iso.split('-').map(Number);
  return `${d}. ${MONTH_SHORT[m - 1]}`;
}

/** "Oktobar 2026." */
export function fmtMonthYear(iso: string): string {
  const [y, m] = iso.split('-').map(Number);
  return `${capitalize(MONTH_NAMES[m - 1])} ${y}.`;
}

/** 0.734 → "73%" */
export function fmtPercent(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return '—';
  return `${Math.round(v * 100)}%`;
}
