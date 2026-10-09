// Prvo pokretanje: raspored još nije postavljen (nijedan dan u nedelji nema šablon), a dan je
// prazan. Kratko objašnjenje kako se pravi raspored (aplikacija ne dolazi sa gotovim planom),
// urađeni koraci označeni, i put do stranice Raspored.

import { useId } from 'react';
import { useT } from '../../i18n/index.ts';
import { navigate, paths } from '../../lib/router.tsx';
import { Button, Icon, cx } from '../../ui/index.ts';

const STEPS = [
  { title: 'day.welcome.categoriesTitle', text: 'day.welcome.categoriesText' },
  { title: 'day.welcome.templateTitle', text: 'day.welcome.templateText' },
  { title: 'day.welcome.weekdaysTitle', text: 'day.welcome.weekdaysText' },
] as const;

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
  const t = useT();
  const titleId = useId();
  return (
    <section className="card day-welcome" aria-labelledby={titleId}>
      <h2 className="day-welcome-title" id={titleId}>
        {t('day.welcome.title')}
      </h2>
      <p className="day-welcome-lead">{t('day.welcome.lead')}</p>
      <ol className="day-welcome-steps">
        {STEPS.map((s, i) => {
          const done = (i === 0 && hasCategories) || (i === 1 && hasTemplates);
          return (
            <li key={s.title} className={cx('day-welcome-step', done && 'is-done')}>
              <span className="day-welcome-num" aria-hidden="true">
                {done ? <Icon name="check" size={16} /> : i + 1}
              </span>
              <span>
                <span className="day-welcome-step-title">{t(s.title)}:</span> {t(s.text)}
                {done && <span className="sr-only"> {t('day.welcome.stepDone')}</span>}
              </span>
            </li>
          );
        })}
      </ol>
      <div className="day-welcome-actions">
        <Button variant="primary" onClick={() => navigate(paths.schedule)}>
          {t('day.welcome.setUp')}
        </Button>
        <Button variant="ghost" onClick={onAddBlock} disabled={disabled}>
          {isToday ? t('day.welcome.addToday') : t('day.welcome.addThisDay')}
        </Button>
      </div>
    </section>
  );
}
