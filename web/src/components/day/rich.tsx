// Poruka iz kataloga sa React elementom na mestu {parametra} (npr. <strong> u "još {time}" / "{time} left"):
// redosled reči ostaje iz kataloga, a element se umeće tamo gde stoji parametar.

import { Fragment, type ReactNode } from 'react';

/** Vrednost {parametra} koji se posle zamenjuje elementom: t('day.now.left', { time: SLOT }). */
export const SLOT = '\u0001';

/** Tekst sa SLOT-ovima → tekst sa elementima `nodes` redom na njihovim mestima. */
export function rich(text: string, ...nodes: ReactNode[]): ReactNode {
  const parts = text.split(SLOT);
  if (parts.length === 1) return text;
  return parts.map((part, i) => (
    <Fragment key={i}>
      {part}
      {i < parts.length - 1 ? nodes[i] : null}
    </Fragment>
  ));
}
