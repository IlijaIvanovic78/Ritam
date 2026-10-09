// Čiste funkcije za prikaz dana (bez React-a).

import type { Block, Category } from '../../../../shared/types.ts';
import { blockCounts } from '../../../../shared/summary.ts';

/**
 * Prošao je, a još nije ocenjen ("čeka ocenu"). Blok čija se kategorija ne računa u ispunjenost
 * (pauza, slobodno vreme) ne čeka ocenu — ne utiče na procenat dana.
 */
export function isDue(b: Block, minute: number, catMap: Map<number, Category>): boolean {
  return b.id > 0 && b.status === 'pending' && b.end <= minute && blockCounts(b, catMap);
}

/** Prošli blokovi koji još nisu ocenjeni (podsetnik ujutru za juče). */
export function dueBlocks(blocks: Block[], minute: number, catMap: Map<number, Category>): Block[] {
  return blocks.filter((b) => isDue(b, minute, catMap));
}
