// Sekcija "Planirano nedeljno": zbir sati po kategoriji iz šablona dodeljenih danima, i ukupno
// za kategorije koje se računaju u ispunjenost i one koje se ne računaju.

import { useMemo } from 'react';
import { fmtDuration } from '../../../../shared/time.ts';
import { categoryColor, categoryName, useCategoryMap, useScheduleData } from '../../lib/store.ts';
import { Card, CategoryDot, cx } from '../../ui/index.ts';
import { plural, roundTo5, weeklyPlan } from './util.ts';

export function WeeklyPlanCard() {
  const data = useScheduleData();
  const catMap = useCategoryMap();
  const plan = useMemo(() => weeklyPlan(data), [data]);

  // Ništa nije planirano (nijedan dan nema šablon, ili su šabloni prazni): kartica se ne prikazuje.
  if (plan.plannedDays === 0 || plan.totalMin === 0) return null;

  const max = plan.rows[0]?.minutes ?? 0;
  const perDay = (min: number) => fmtDuration(roundTo5(min / plan.plannedDays));

  return (
    <Card title="Planirano nedeljno">
      <div className="sched-plan-stats">
        <div className="sched-stat">
          <span className="sched-stat-value">{fmtDuration(plan.countedMin)}</span>
          <span className="sched-stat-label">računa se u ispunjenost</span>
        </div>
        <div className="sched-stat">
          <span className="sched-stat-value">{plan.uncountedMin > 0 ? fmtDuration(plan.uncountedMin) : '—'}</span>
          <span className="sched-stat-label">ne računa se</span>
        </div>
      </div>

      <ul className="sched-plan-list">
        {plan.rows.map((r) => {
          const color = categoryColor(catMap, r.categoryId);
          const muted = r.category != null && !r.category.counts;
          return (
            <li key={r.categoryId ?? 'none'} className={cx('sched-plan-row', muted && 'is-muted')}>
              <span className="sched-plan-name">
                <CategoryDot color={color} />
                <span className="truncate">{categoryName(catMap, r.categoryId)}</span>
              </span>
              <span className="sched-plan-total">{fmtDuration(r.minutes)}</span>
              <span className="sched-plan-daily">≈ {perDay(r.minutes)} dnevno</span>
              <span className="sched-plan-bar" aria-hidden="true">
                <span style={{ width: `${max > 0 ? (r.minutes / max) * 100 : 0}%`, background: color }} />
              </span>
            </li>
          );
        })}
      </ul>

      {plan.plannedDays < 7 && (
        <p className="sched-note">
          Prosek je za {plan.plannedDays} {plural(plan.plannedDays, 'dan', 'dana', 'dana')} sa šablonom.
        </p>
      )}
    </Card>
  );
}
