// Mini 24h traka dana: blokovi obojeni po kategoriji, od dayStart do dayStart + 24h.
// Renderuje samo <span> elemente da bi mogla da stoji unutar dugmeta.

import type { Category } from '../../../../shared/types.ts';
import { DAY_MIN, fmtClock } from '../../../../shared/time.ts';
import { categoryColor } from '../../lib/store.ts';
import { cx } from '../../ui/index.ts';

export interface TimelineSegment {
  start: number;
  end: number;
  title: string;
  categoryId: number | null;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Pune šestice zidnog sata (06:00, 12:00, 18:00, 00:00) unutar logičkog dana, bez ivica. */
function sixHourTicks(dayStart: number): number[] {
  const out: number[] = [];
  for (let m = Math.floor(dayStart / 360) * 360 + 360; m < dayStart + DAY_MIN; m += 360) out.push(m);
  return out;
}

export function MiniTimeline({
  blocks,
  dayStart,
  catMap,
  axis = true,
  className,
}: {
  blocks: TimelineSegment[];
  dayStart: number;
  catMap: Map<number, Category>;
  /** Oznake sati ispod trake. */
  axis?: boolean;
  className?: string;
}) {
  const ticks = sixHourTicks(dayStart);
  const pos = (m: number) => clamp01((m - dayStart) / DAY_MIN) * 100;

  return (
    <span className={cx('sched-tl', className)} aria-hidden="true">
      <span className="sched-tl-bar">
        {blocks.map((b, i) => {
          const left = pos(b.start);
          const right = pos(b.end);
          if (right <= left) return null;
          return (
            <span
              key={`${i}-${b.start}`}
              className="sched-tl-seg"
              style={{ left: `${left}%`, width: `${right - left}%`, background: categoryColor(catMap, b.categoryId) }}
              title={`${fmtClock(b.start)}–${fmtClock(b.end)}  ${b.title}`}
            />
          );
        })}
      </span>
      {axis && (
        <span className="sched-tl-axis">
          {ticks.map((m) => {
            const p = pos(m);
            return (
              <span key={m}>
                <span className="sched-tl-tick" style={{ left: `${p}%` }} />
                <span
                  className={cx('sched-tl-label', p < 6 && 'is-start', p > 94 && 'is-end')}
                  style={{ left: `${p}%` }}
                >
                  {fmtClock(m)}
                </span>
              </span>
            );
          })}
        </span>
      )}
    </span>
  );
}
