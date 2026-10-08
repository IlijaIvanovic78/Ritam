// Prvo pokretanje: raspored još nije postavljen (nijedan dan u nedelji nema šablon), a dan je
// prazan. Kratko objašnjenje kako se pravi raspored (aplikacija ne dolazi sa gotovim planom),
// urađeni koraci označeni, i put do stranice Raspored.

import { useId } from 'react';
import { navigate, paths } from '../../lib/router.tsx';
import { Button, Icon, cx } from '../../ui/index.ts';

const STEPS: Array<{ title: string; text: string }> = [
  { title: 'Kategorije', text: 'stvari koje radiš i njihove boje' },
  { title: 'Šablon', text: 'plan dana sa blokovima i vremenima' },
  { title: 'Dani u nedelji', text: 'koji šablon važi kog dana' },
];

export function WelcomeCard({
  hasCategories,
  hasTemplates,
  isToday,
  disabled,
  onAddBlock,
}: {
  /** Prvi korak je već urađen (postoji bar jedna kategorija). */
  hasCategories: boolean;
  /** Drugi korak je već urađen (postoji bar jedan šablon). */
  hasTemplates: boolean;
  isToday: boolean;
  disabled?: boolean;
  onAddBlock: () => void;
}) {
  const titleId = useId();
  return (
    <section className="card day-welcome" aria-labelledby={titleId}>
      <h2 className="day-welcome-title" id={titleId}>
        Napravi svoj raspored
      </h2>
      <p className="day-welcome-lead">Opiši jednom kako izgleda tvoj dan, a Ritam će ga sam postaviti za svaki dan.</p>
      <ol className="day-welcome-steps">
        {STEPS.map((s, i) => {
          const done = (i === 0 && hasCategories) || (i === 1 && hasTemplates);
          return (
            <li key={s.title} className={cx('day-welcome-step', done && 'is-done')}>
              <span className="day-welcome-num" aria-hidden="true">
                {done ? <Icon name="check" size={16} /> : i + 1}
              </span>
              <span>
                <span className="day-welcome-step-title">{s.title}:</span> {s.text}
                {done && <span className="sr-only"> (urađeno)</span>}
              </span>
            </li>
          );
        })}
      </ol>
      <div className="day-welcome-actions">
        <Button variant="primary" onClick={() => navigate(paths.schedule)}>
          Podesi raspored
        </Button>
        <Button variant="ghost" onClick={onAddBlock} disabled={disabled}>
          {isToday ? 'Dodaj blok samo za danas' : 'Dodaj blok samo za ovaj dan'}
        </Button>
      </div>
    </section>
  );
}
