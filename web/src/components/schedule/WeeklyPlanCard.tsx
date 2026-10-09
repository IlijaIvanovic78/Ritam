// Sekcija "Planirano nedeljno": zbir sati po kategoriji iz šablona dodeljenih danima, i ukupno
// za kategorije koje se računaju u ispunjenost i one koje se ne računaju.

import { useMemo } from 'react';
import { fmtDuration } from '../../../../shared/time.ts';
import { useT } from '../../i18n/index.ts';
import { categoryColor, categoryName, useCategoryMap, useScheduleData } from '../../lib/store.ts';
import { Card, CategoryDot, cx } from '../../ui/index.ts';
import { roundTo5, weeklyPlan } from './util.ts';

export function WeeklyPlanCard() {
  const t = useT();
  const data = useScheduleData();
  const catMap = useCategoryMap();
  const plan = useMemo(() => weeklyPlan(data), [data]);

  // Ništa nije planirano (nijedan dan nema šablon, ili su šabloni prazni): kartica se ne prikazuje.
  if (plan.plannedDays === 0 || plan.totalMin === 0) return null;

  const max = plan.rows[0]?.minutes ?? 0;
  const perDay = (min: number) => fmtDuration(roundTo5(min / plan.plannedDays));

  return (
    <Card title={t('schedule.plan.title')}>
      <div className="sched-plan-stats">
        <div className="sched-stat">
          <span className="sched-stat-value">{fmtDuration(plan.countedMin)}</span>
          <span className="sched-stat-label">{t('schedule.plan.counted')}</span>
        </div>
        <div className="sched-stat">
          <span className="sched-stat-value">{plan.uncountedMin > 0 ? fmtDuration(plan.uncountedMin) : '—'}</span>
          <span className="sched-stat-label">{t('schedule.notCounted')}</span>
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
              <span className="sched-plan-daily">{t('schedule.plan.perDay', { time: perDay(r.minutes) })}</span>
              <span className="sched-plan-bar" aria-hidden="true">
                <span style={{ width: `${max > 0 ? (r.minutes / max) * 100 : 0}%`, background: color }} />
              </span>
            </li>
          );
        })}
      </ul>

      {plan.plannedDays < 7 && (
        <p className="sched-note">{t('schedule.plan.average', { n: plan.plannedDays })}</p>
      )}
    </Card>
  );
}
