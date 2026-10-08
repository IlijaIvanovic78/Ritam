// KPI red: ispunjenost, niz, zadaci, ocena dana.

import type { ReactNode } from 'react';
import type { StatsPayload } from '../../../../shared/types.ts';
import { fmtDateShort, fmtPercent } from '../../../../shared/time.ts';
import { cx } from '../../ui/index.ts';
import { danWord, fmtDecimal, isLiveDay } from './period.ts';

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

  return (
    <dl className={cx('prog-kpis', className)}>
      <Kpi
        label="Ispunjenost"
        value={fmtPercent(avgScore)}
        caption={
          scored > 0 ? `prosek za ${scored} ${danWord(scored)}` : liveToday ? 'danas je u toku' : 'nema praćenih dana'
        }
      />
      <Kpi
        label="Niz"
        value={streak}
        unit={danWord(streak)}
        caption={isCurrent ? `prag ${Math.round(threshold * 100)}%` : `do ${fmtDateShort(stats.to)}`}
      />
      <Kpi
        label="Zadaci"
        value={`${totals.tasksDone} / ${totals.tasksTotal}`}
        caption={totals.tasksTotal > 0 ? `${fmtPercent(totals.tasksDone / totals.tasksTotal)} urađeno` : 'nema zadataka'}
      />
      <Kpi
        label="Ocena dana"
        value={totals.avgRating != null ? fmtDecimal(totals.avgRating) : '—'}
        unit={totals.avgRating != null ? '/ 5' : undefined}
        caption={rated > 0 ? `prosek za ${rated} ${danWord(rated)}` : 'bez ocena'}
      />
    </dl>
  );
}
