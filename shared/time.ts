// Rad sa vremenom i datumima. Datumi su uvek ISO stringovi 'YYYY-MM-DD' i
// računaju se preko UTC-a da letnje/zimsko računanje vremena ne pomera dane.

import type { Lang, Weekday } from './types.ts';

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

// ---- Formatiranje (engleski podrazumevano; srpski latinica) ----
//
// Svaki formater datuma prima jezik (podrazumevano 'en'). Vreme je u oba jezika 24h "09:15" (fmtClock),
// trajanje "4h 45m" (fmtDuration), procenat "73%" (fmtPercent).

const WEEKDAYS: Record<Lang, readonly string[]> = {
  en: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'],
  sr: ['ponedeljak', 'utorak', 'sreda', 'četvrtak', 'petak', 'subota', 'nedelja'],
};
const WEEKDAYS_SHORT: Record<Lang, readonly string[]> = {
  en: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
  sr: ['pon', 'uto', 'sre', 'čet', 'pet', 'sub', 'ned'],
};
const MONTHS: Record<Lang, readonly string[]> = {
  en: [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December',
  ],
  sr: [
    'januar', 'februar', 'mart', 'april', 'maj', 'jun',
    'jul', 'avgust', 'septembar', 'oktobar', 'novembar', 'decembar',
  ],
};
const MONTHS_SHORT: Record<Lang, readonly string[]> = {
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  sr: ['jan', 'feb', 'mar', 'apr', 'maj', 'jun', 'jul', 'avg', 'sep', 'okt', 'nov', 'dec'],
};

/** Nerazdvojiv razmak: "8. oktobar" / "October 8" se ne prelama između dana i meseca. */
const NBSP = ' ';

/**
 * Dan u nedelji (1 = ponedeljak … 7 = nedelja): "Monday" / "ponedeljak". Srpski je malim slovom, kao u
 * rečenici ("ponedeljak, utorak i petak"); na početku rečenice `capitalize`. Posle predloga "za" — `weekdayNameAcc`.
 */
export function weekdayName(wd: number, lang: Lang = 'en'): string {
  return WEEKDAYS[lang][wd - 1];
}

/** Srpski akuzativ (posle "za"): "za sredu", "za subotu", "za nedelju". */
const WEEKDAYS_ACC_SR = ['ponedeljak', 'utorak', 'sredu', 'četvrtak', 'petak', 'subotu', 'nedelju'] as const;

/**
 * Dan u nedelji posle predloga "za" (akuzativ, malim slovom): sr "Za subotu važi šablon…"; en isto kao
 * `weekdayName` ("Saturday").
 */
export function weekdayNameAcc(wd: number, lang: Lang = 'en'): string {
  return lang === 'sr' ? WEEKDAYS_ACC_SR[wd - 1] : weekdayName(wd, lang);
}

/** "Mon" / "pon" (1 = ponedeljak … 7 = nedelja). */
export function weekdayShort(wd: number, lang: Lang = 'en'): string {
  return WEEKDAYS_SHORT[lang][wd - 1];
}

/** Kratki nazivi svih dana redom od ponedeljka (zaglavlja kalendara i heatmape). */
export function weekdayShortNames(lang: Lang = 'en'): string[] {
  return [...WEEKDAYS_SHORT[lang]];
}

/** Mesec 1..12: "October" / "oktobar". */
export function monthName(m: number, lang: Lang = 'en'): string {
  return MONTHS[lang][m - 1];
}

/** Mesec 1..12: "Oct" / "okt". */
export function monthShort(m: number, lang: Lang = 'en'): string {
  return MONTHS_SHORT[lang][m - 1];
}

