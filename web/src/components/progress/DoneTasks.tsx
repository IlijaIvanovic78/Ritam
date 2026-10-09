// Završeni zadaci u periodu, grupisani po danu (najnoviji prvi).

import { useState } from 'react';
import type { Category, Task } from '../../../../shared/types.ts';
import { capitalize, fmtDateMedium } from '../../../../shared/time.ts';
import { useLang, useT } from '../../i18n/index.ts';
import { Link, dayPath } from '../../lib/router.tsx';
import { categoryColor, categoryName } from '../../lib/store.ts';
import { Button, CategoryDot, Icon } from '../../ui/index.ts';

const COLLAPSED = 12; // koliko zadataka se prikazuje pre "Prikaži sve"

interface Group {
  date: string;
  tasks: Task[];
}

/** Server vraća po date DESC, done_at DESC; ovde samo grupišemo uzastopne. */
function groupByDate(tasks: Task[]): Group[] {
  const out: Group[] = [];
  for (const t of tasks) {
    const last = out[out.length - 1];
    if (last && last.date === t.date) last.tasks.push(t);
    else out.push({ date: t.date, tasks: [t] });
  }
  return out;
}

export function DoneTasks({ tasks, today, catMap }: { tasks: Task[]; today: string; catMap: Map<number, Category> }) {
  const lang = useLang();
  const t = useT();
  const [expanded, setExpanded] = useState(false);

  if (tasks.length === 0) {
    return <p className="prog-note">{t('progress.tasks.empty')}</p>;
  }

  // Sortiraj defanzivno (datum opadajuće), pa skrati listu ako je dugačka.
  const sorted = [...tasks].sort((a, b) =>
    a.date === b.date ? (b.doneAt ?? '').localeCompare(a.doneAt ?? '') : b.date.localeCompare(a.date),
  );
  const visible = expanded ? sorted : sorted.slice(0, COLLAPSED);
  const hidden = sorted.length - visible.length;
  const year = today.slice(0, 4);
  /** "Thu, Oct 8" / "Čet, 8. okt"; godina samo ako nije tekuća ("Thu, Oct 8, 2025" / "Čet, 8. okt 2025."). */
  const dateLabel = (date: string) => {
    const label = capitalize(fmtDateMedium(date, lang));
    const y = date.slice(0, 4);
    return y === year ? label : t('progress.tasks.dateWithYear', { date: label, year: y });
  };

  return (
    <div className="prog-tasks">
      {groupByDate(visible).map((g) => (
        <section key={g.date} className="prog-tasks-day">
          <h3 className="prog-tasks-date">
            <Link to={dayPath(g.date, today)}>{dateLabel(g.date)}</Link>
          </h3>
          <ul className="prog-tasks-list">
            {g.tasks.map((task) => {
              const cat = task.categoryId != null && catMap.has(task.categoryId) ? task.categoryId : null;
              return (
                <li key={task.id} className="prog-task">
                  <Icon name="check" size={16} className="prog-task-check" />
                  <span className="prog-task-title">{task.title}</span>
                  {/* Tačka je ispred naslova (CSS order, kao na Danas); mesto postoji i bez kategorije,
                      da svi naslovi počinju u istoj liniji. Čitač ekrana čita naslov pa kategoriju. */}
                  <span className="prog-task-cat" title={cat != null ? categoryName(catMap, cat) : undefined}>
                    <CategoryDot color={cat != null ? categoryColor(catMap, cat) : 'transparent'} />
                    {cat != null && <span className="sr-only">{categoryName(catMap, cat)}</span>}
                  </span>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      {hidden > 0 && (
        <div>
          <Button variant="ghost" size="sm" onClick={() => setExpanded(true)}>
            {t('progress.tasks.showAll', { count: sorted.length })}
          </Button>
        </div>
      )}
    </div>
  );
}
