// Mere niza blokova (iste kao u prototipu): visina reda po trajanju, mere gestova i pomoćne funkcije bez React-a.

import { fmtClock } from '../../../../shared/time.ts';

/** Držanje prsta pre podizanja bloka (ms). */
export const LONG_PRESS_MS = 420;
/** Pomeranje prsta pre držanja koje znači skrol (px). */
export const TOUCH_SLOP = 8;
/** Miš: prevlačenje počinje posle ovoliko piksela (bez držanja). */
export const MOUSE_SLOP = 5;
/** Ručica trajanja: 20 px = 15 min. */
export const STEP_PX = 20;
/** Razmak između redova (px), isto kao --gap u blocks.css. */
export const ROW_GAP = 4;
/** Visina podignutog bloka ("čip" pod prstom). */
export const CHIP_H = 64;
/** Traka sa tabovima na telefonu (--tabbar-h). */
export const TABBAR_H = 58;

export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Visina bloka: 15m = 49, 30m = 59, 1h = 80, 3h = 164, 7h = 202 (posle 3h sabijeno). */
export const heightOf = (dur: number) => Math.round(38 + 0.7 * Math.min(dur, 180) + 0.16 * Math.max(0, dur - 180));
/** Blok u uređivaču rezova: clamp(2 × trajanje, 168, 400). */
export const splitHeightOf = (dur: number) => Math.round(clamp(dur * 2, 168, 400));

export const fmtRange = (a: number, b: number) => `${fmtClock(a)}–${fmtClock(b)}`;

/** Poređenje naziva bez razlike velikih slova i dijakritika ("Čitanje" = "citanje"). */
export const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'dj')
    .trim();

export const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
/** Miš ili olovka (precizan pokazivač). */
export const finePointer = () => window.matchMedia('(pointer: fine)').matches;
/** Telefon (isti prelom kao donja traka). */
export const isPhoneWidth = () => window.innerWidth < 860;

/** Kratka vibracija (Android); iOS je ignoriše. */
export function vibrate(pattern: number | number[]) {
  try {
    // Pre prvog dodira na stranici browser ionako odbija (i to beleži u konzoli).
    if (navigator.userActivation && !navigator.userActivation.hasBeenActive) return;
    navigator.vibrate?.(pattern);
  } catch {
    // nije podržano
  }
}

// ---- Gest bloka u toku: prevlačenje dana levo/desno (useSwipeNav) ga ne sme preuzeti ----

let gestureAt = -Infinity;

/** Blok je podignut, menja mu se trajanje, pomera rez ili se prevlači mapa dana. */
export function markBlockGesture() {
  gestureAt = performance.now();
}

/** Da li je od trenutka `since` (performance.now()) bio gest bloka. */
export function blockGestureSince(since: number): boolean {
  return gestureAt >= since;
}