export function capitalize(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/**
 * en "Thursday, October 8" (withYear: "Thursday, October 8, 2026");
 * sr "Četvrtak, 8. oktobar" (withYear: "Četvrtak, 8. oktobar 2026.").
 */
export function fmtDateLong(iso: string, lang: Lang = 'en', withYear = false): string {
  const [y, m, d] = iso.split('-').map(Number);
  const wd = capitalize(weekdayName(isoWeekday(iso), lang));
  if (lang === 'sr') return `${wd}, ${d}. ${MONTHS.sr[m - 1]}${withYear ? ` ${y}.` : ''}`;
  return `${wd}, ${MONTHS.en[m - 1]} ${d}${withYear ? `, ${y}` : ''}`;
}

/** en "Thu, Oct 8"; sr "čet, 8. okt" (malim slovom; na početku rečenice `capitalize`). */
export function fmtDateMedium(iso: string, lang: Lang = 'en'): string {
  const [, m, d] = iso.split('-').map(Number);
  const wd = weekdayShort(isoWeekday(iso), lang);
  if (lang === 'sr') return `${wd}, ${d}. ${MONTHS_SHORT.sr[m - 1]}`;
  return `${wd}, ${MONTHS_SHORT.en[m - 1]} ${d}`;
}

/** en "Oct 8"; sr "8. okt". */
export function fmtDateShort(iso: string, lang: Lang = 'en'): string {
  const [, m, d] = iso.split('-').map(Number);
  if (lang === 'sr') return `${d}. ${MONTHS_SHORT.sr[m - 1]}`;
  return `${MONTHS_SHORT.en[m - 1]} ${d}`;
}

/** en "October 2026"; sr "Oktobar 2026.". */
export function fmtMonthYear(iso: string, lang: Lang = 'en'): string {
  const [y, m] = iso.split('-').map(Number);
  if (lang === 'sr') return `${capitalize(MONTHS.sr[m - 1])} ${y}.`;
  return `${MONTHS.en[m - 1]} ${y}`;
}

/**
 * Dan i mesec bez dana u nedelji, bez prelamanja između njih (naslov dana na telefonu):
 * en "October 8" (withYear: "October 8, 2026"); sr "8. oktobar" (withYear: "8. oktobar 2026.").
 */
export function fmtDayMonth(iso: string, lang: Lang = 'en', withYear = false): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (lang === 'sr') return `${d}.${NBSP}${MONTHS.sr[m - 1]}${withYear ? ` ${y}.` : ''}`;
  return `${MONTHS.en[m - 1]}${NBSP}${d}${withYear ? `, ${y}` : ''}`;
}

/**
 * Opseg datuma (naslov nedelje u Napretku), kratki meseci; `showYear` dodaje godinu:
 * en "Oct 6–12", "Sep 29 – Oct 5", "Dec 29, 2025 – Jan 4, 2026";
 * sr "6–12. okt", "29. sep – 5. okt", "29. dec 2025. – 4. jan 2026.".
 * Godina levo samo kad se godine razlikuju. Unutar svakog datuma su nerazdvojivi razmaci, pa se red prelama
 * samo oko " – " (ne "Dec 29, 2025 – Jan / 4, 2026").
 */
export function fmtDateRange(from: string, to: string, lang: Lang = 'en', showYear = false): string {
  const [sy, sm, sd] = from.split('-').map(Number);
  const [ey, em, ed] = to.split('-').map(Number);
  const ms = MONTHS_SHORT[lang];
  if (lang === 'sr') {
    if (sy === ey && sm === em) return `${sd}–${ed}.${NBSP}${ms[sm - 1]}${showYear ? `${NBSP}${sy}.` : ''}`;
    const left = `${sd}.${NBSP}${ms[sm - 1]}${showYear && sy !== ey ? `${NBSP}${sy}.` : ''}`;
    return `${left} – ${ed}.${NBSP}${ms[em - 1]}${showYear ? `${NBSP}${ey}.` : ''}`;
  }
  if (sy === ey && sm === em) return `${ms[sm - 1]}${NBSP}${sd}–${ed}${showYear ? `,${NBSP}${sy}` : ''}`;
  const left = `${ms[sm - 1]}${NBSP}${sd}${showYear && sy !== ey ? `,${NBSP}${sy}` : ''}`;
  return `${left} – ${ms[em - 1]}${NBSP}${ed}${showYear ? `,${NBSP}${ey}` : ''}`;
}

/** 0.734 → "73%" (isto u oba jezika). */
export function fmtPercent(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return '—';
  return `${Math.round(v * 100)}%`;
}

/** Decimalni broj: en 4.25 → "4.3", sr → "4,3". */
export function fmtDecimal(n: number, lang: Lang = 'en', digits = 1): string {
  const s = n.toFixed(digits);
  return lang === 'sr' ? s.replace('.', ',') : s;
}
