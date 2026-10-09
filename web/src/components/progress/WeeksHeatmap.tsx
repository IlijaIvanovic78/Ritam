// Kompaktna heatmapa poslednjih 12 nedelja: kolone = nedelje, redovi = pon…ned.
// Ćelije su dugmad sa "roving tabindex": Tab ulazi u mrežu jednom, strelice se kreću
// (levo/desno = nedelja, gore/dole = dan).

import { useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { StatsDay } from '../../../../shared/types.ts';
import type { Lang } from '../../../../shared/types.ts';
import { addDays, monthShort as monthShortName, weekdayShortNames } from '../../../../shared/time.ts';
import { useLang, useT } from '../../i18n/index.ts';
import { cx } from '../../ui/index.ts';
import { HeatLegend } from './HeatLegend.tsx';
import { cellHeatClass, dayTip, isLiveDay } from './period.ts';

export const HEATMAP_WEEKS = 12;

const ARROWS: Record<string, number> = { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 };

const weekDates = (monday: string) => Array.from({ length: 7 }, (_, k) => addDays(monday, k));
const startsMonth = (monday: string) => weekDates(monday).find((d) => d.endsWith('-01'));
const monthShort = (iso: string, lang: Lang) => monthShortName(Number(iso.slice(5, 7)), lang);

export function WeeksHeatmap({
  from,
  lastDate,
  days,
  today,
  threshold,
  onOpen,
}: {
  /** Ponedeljak prve kolone. */
  from: string;
  /** Poslednji dan sa podacima (danas); kasniji dani u poslednjoj koloni su prazni. */
  lastDate: string;
  days: Map<string, StatsDay>;
  today: string;
  /** Prag za niz: danas ispod praga je "u toku" (neutralno). */
  threshold: number;
  onOpen: (date: string) => void;
}) {
  const lang = useLang();
  const t = useT();
  const gridRef = useRef<HTMLDivElement>(null);
  const [focusDate, setFocusDate] = useState(lastDate);
  const active = focusDate >= from && focusDate <= lastDate ? focusDate : lastDate;

  let hasLive = false;
  const weeks = Array.from({ length: HEATMAP_WEEKS }, (_, i) => addDays(from, i * 7));

  // Oznaka meseca iznad kolone u kojoj mesec počinje. Prva kolona dobija oznaku
  // svog meseca samo ako novi mesec ne počinje odmah u sledeće dve kolone (da se ne preklapaju).
  const monthLabels = weeks.map((monday, i) => {
    const first = startsMonth(monday);
    if (first) return monthShort(first, lang);
    if (i === 0 && !weeks.slice(1, 3).some((m) => startsMonth(m))) return monthShort(monday, lang);
    return '';
  });

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const delta = ARROWS[e.key];
    const date = (e.target as HTMLElement).dataset?.date;
    if (!delta || !date) return;
    e.preventDefault();
    const next = addDays(date, delta);
    if (next < from || next > lastDate) return;
    setFocusDate(next);
    gridRef.current?.querySelector<HTMLElement>(`[data-date="${next}"]`)?.focus();
  };

  return (
    <div className="prog-hm">
      <div
        ref={gridRef}
        className="prog-hm-grid"
        role="group"
        aria-label={t('progress.heatmap.label')}
        onKeyDown={onKeyDown}
      >
        <span aria-hidden="true" />
        {monthLabels.map((label, i) => (
          <span key={`m-${i}`} className="prog-hm-month" aria-hidden="true">
            {label}
          </span>
        ))}

        {weekdayShortNames(lang).map((wd, r) => (
          <Row key={wd} wd={wd}>
            {weeks.map((monday) => {
              const date = addDays(monday, r);
              if (date > lastDate) {
                return <span key={date} className="prog-hm-cell prog-heat-future" aria-hidden="true" />;
              }
              const day = days.get(date);
              const live = isLiveDay(date, day, today, threshold);
              if (live) hasLive = true;
              const tip = dayTip(date, day, today, live, lang);
              return (
                <button
                  key={date}
                  type="button"
                  data-date={date}
                  tabIndex={date === active ? 0 : -1}
                  className={cx('prog-hm-cell', cellHeatClass(day?.summary?.score, live), date === today && 'is-today')}
                  title={tip}
                  aria-label={tip}
                  aria-current={date === today ? 'date' : undefined}
                  onFocus={() => setFocusDate(date)}
                  onClick={() => onOpen(date)}
                />
              );
            })}
          </Row>
        ))}
      </div>
      <HeatLegend live={hasLive} />
    </div>
  );
}

/** Red mreže: oznaka dana + ćelije (CSS grid, pa red nema svoj element). */
function Row({ wd, children }: { wd: string; children: ReactNode }) {
  return (
    <>
      <span className="prog-hm-wd" aria-hidden="true">
        {wd}
      </span>
      {children}
    </>
  );
}
