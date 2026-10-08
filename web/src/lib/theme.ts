// Tema: podrazumevano je tamna (crna). 'system' prati podešavanje uređaja (bez data-theme),
// 'light'/'dark' je eksplicitan izbor. Izbor se čuva u localStorage. Menja i <meta name="theme-color">
// da se traka sa statusom / adresna traka slaže sa pozadinom aplikacije.

import { useSyncExternalStore } from 'react';

export type ThemePref = 'system' | 'light' | 'dark';

const KEY = 'ritam.theme';

/** Boja pozadine (--bg) po temi; mora da se slaže sa tokens.css i index.html. */
const BG = { light: '#f6f5f2', dark: '#0a0a0a' } as const;

const DEFAULT_THEME: ThemePref = 'dark';

let current: ThemePref = DEFAULT_THEME;
const listeners = new Set<() => void>();

function readStored(): ThemePref {
  try {
    const v = window.localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark' || v === 'system') return v;
  } catch {
    // privatni režim / blokiran storage — ostaje podrazumevana tema
  }
  return DEFAULT_THEME;
}

function apply(pref: ThemePref) {
  const root = document.documentElement;
  if (pref === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', pref);

  // index.html ima dva theme-color meta taga (light/dark preko media upita).
  // Za "sistem" vrati njihove prirodne vrednosti, za eksplicitnu temu oba dobijaju istu boju.
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((m) => {
    const isDarkMeta = (m.getAttribute('media') ?? '').includes('dark');
    m.content = pref === 'system' ? (isDarkMeta ? BG.dark : BG.light) : BG[pref];
  });
}

export function getTheme(): ThemePref {
  return current;
}

export function setTheme(pref: ThemePref) {
  current = pref;
  try {
    if (pref === DEFAULT_THEME) window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, pref);
  } catch {
    // izbor važi do zatvaranja stranice
  }
  apply(pref);
  listeners.forEach((l) => l());
}

/** Poziva se jednom, pre prvog rendera (main.tsx). */
export function initTheme() {
  current = readStored();
  apply(current);
  // Promena teme u drugom tabu iste aplikacije.
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY && e.key !== null) return;
    current = readStored();
    apply(current);
    listeners.forEach((l) => l());
  });
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useTheme(): ThemePref {
  return useSyncExternalStore(subscribe, getTheme);
}
