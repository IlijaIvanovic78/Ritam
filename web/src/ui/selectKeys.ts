// Native <select> čiji izbor odmah nešto radi (zamena blokova, nova kategorija): na Windows-u i u
// Firefox-u strelice, Home/End i slova na ZATVORENOM izboru odmah menjaju vrednost (change), pa bi
// samo prolazak tastaturom kroz stavke izvršio akciju.

import type { KeyboardEvent } from 'react';

/** Tasteri koji na zatvorenom <select>-u odmah menjaju izbor. */
const SELECT_NAV_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']);

/**
 * onKeyDown za takav izbor: strelice i ostali tasteri za kretanje otvaraju listu (showPicker)
 * umesto da odmah promene vrednost; akcija se izvršava tek na izbor u listi.
 *
 * Slova (pretraga po početku naziva): bez `guarded` se ne propuštaju (svaka stavka je akcija);
 * sa `guarded` (vrednost jedine stavke koja je akcija, npr. "+ Nova kategorija…") propuštaju se
 * sva slova osim onog kojim počinje naziv te stavke.
 */
export function guardSelectKeys(e: KeyboardEvent<HTMLSelectElement>, guarded?: string) {
  if (e.altKey || e.ctrlKey || e.metaKey) return;
  const el = e.currentTarget;
  const nav = SELECT_NAV_KEYS.has(e.key);
  let typeAhead = e.key.length === 1 && e.key !== ' ';
  if (typeAhead && guarded != null) {
    const label = Array.from(el.options).find((o) => o.value === guarded)?.text.trim() ?? '';
    typeAhead = label.toLocaleLowerCase('sr').startsWith(e.key.toLocaleLowerCase('sr'));
  }
  if (!nav && !typeAhead) return;
  if (typeof el.showPicker !== 'function') return; // stariji browser: ponašanje kao i do sada
  e.preventDefault();
  if (!nav) return;
  try {
    el.showPicker();
  } catch {
    // lista nije mogla da se otvori (npr. element nije vidljiv) — samo ne menjaj izbor
  }
}
