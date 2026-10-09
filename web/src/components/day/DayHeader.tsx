import { useRef } from 'react';
import {
  addDays,
  capitalize,
  diffDays,
  fmtDayMonth,
  isValidISODate,
  isoWeekday,
  weekdayName,
} from '../../../../shared/time.ts';
import { useLang, useT, type TFunction } from '../../i18n/index.ts';
import { Button, Icon, IconButton, PageHeader } from '../../ui/index.ts';
import { DayMenu, type MenuItem } from './DayMenu.tsx';

/** "Yesterday", "Tomorrow", "3 days ago", "In 5 days" / "Juče", "Sutra", "Pre 3 dana", "Za 5 dana". */
function relativeLabel(t: TFunction, today: string, date: string): string {
  const d = diffDays(today, date);
  if (d === -1) return t('common.yesterday');
  if (d === 1) return t('common.tomorrow');
  const n = Math.abs(d);
  return d < 0 ? t('day.header.daysAgo', { n }) : t('day.header.inDays', { n });
}

/**
 * Zaglavlje dana: datum (klik = izbor datuma), oznaka/relativni dan, šablon, navigacija i meni.
 * Desktop: "Thursday, October 8" / "Četvrtak, 8. oktobar". Telefon: naslov "October 8" / "8. oktobar" (staje u
 * jedan red pored dugmadi), a dan u nedelji ide u podnaslov: "Četvrtak · Danas · <šablon>" / "Ponedeljak · pre 3 dana".
 */
export function DayHeader({
  date,
  today,
  templateName,
  isDesktop,
  onGo,
  menuItems,
}: {
  date: string;
  today: string;
  templateName: string | null;
  isDesktop: boolean;
  onGo: (date: string) => void;
  menuItems: MenuItem[];
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const lang = useLang();
  const t = useT();
  const isToday = date === today;
  const weekday = capitalize(weekdayName(isoWeekday(date), lang));
  // Dan i mesec se ne razdvajaju pri prelamanju (nbsp), da "8." / "October 8" ne ostane sam u redu.
  const dayMonth = fmtDayMonth(date, lang, date.slice(0, 4) !== today.slice(0, 4));
  const label = isDesktop ? `${weekday}, ${dayMonth}` : dayMonth;
  // Poslednja reč + strelica se ne razdvajaju pri prelamanju naslova.
  const cut = label.lastIndexOf(' ') + 1;

  const openPicker = () => {
    const el = inputRef.current;
    if (!el) return;
    if (typeof el.showPicker === 'function') {
      try {
        el.showPicker();
        return;
      } catch {
        // npr. browser bez podrške za date picker na ovom elementu — padamo na focus/click
      }
    }
    el.focus();
    el.click();
  };

  const todayButton = !isToday && (
    <Button size="sm" className={isDesktop ? undefined : 'day-today-btn'} onClick={() => onGo(today)}>
      {t('common.today')}
    </Button>
  );

  const dot = <span aria-hidden="true">·</span>;
  const template = templateName && (
    <>
      {dot}
      <span className="truncate">{templateName}</span>
    </>
  );

  return (
    <PageHeader
      className="day-head"
      title={
        <span className="day-date">
          <button type="button" className="day-date-btn" onClick={openPicker} title={t('day.header.pickDate')}>
            {label.slice(0, cut)}
            <span className="day-date-last">
              {label.slice(cut)}
              <Icon name="chevron-down" size={18} className="day-date-chev" />
            </span>
          </button>
          <input
            ref={inputRef}
            type="date"
            className="day-date-input"
            value={date}
            onChange={(e) => {
              const v = e.target.value;
              if (isValidISODate(v) && v !== date) onGo(v);
            }}
            tabIndex={-1}
            aria-hidden="true"
          />
        </span>
      }
      sub={
        isDesktop ? (
          <span className="day-sub">
            {isToday ? <span className="day-tag">{t('common.today')}</span> : <span>{relativeLabel(t, today, date)}</span>}
            {template}
          </span>
        ) : (
          <span className="day-sub">
            <span>{weekday}</span>
            {dot}
            {isToday ? (
              <span className="day-tag">{t('common.today')}</span>
            ) : (
              <span>{relativeLabel(t, today, date).toLowerCase()}</span>
            )}
            {/* Šablon ranijeg/budućeg dana piše u traci pregleda; ovde samo za danas. */}
            {isToday && template}
            {todayButton}
          </span>
        )
      }
      actions={
        <>
          {isDesktop && todayButton}
          <IconButton icon="chevron-left" label={t('day.header.prevDay')} onClick={() => onGo(addDays(date, -1))} />
          <IconButton icon="chevron-right" label={t('day.header.nextDay')} onClick={() => onGo(addDays(date, 1))} />
          <DayMenu items={[...menuItems, { label: t('day.menu.goToDate'), icon: 'calendar', onSelect: openPicker }]} />
        </>
      }
    />
  );
}
