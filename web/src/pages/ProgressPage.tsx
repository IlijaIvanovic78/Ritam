// Napredak: statistika po nedelji ili mesecu + poslednjih 12 nedelja.

import { useEffect, useRef, useState } from 'react';
import type { StatsPayload, Task } from '../../../shared/types.ts';
import { addDays, diffDays, eachDay, startOfWeek } from '../../../shared/time.ts';
import { api, errorMessage } from '../api.ts';
import { CategoryList } from '../components/progress/CategoryList.tsx';
import { DoneTasks } from '../components/progress/DoneTasks.tsx';
import { Kpis } from '../components/progress/Kpis.tsx';
import { MonthCalendar } from '../components/progress/MonthCalendar.tsx';
import { WeekChart } from '../components/progress/WeekChart.tsx';
import { HEATMAP_WEEKS, WeeksHeatmap } from '../components/progress/WeeksHeatmap.tsx';
import {
  byDate,
  clampEnd,
  periodContaining,
  periodContains,
  periodTitle,
  readHistorySel,
  resolvePeriod,
  selFor,
  shiftPeriod,
  writeHistorySel,
  type Period,
  type PeriodMode,
  type PeriodSel,
} from '../components/progress/period.ts';
import { useLogicalNow } from '../lib/hooks.ts';
import { Link, dayPath, navigate, paths } from '../lib/router.tsx';
import { useAllCategoryMap, useScheduleData, useSettings } from '../lib/store.ts';
import { Button, Card, Empty, IconButton, PageHeader, PageLoader, Segmented, Spinner, cx } from '../ui/index.ts';
import './progress.css';

interface PeriodData {
  key: string;
  period: Period;
  /** Poslednji dan sa podacima (kraj perioda ili danas). */
  to: string;
  stats: StatsPayload;
  tasks: Task[];
}

interface HeatData {
  from: string;
  to: string;
  stats: StatsPayload;
}

const MODE_OPTIONS: Array<{ value: PeriodMode; label: string }> = [
  { value: 'week', label: 'Nedelja' },
  { value: 'month', label: 'Mesec' },
];

/** Posle ovoliko vremena u pozadini podaci se tiho osveže pri povratku u aplikaciju. */
const REFRESH_AFTER_MS = 60_000;

// Poslednji podaci ostaju u memoriji dok je aplikacija otvorena: povratak sa stranice dana
// (klik na dan u kalendaru, pa "nazad") odmah prikaže istu stranicu pune visine, pa browser vrati
// i položaj skrolovanja; sadržaj se tiho osveži u pozadini.
const memo: { data: PeriodData | null; heat: HeatData | null } = { data: null, heat: null };

