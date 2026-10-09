// Paleta boja za kategorije (izbor u sheet-u kategorije i boja nove kategorije napravljene u hodu).

import type { Category } from '../../../shared/types.ts';
import { t } from '../i18n/index.ts';
import type { MessageKey } from '../i18n/index.ts';

/** Boja palete; `name` je naziv na trenutnom jeziku (čita se pri svakom prikazu, pa prati promenu jezika). */
export interface PaletteColor {
  color: string;
  readonly name: string;
}

type PaletteKey = Extract<MessageKey, `schedule.palette.${string}`>;

const swatch = (color: string, key: PaletteKey): PaletteColor => ({
  color,
  get name() {
    return t(key);
  },
});

/** Prigušene boje za kategorije, redom kojim se nude novim kategorijama. */
export const PALETTE: PaletteColor[] = [
  swatch('#5b6b9a', 'schedule.palette.slateBlue'),
  swatch('#4e8a8a', 'schedule.palette.teal'),
  swatch('#2f6db5', 'schedule.palette.blue'),
  swatch('#7b5ea7', 'schedule.palette.purple'),
  swatch('#d0622a', 'schedule.palette.orange'),
  swatch('#3f9a5e', 'schedule.palette.green'),
  swatch('#b98a22', 'schedule.palette.ochre'),
  swatch('#b4483c', 'schedule.palette.red'),
  swatch('#8a6d5a', 'schedule.palette.brown'),
  swatch('#9a9890', 'schedule.palette.gray'),
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
