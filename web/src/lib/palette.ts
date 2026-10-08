// Paleta boja za kategorije (izbor u sheet-u kategorije i boja nove kategorije napravljene u hodu).

import type { Category } from '../../../shared/types.ts';

/** Prigušene boje za kategorije, redom kojim se nude novim kategorijama. */
export const PALETTE: Array<{ color: string; name: string }> = [
  { color: '#5b6b9a', name: 'Plavosiva' },
  { color: '#4e8a8a', name: 'Tirkizna' },
  { color: '#2f6db5', name: 'Plava' },
  { color: '#7b5ea7', name: 'Ljubičasta' },
  { color: '#d0622a', name: 'Narandžasta' },
  { color: '#3f9a5e', name: 'Zelena' },
  { color: '#b98a22', name: 'Oker' },
  { color: '#b4483c', name: 'Crvena' },
  { color: '#8a6d5a', name: 'Braon' },
  { color: '#9a9890', name: 'Siva' },
];

export function sameColor(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Prva boja iz palete koju nijedna kategorija još ne koristi. Boje obrisanih kategorija (`archived`,
 * stari dani ih i dalje prikazuju) se uzimaju tek kad nema potpuno slobodne — inače bi nova
 * kategorija istog naziva izgledala isto kao obrisana. Kad su sve zauzete, ide ukrug.
 */
export function nextFreeColor(categories: Category[], archived: Category[] = []): string {
  const unused = (list: Category[]) => PALETTE.find((p) => !list.some((c) => sameColor(c.color, p.color)));
  return (unused([...categories, ...archived]) ?? unused(categories) ?? PALETTE[categories.length % PALETTE.length]).color;
}