export default function ProgressPage() {
  const today = useLogicalNow().date;
  // Danas se otvara na "/", da bi se prikaz sam prebacio na novi dan.
  const openDay = (date: string) => navigate(dayPath(date, today));
  const { streakThreshold } = useSettings();
  // I obrisane kategorije: stari dani i zadaci ih zadržavaju (naziv, boja, "računa se").
  const catMap = useAllCategoryMap();
  const noTemplates = useScheduleData().templates.length === 0;

  const [sel, setSel] = useState<PeriodSel>(() => readHistorySel() ?? { mode: 'week', start: null });
  const period = resolvePeriod(sel, today);
  const isCurrent = periodContains(period, today);
  const fetchTo = clampEnd(period, today);
  const key = `${period.mode}|${period.start}|${fetchTo}`;

  const heatFrom = addDays(startOfWeek(today), -7 * (HEATMAP_WEEKS - 1));
  const heatKey = `${heatFrom}|${today}`;

  const [data, setData] = useState<PeriodData | null>(() => (memo.data?.key === key ? memo.data : null));
  const [dataError, setDataError] = useState<{ key: string; message: string } | null>(null);
  const [heat, setHeat] = useState<HeatData | null>(() =>
    memo.heat && `${memo.heat.from}|${memo.heat.to}` === heatKey ? memo.heat : null,
  );
  const [heatError, setHeatError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const loadedAt = useRef(0);

  // Zapamti period u history.state (povratak sa stranice dana vraća isti period).
  useEffect(() => {
    writeHistorySel(sel);
  }, [sel]);

  // Podaci za izabrani period. Zastareli odgovori (brzo listanje) se ignorišu.
  useEffect(() => {
    let cancelled = false;
    const p = period;
    const to = fetchTo;
    // today: završen period (to < danas) nema "grace" za poslednji dan niza.
    Promise.all([api.stats(p.start, to, today), api.doneTasks(p.start, to)])
      .then(([stats, tasks]) => {
        if (cancelled) return;
        loadedAt.current = Date.now();
        const next = { key, period: p, to, stats, tasks };
        memo.data = next;
        setData(next);
        setDataError(null);
      })
      .catch((e) => {
        if (!cancelled) setDataError({ key, message: errorMessage(e) });
      });
    return () => {
      cancelled = true;
    };
    // Namerno samo key (mode, start, to) i reload: `period` je nov objekat u svakom renderu.
  }, [key, reload]);

  // Poslednjih 12 nedelja (paralelno sa podacima perioda).
  useEffect(() => {
    let cancelled = false;
    const from = heatFrom;
    const to = today;
    api
      .stats(from, to, today)
      .then((stats) => {
        if (cancelled) return;
        const next = { from, to, stats };
        memo.heat = next;
        setHeat(next);
        setHeatError(null);
      })
      .catch((e) => {
        if (!cancelled) setHeatError(errorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, [heatKey, reload]);

  // Tiho osvežavanje kad se aplikacija vrati iz pozadine (npr. blokovi čekirani na drugom uređaju).
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() - loadedAt.current > REFRESH_AFTER_MS) {
        setReload((n) => n + 1);
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  const retry = () => setReload((n) => n + 1);

  // Funkcijski update-i: više brzih klikova se sabira i kad React još nije ponovo renderovao.
  const changeMode = (mode: PeriodMode) =>
    setSel((s) => {
      if (s.mode === mode) return s;
      // Novi period sadrži poslednji dan sa podacima tekućeg prikaza (za tekući period to je danas).
      return selFor(periodContaining(mode, clampEnd(resolvePeriod(s, today), today)), today);
    });
  const step = (dir: 1 | -1) =>
    setSel((s) => {
      const p = shiftPeriod(resolvePeriod(s, today), dir);
      return p.start > today ? s : selFor(p, today);
    });
  const reset = () => setSel((s) => ({ mode: s.mode, start: null }));

  const isWeek = period.mode === 'week';
  const stale = data != null && data.key !== key;
  const errorNow = dataError != null && dataError.key === key && !(data && data.key === key);
  const totalDays = diffDays(period.start, fetchTo) + 1;
  const trackedNow = data && data.key === key ? data.stats.totals.daysTracked : null;

  const heatCard = (
    <Card title="Poslednjih 12 nedelja" className="prog-hm-card prog-order-4">
      {heat ? (
        <WeeksHeatmap
          from={heat.from}
          lastDate={heat.to}
          days={byDate(heat.stats.days)}
          today={today}
          threshold={streakThreshold}
          onOpen={openDay}
        />
      ) : heatError ? (
        <div className="prog-note-row">
          <p className="prog-note">Nije učitano. {heatError}</p>
          <Button size="sm" variant="ghost" onClick={retry}>
            Pokušaj ponovo
          </Button>
        </div>
      ) : (
        <div className="prog-hm-loading">
          <Spinner small />
        </div>
      )}
    </Card>
  );

  let content;
  if (errorNow) {
    content = (
      <>
        <Card>
          <Empty
            title="Statistika nije učitana."
            text={dataError?.message}
            action={
              <Button variant="secondary" icon="refresh" onClick={retry}>
                Pokušaj ponovo
              </Button>
            }
          />
        </Card>
        {heatCard}
      </>
    );
  } else if (!data) {
    content = <PageLoader />;
  } else {
    const d = data;
    const days = byDate(d.stats.days);
    const nothing = d.stats.totals.daysTracked === 0 && d.stats.totals.tasksTotal === 0 && d.tasks.length === 0;
    const dataIsCurrent = periodContains(d.period, today);
    const staleCls = stale && 'is-stale';
    // Nova instalacija (nema šablona ni praćenih dana u poslednjih 12 nedelja): prazno stanje kaže
    // odakle se kreće. Ko radi bez šablona (blokovi po danu) i već ima praćene dane dobija tekst za period.
    const noSchedule = noTemplates && (heat == null || heat.stats.totals.daysTracked === 0);

    content = nothing ? (
      <>
        <Card className={cx('prog-fade', staleCls)}>
          {noSchedule ? (
            <Empty
              title="Još nema praćenih dana."
              text="Napravi raspored, pa oceni blokove na stranici Danas — napredak će se pojaviti ovde."
              action={
                <Link to={paths.schedule} className="btn btn-secondary">
                  Podesi raspored
                </Link>
              }
            />
          ) : (
            <Empty
              title={dataIsCurrent ? 'Još nema praćenih dana u ovom periodu.' : 'U ovom periodu nema praćenih dana.'}
              text="Oceni blokove na stranici Danas i napredak će se pojaviti ovde."
            />
          )}
        </Card>
        {heatCard}
      </>
    ) : (
      <>
        <Kpis
          stats={d.stats}
          isCurrent={dataIsCurrent}
          threshold={streakThreshold}
          today={today}
          className={cx('prog-fade', staleCls)}
        />

        {/* Dva nezavisna stuba kartica (visok spisak kategorija ne ostavlja rupu ispod grafika);
            na uskom ekranu jedna kolona redom: grafik, kategorije, zadaci, 12 nedelja. */}
        <div className="prog-grid">
          <div className="prog-col">
            <Card title="Ispunjenost po danu" className={cx('prog-fade', 'prog-order-1', staleCls)}>
              {d.period.mode === 'week' ? (
                <WeekChart
                  dates={eachDay(d.period.start, d.period.end)}
                  days={days}
                  lastDate={d.to}
                  today={today}
                  threshold={streakThreshold}
                  onOpen={openDay}
                />
              ) : (
                <MonthCalendar
                  start={d.period.start}
                  end={d.period.end}
                  days={days}
                  lastDate={d.to}
                  today={today}
                  threshold={streakThreshold}
                  onOpen={openDay}
                />
              )}
            </Card>
            <Card
              title="Završeni zadaci"
              actions={d.tasks.length > 0 ? <span className="prog-count">{d.tasks.length}</span> : undefined}
              className={cx('prog-fade', 'prog-order-3', staleCls)}
            >
              <DoneTasks key={d.key} tasks={d.tasks} today={today} catMap={catMap} />
            </Card>
          </div>
          <div className="prog-col">
            <Card title="Po kategoriji" className={cx('prog-fade', 'prog-order-2', staleCls)}>
              <CategoryList items={d.stats.totals.categories} catMap={catMap} />
            </Card>
            {heatCard}
          </div>
        </div>
      </>
    );
  }

  return (
    <div className="page prog">
      <PageHeader
        title="Napredak"
        actions={<Segmented label="Period" size="sm" value={period.mode} options={MODE_OPTIONS} onChange={changeMode} />}
      />

      <div className="prog-body" aria-busy={stale || !data || undefined}>
        <div className="prog-bar">
          <div className="prog-nav">
            <IconButton icon="chevron-left" label={isWeek ? 'Prethodna nedelja' : 'Prethodni mesec'} onClick={() => step(-1)} />
            <IconButton
              icon="chevron-right"
              label={isWeek ? 'Sledeća nedelja' : 'Sledeći mesec'}
              onClick={() => step(1)}
              disabled={period.end >= today}
            />
          </div>
          <div className="prog-period">
            <h2 className="prog-period-title" aria-live="polite">
              {periodTitle(period, today)}
            </h2>
            <p className="prog-period-sub">
              {trackedNow != null ? `Praćeno ${trackedNow} od ${totalDays} dana` : '\u00a0'}
            </p>
          </div>
          {!isCurrent && (
            <Button variant="ghost" size="sm" className="prog-reset" onClick={reset}>
              {isWeek ? 'Ova nedelja' : 'Ovaj mesec'}
            </Button>
          )}
        </div>

        {content}
      </div>
    </div>
  );
}
