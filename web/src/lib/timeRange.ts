// Pretvaranje zidnog vremena u minute dana pri IZMENI postojećeg bloka.

import { DAY_MIN, fmtClock, normalizeRange } from '../../../shared/time.ts';
import { t } from '../i18n/index.ts';

/**
 * Kao normalizeRange, ali početak bira prema dosadašnjem mestu bloka (`anchorStart`, minuti dana):
 * od kandidata `start` i `start + 1440` uzima onaj bliži staroj vrednosti. Tako "01:00–09:00"
 * pomeren na 00:30 ostaje na početku dana (30–540), a "00:00–01:00" na kraju dana (1440–1500)
 * pomereno na 00:10 ostaje na kraju (1450–1500). Ako se početak nije menjao, ostaje tačno anchorStart.
 * Kraj ide posle početka (preko ponoći ako treba).
 *
 * Bliži kandidat važi samo ako se blok i dalje preklapa sa logičkim danom
 * `[dayStart, dayStart + 1440)`; inače (npr. dan počinje u 00:00, a "23:30–07:00" je pomereno na
 * 00:30–09:00 — bliži kandidat 1470–1980 bi bio ceo u sledećem danu) važi pravilo novog bloka
 * (normalizeRange), pa isto vreme uvek završi na istom mestu. Novi blokovi koriste normalizeRange.
 */
export function normalizeNear(
  startClock: number,
  endClock: number,
  anchorStart: number,
  dayStart: number,
): { start: number; end: number } {
  const start =
    Math.abs(startClock + DAY_MIN - anchorStart) < Math.abs(startClock - anchorStart) ? startClock + DAY_MIN : startClock;
  let end = endClock;
  while (end <= start) end += DAY_MIN;
  if (start < dayStart + DAY_MIN && end > dayStart) return { start, end };
  return normalizeRange(startClock, endClock, dayStart);
}

/**
 * Upozorenje kad izmenjen početak postojećeg bloka (`origStart`) prebaci blok na suprotni kraj
 * logičkog dana (pomeraj 12h ili više), npr. "01:00–09:00" → 23:30 postaje večerašnji blok
 * 23:30–09:00 sutra. null kad blok ostaje na svom kraju dana. Tekst je na trenutnom jeziku.
 */
export function jumpHint(range: { start: number; end: number }, origStart: number, dayStart: number): string | null {
  const shown = `${fmtClock(range.start)}–${fmtClock(range.end)}`;
  if (range.start - origStart >= DAY_MIN / 2) {
    const shownEnd = range.end > DAY_MIN ? t('common.rangeNextDay', { range: shown }) : shown;
    return t('common.blockJumpToEnd', { range: shownEnd, dayStart: fmtClock(dayStart) });
  }
  if (origStart - range.start >= DAY_MIN / 2) {
    return t('common.blockJumpToStart', { range: shown, dayStart: fmtClock(dayStart) });
  }
  return null;
}
