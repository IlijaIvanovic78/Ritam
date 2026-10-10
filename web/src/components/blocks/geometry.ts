// Mere niza blokova (iste kao u prototipu): visina reda po trajanju, mere gestova i pomoćne funkcije bez React-a.

import { fmtClock } from '../../../../shared/time.ts';

/** Držanje prsta pre podizanja bloka (ms). */
export const LONG_PRESS_MS = 420;
/** Pomeranje prsta pre držanja koje znači skrol (px). */
export const TOUCH_SLOP = 8;
/** Miš: prevlačenje počinje posle ovoliko piksela (bez držanja). */
export const MOUSE_SLOP = 5;
/** Ručica trajanja: 12 px = jedan korak mreže (5 min). */
export const STEP_PX = 12;
/** Razmak između redova (px), isto kao --gap u blocks.css. */
export const ROW_GAP = 6;
/** Slobodno vreme koje nije prošlo: red stalne visine (vreme je u tekstu, srazmera je na traci dana). */
export const FREE_H = 44;
/** Slobodno vreme koje je prošlo (ili bilo koje na ranijem danu): niži red. */
export const FREE_PAST_H = 28;
/** Visina podignutog bloka ("čip" pod prstom). */
export const CHIP_H = 64;
/** Rupa pri prevlačenju: koliko se susedi pomere (čip + razmak). */
export const HOLE = CHIP_H + ROW_GAP;
/** Traka sa tabovima na telefonu (--tabbar-h). */
export const TABBAR_H = 58;
/** Od ove visine (1h10m) naziv bloka sme u dva reda: 11 + 2 × 20 + 2 + 18 + 11 (+ ivica) — tek tada staje i meta. */
export const TALL_H = 83;
/** Kraće od ovoga (min) je kratak blok (manji tekst). */
export const SHORT_MIN = 30;
/** Držanje dugmeta − / +: prvi ponovljeni korak posle `first` ms, pa na `every` ms, posle `fastAfter` koraka na `fast` ms. */
export const REPEAT = { first: 400, every: 120, fastAfter: 20, fast: 70 };

export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Visina bloka (koren trajanja): 5–20m = 52, 30m = 63, 1h = 79, 2h = 102, 4h45 = 144, 8h = 180, 12h = 214. */
export const heightOf = (dur: number) => Math.max(52, Math.round(24 + 7.1 * Math.sqrt(dur)));
/** Blok u uređivaču rezova: clamp(1,6 × trajanje, 184, 360). */
export const splitHeightOf = (dur: number) => Math.round(clamp(dur * 1.6, 184, 360));

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

// ---- Dvostruki dodir na dugme koje se pod prstom zameni drugim ----

/**
 * Drugi dodir dvostrukog dodira: ovoliko ms posle prvog (klik do klika: do 300 ms od puštanja do drugog pritiska, kao
 * dvostruki dodir na Androidu, plus sam drugi dodir)…
 */
const TAP_GUARD_MS = 450;
/** …i najviše ovoliko px od njega. */
const TAP_GUARD_PX = 32;

/**
 * Dugme čija akcija menja ono što je pod prstom (Završi sad → Dodaj posle, Dodaj → donja traka, "+" → pozadina lista,
 * Podeli → Otkaži): drugi dodir dvostrukog dodira (isto mesto, ≤ 450 ms) se proguta, da ne pokrene ono što se upravo
 * pojavilo. Poziva se iz klika na to dugme; tastatura (detail 0) nema drugi dodir.
 */
export function guardTap(e: { clientX: number; clientY: number; detail: number }) {
  if (e.detail === 0) return;
  const x = e.clientX;
  const y = e.clientY;
  const until = performance.now() + TAP_GUARD_MS;
  const done = () => document.removeEventListener('click', kill, true);
  const kill = (ev: MouseEvent) => {
    if (performance.now() > until) return done();
    if (Math.hypot(ev.clientX - x, ev.clientY - y) > TAP_GUARD_PX) return;
    ev.stopPropagation();
    ev.preventDefault();
    done();
  };
  document.addEventListener('click', kill, true);
  window.setTimeout(done, TAP_GUARD_MS + 50);
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
