// Stubičasti grafik ispunjenosti po danu za jednu nedelju (7 stubova), ručno u SVG-u.

import { useId, type KeyboardEvent } from 'react';
import type { StatsDay } from '../../../../shared/types.ts';
import { fmtPercent, isoWeekday, weekdayShort } from '../../../../shared/time.ts';
import { useLang, useT } from '../../i18n/index.ts';
import { cx } from '../../ui/index.ts';
import { dayTip, isLiveDay } from './period.ts';
import { useElementWidth } from './useElementWidth.ts';

const TOP = 24; // prostor za vrednost iznad najvišeg stuba
const AXIS = 42; // oznake dana ispod
const BAR_MAX = 24;
const RADIUS = 4;
const STUB = 3; // vidljiv "patrljak" za 0% i nepraćene dane

type BarTone = 'done' | 'partial' | 'skipped';

function toneOf(score: number, threshold: number): BarTone {
  if (score >= threshold) return 'done';
  if (score >= 0.4) return 'partial';
  return 'skipped';
}

/** Stub sa zaobljenim vrhom (4px) i ravnom osnovom. */
function barPath(x: number, y: number, w: number, h: number): string {
  const r = Math.min(RADIUS, w / 2, h);
  return (
    `M${x},${y + h}V${y + r}` +
    `A${r},${r} 0 0 1 ${x + r},${y}H${x + w - r}` +
    `A${r},${r} 0 0 1 ${x + w},${y + r}V${y + h}Z`
  );
}

export function WeekChart({
  dates,
  days,
  lastDate,
  today,
  threshold,
  onOpen,
}: {
  dates: string[];
  days: Map<string, StatsDay>;
  /** Poslednji dan sa podacima; posle njega su budući dani. */
  lastDate: string;
  today: string;
  threshold: number;
  onOpen: (date: string) => void;
}) {
  const lang = useLang();
  const t = useT();
  const [ref, measured] = useElementWidth<HTMLDivElement>(320);
  const descId = useId();
  const w = Math.max(240, measured);
  // Visina oblasti za stubove (100%) raste sa širinom, u granicama 120–176px.
  const plot = Math.round(Math.min(176, Math.max(120, w * 0.3)));
  const H = TOP + plot + AXIS;
  const slot = w / dates.length;
  const bw = Math.min(BAR_MAX, Math.round(slot * 0.5));
  const base = TOP + plot;
  const thrY = Math.round(base - threshold * plot) + 0.5;
  const thrPct = Math.round(threshold * 100);

  let hasLive = false;
  const summary = dates
    .map((date) => {
      const wd = weekdayShort(isoWeekday(date), lang);
      if (date > lastDate) return t('progress.week.upcoming', { day: wd });
      const day = days.get(date);
      const score = day?.summary?.score ?? null;
      const live = isLiveDay(date, day, today, threshold);
      if (live) hasLive = true;
      const parts = [wd, score == null ? t('progress.notTracked') : fmtPercent(score)];
      if (live) parts.push(t('progress.live'));
      return parts.join(' ');
    })
    .join(', ');

  const onKey = (e: KeyboardEvent<SVGGElement>, date: string) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onOpen(date);
    }
  };

  return (
    <div className="prog-wk">
      <div ref={ref} className="prog-wk-plot">
        <svg
          viewBox={`0 0 ${w} ${H}`}
          role="group"
          aria-label={t('progress.byDay.title')}
          aria-describedby={descId}
        >
          {/* osnova i linija praga za niz */}
          <line className="prog-wk-axis" x1={0} x2={w} y1={base + 0.5} y2={base + 0.5} />
          <line className="prog-wk-thr" x1={0} x2={w} y1={thrY} y2={thrY} />

          {dates.map((date, i) => {
            const x0 = i * slot;
            const mid = x0 + slot / 2;
            const future = date > lastDate;
            const isToday = date === today;
            const day = days.get(date);
            const score = day?.summary?.score ?? null;
            const live = isLiveDay(date, day, today, threshold);
            const wd = weekdayShort(isoWeekday(date), lang);
            const dayNum = Number(date.slice(8));
            const tip = future ? '' : dayTip(date, day, today, live, lang);

            let mark = null;
            let value = null;
            if (!future) {
              if (score != null) {
                const h = Math.max(STUB, score * plot);
                const y = base - h;
                // Dan u toku: samo obris (bez boje ocene); 1px uvučen da linija ne bude odsečena.
                mark = live ? (
                  <path className="prog-wk-bar is-live" d={barPath(mid - bw / 2 + 0.75, y + 0.75, bw - 1.5, h - 0.75)} />
                ) : (
                  <path className={cx('prog-wk-bar', `is-${toneOf(score, threshold)}`)} d={barPath(mid - bw / 2, y, bw, h)} />
                );
                value = (
                  <text className={cx('prog-wk-val', live && 'is-live')} x={mid} y={y - 7} textAnchor="middle">
                    {fmtPercent(score)}
                  </text>
                );
              } else {
                mark = <rect className="prog-wk-none" x={mid - bw / 2} y={base - STUB} width={bw} height={STUB} rx={1} />;
                value = (
                  <text className="prog-wk-val is-none" x={mid} y={base - STUB - 7} textAnchor="middle">
                    —
                  </text>
                );
              }
            }

            return (
              <g
                key={date}
                className={cx('prog-wk-slot', !future && 'is-link', future && 'is-future', isToday && 'is-today')}
                role={future ? undefined : 'link'}
                tabIndex={future ? undefined : 0}
                aria-label={future ? undefined : tip}
                onClick={future ? undefined : () => onOpen(date)}
                onKeyDown={future ? undefined : (e) => onKey(e, date)}
              >
                {tip && <title>{tip}</title>}
                <rect className="prog-wk-hit" x={x0 + 2} y={2} width={Math.max(0, slot - 4)} height={H - 4} rx={6} />
                {mark}
                {value}
                <text className="prog-wk-wd" x={mid} y={base + 18} textAnchor="middle">
                  {wd}
                </text>
                <text className="prog-wk-num" x={mid} y={base + 34} textAnchor="middle">
                  {dayNum}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <p id={descId} className="sr-only">
        {t('progress.week.summary', { days: summary, pct: thrPct })}
      </p>

      <div className="prog-legend" aria-hidden="true">
        {threshold > 0.4 ? (
          <>
            <span className="prog-legend-item">
              <span className="prog-swatch is-done" />≥ {thrPct}%
            </span>
            <span className="prog-legend-item">
              <span className="prog-swatch is-partial" />
              40–{thrPct - 1}%
            </span>
            <span className="prog-legend-item">
              <span className="prog-swatch is-skipped" />
              &lt; 40%
            </span>
          </>
        ) : (
          <>
            <span className="prog-legend-item">
              <span className="prog-swatch is-done" />≥ {thrPct}%
            </span>
            <span className="prog-legend-item">
              <span className="prog-swatch is-skipped" />
              &lt; {thrPct}%
            </span>
          </>
        )}
        {hasLive && (
          <span className="prog-legend-item">
            <span className="prog-swatch is-live" />
            {t('progress.live')}
          </span>
        )}
        <span className="prog-legend-item">
          <span className="prog-legend-line" />
          {t('progress.legend.threshold')}
        </span>
      </div>
    </div>
  );
}
