// Sekcija "Dani u nedelji": koji šablon važi za koji dan u nedelji.

import { useRef, useState } from 'react';
import type { Weekday, WeekdayMap } from '../../../../shared/types.ts';
import { capitalize, isoWeekday, weekdayName } from '../../../../shared/time.ts';
import { api, errorMessage } from '../../api.ts';
import { useLang, useT } from '../../i18n/index.ts';
import { useLogicalNow } from '../../lib/hooks.ts';
import { enqueue } from '../../lib/queue.ts';
import { scheduleStore, useScheduleData } from '../../lib/store.ts';
import { Card, Select, cx, toast } from '../../ui/index.ts';
import { WEEKDAYS } from './util.ts';

export function WeekdaysCard() {
  const t = useT();
  const lang = useLang();
  const { templates, weekdays } = useScheduleData();
  const today = isoWeekday(useLogicalNow().date);

  // Optimistička izmena: prikazuje se odmah, server je potvrdi ili se vraća na stanje iz store-a.
  const [optimistic, setOptimistic] = useState<WeekdayMap | null>(null);
  const seq = useRef(0);
  const map = optimistic ?? weekdays;
  // Bez šablona nema šta da se dodeli: redovi su tu (da se vidi šta sledi), ali onemogućeni.
  const none = templates.length === 0;

  async function change(wd: Weekday, value: string) {
    const tid = value ? Number(value) : null;
    const mine = ++seq.current;
    setOptimistic({ ...map, [wd]: tid });
    try {
      // Šalje se samo promenjeni dan: ostali dani ostaju kako su na serveru (možda ih je u
      // međuvremenu menjao drugi uređaj, a ovaj ekran to još ne zna). Zajednički red zahteva:
      // zahtevi idu jedan za drugim (odgovor poslednjeg sadrži i sve ranije izmene), a "Osveži" i
      // odjava čekaju i njih (whenQueueIdle).
      const payload = await enqueue(() => api.putWeekdays({ [wd]: tid }));
      // Važi samo odgovor na poslednji zahtev (on sadrži i ranije).
      if (mine !== seq.current) return;
      scheduleStore.set(payload);
      setOptimistic(null);
    } catch (e) {
      if (mine !== seq.current) return;
      setOptimistic(null);
      toast.error(errorMessage(e));
      // Raniji zahtev je možda uspeo pa store kasni — tiho osveži (kopija iz keša se ne prihvata).
      void scheduleStore.refresh();
    }
  }

  return (
    <Card title={t('schedule.weekdays.title')} className="sched-card-wd">
      {none && <p className="sched-empty-line">{t('schedule.weekdays.needTemplate')}</p>}
      <div className={cx('sched-wd-list', none && 'is-disabled')}>
        {WEEKDAYS.map((wd) => {
          const tid = map[wd];
          const selected = tid != null ? templates.find((tpl) => tpl.id === tid) : undefined;
          return (
            <label key={wd} className="sched-wd-row">
              <span className="sched-wd-name">
                <span>{capitalize(weekdayName(wd, lang))}</span>
                {wd === today && <span className="sched-wd-today">{t('schedule.weekdays.today')}</span>}
              </span>
              <Select
                value={selected ? String(selected.id) : ''}
                title={selected?.name}
                onChange={(e) => change(wd, e.target.value)}
                disabled={none}
              >
                <option value="">{t('schedule.weekdays.none')}</option>
                {templates.map((tpl) => (
                  <option key={tpl.id} value={tpl.id}>
                    {tpl.name}
                  </option>
                ))}
              </Select>
            </label>
          );
        })}
      </div>
    </Card>
  );
}
