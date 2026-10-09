// KPI red: ispunjenost, niz, zadaci, ocena dana.

import type { ReactNode } from 'react';
import type { StatsPayload } from '../../../../shared/types.ts';
import { fmtDateShort, fmtDecimal, fmtPercent } from '../../../../shared/time.ts';
import { useLang, useT } from '../../i18n/index.ts';
import { cx } from '../../ui/index.ts';
import { isLiveDay, splitCount } from './period.ts';

function Kpi({ label, value, unit, caption }: { label: string; value: ReactNode; unit?: string; caption: string }) {
  return (
    <div className="prog-kpi">
      <dt className="prog-kpi-label">{label}</dt>
      <dd className="prog-kpi-value">
        {value}
        {unit && <span className="prog-kpi-unit">{unit}</span>}
      </dd>
      <dd className="prog-kpi-cap">{caption}</dd>
    </div>
  );
}

export function Kpis({
  stats,
  isCurrent,
  threshold,
  today,
  className,
}: {
  stats: StatsPayload;
  /** Da li period sadrži danas (niz je "trenutni", inače stanje na kraju perioda). */
  isCurrent: boolean;
  threshold: number;
  today: string;
  className?: string;
}) {
  const lang = useLang();
  const t = useT();
  const { totals, streak, days } = stats;
  const rated = days.filter((d) => d.rating != null).length;

  // Prosek bez današnjeg dana dok je u toku i ispod praga (jutro sa 2 čekirana bloka nije 18%).
  // Isti prosek kao na serveru (totals.avgScore), samo bez tog dana.
  let liveToday = false;
  const scores: number[] = [];
  for (const d of days) {
    const score = d.summary?.score;
    if (score == null) continue;
    if (isLiveDay(d.date, d, today, threshold)) liveToday = true;
    else scores.push(score);
  }
  const avgScore = scores.length > 0 ? scores.reduce((a, s) => a + s, 0) / scores.length : null;
  const scored = scores.length;
  // "5 days" / "5 dana": broj je vrednost pločice, reč posle njega jedinica.
  const streakDays = splitCount(t('common.days', { n: streak }), streak);

  return (
    <dl className={cx('prog-kpis', className)}>
      <Kpi
        label={t('progress.kpi.completion')}
        value={fmtPercent(avgScore)}
        caption={
          scored > 0
            ? t('progress.kpi.average', { n: scored })
            : liveToday
              ? t('progress.kpi.todayLive')
              : t('progress.kpi.noTrackedDays')
        }
      />
      <Kpi
        label={t('progress.kpi.streak')}
        value={streakDays.value}
        unit={streakDays.unit}
        caption={
          isCurrent
            ? t('progress.kpi.threshold', { pct: Math.round(threshold * 100) })
            : t('progress.kpi.asOf', { date: fmtDateShort(stats.to, lang) })
        }
      />
      <Kpi
        label={t('progress.kpi.tasks')}
        value={`${totals.tasksDone} / ${totals.tasksTotal}`}
        caption={
          totals.tasksTotal > 0
            ? t('progress.kpi.tasksDone', { pct: fmtPercent(totals.tasksDone / totals.tasksTotal) })
            : t('progress.kpi.noTasks')
        }
      />
      <Kpi
        label={t('progress.kpi.rating')}
        value={totals.avgRating != null ? fmtDecimal(totals.avgRating, lang) : '—'}
        unit={totals.avgRating != null ? '/ 5' : undefined}
        caption={rated > 0 ? t('progress.kpi.average', { n: rated }) : t('progress.kpi.noRatings')}
      />
    </dl>
  );
}
