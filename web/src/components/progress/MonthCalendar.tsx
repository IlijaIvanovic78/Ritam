// Kalendar-heatmapa za mesec: ćelija = dan, intenzitet po ispunjenosti.

import type { StatsDay } from '../../../../shared/types.ts';
import { WEEKDAY_SHORT, eachDay, fmtPercent, isoWeekday } from '../../../../shared/time.ts';
import { cx } from '../../ui/index.ts';
import { HeatLegend } from './HeatLegend.tsx';
import { cellHeatClass, dayTip, isLiveDay } from './period.ts';

export function MonthCalendar({
  start,
  end,
  days,
  lastDate,
  today,
  threshold,
  onOpen,
}: {
  start: string;
  end: string;
  days: Map<string, StatsDay>;
  /** Poslednji dan sa podacima; posle njega su budući dani. */
  lastDate: string;
  today: string;
  /** Prag za niz: danas ispod praga je "u toku" (neutralno). */
  threshold: number;
  onOpen: (date: string) => void;
}) {
  const lead = isoWeekday(start) - 1; // prazna mesta pre prvog dana (nedelja počinje ponedeljkom)
  let hasLive = false;

  return (
    <div className="prog-cal">
      <div className="prog-cal-head" aria-hidden="true">
        {WEEKDAY_SHORT.map((w) => (
          <span key={w}>{w}</span>
        ))}
      </div>
      <div className="prog-cal-grid" role="group" aria-label="Ispunjenost po danu u mesecu">
        {Array.from({ length: lead }, (_, i) => (
          <span key={`lead-${i}`} className="prog-cal-blank" aria-hidden="true" />
        ))}
        {eachDay(start, end).map((date) => {
          const num = Number(date.slice(8));
          if (date > lastDate) {
            return (
              <span key={date} className="prog-cal-cell prog-heat-future" aria-hidden="true">
                <span className="prog-cal-num">{num}</span>
              </span>
            );
          }
          const day = days.get(date);
          const score = day?.summary?.score ?? null;
          const live = isLiveDay(date, day, today, threshold);
          if (live) hasLive = true;
          const tip = dayTip(date, day, today, live);
          return (
            <button
              key={date}
              type="button"
              className={cx('prog-cal-cell', cellHeatClass(score, live), date === today && 'is-today')}
              title={tip}
              aria-label={tip}
              aria-current={date === today ? 'date' : undefined}
              onClick={() => onOpen(date)}
            >
              <span className="prog-cal-num">{num}</span>
              {score != null && <span className="prog-cal-pct">{fmtPercent(score)}</span>}
            </button>
          );
        })}
      </div>
      <HeatLegend live={hasLive} />
    </div>
  );
}
