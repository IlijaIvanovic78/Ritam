// Sekcija "Dani u nedelji": koji šablon važi za koji dan u nedelji.

import { useRef, useState } from 'react';
import type { Weekday, WeekdayMap } from '../../../../shared/types.ts';
import { WEEKDAY_NAMES, capitalize, isoWeekday } from '../../../../shared/time.ts';
import { api, errorMessage } from '../../api.ts';
import { useLogicalNow } from '../../lib/hooks.ts';
import { scheduleStore, useScheduleData } from '../../lib/store.ts';
import { Card, Select, cx, toast } from '../../ui/index.ts';
import { WEEKDAYS } from './util.ts';

export function WeekdaysCard() {
  const { templates, weekdays } = useScheduleData();
  const today = isoWeekday(useLogicalNow().date);

  // Optimistička izmena: prikazuje se odmah, server je potvrdi ili se vraća na stanje iz store-a.
  const [optimistic, setOptimistic] = useState<WeekdayMap | null>(null);
  const seq = useRef(0);
  /** Zahtevi idu jedan za drugim, pa odgovor poslednjeg sadrži i sve ranije izmene. */
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const map = optimistic ?? weekdays;
  const known = new Set(templates.map((t) => t.id));
  // Bez šablona nema šta da se dodeli: redovi su tu (da se vidi šta sledi), ali onemogućeni.
  const none = templates.length === 0;

  async function change(wd: Weekday, value: string) {
    const tid = value ? Number(value) : null;
    const mine = ++seq.current;
    setOptimistic({ ...map, [wd]: tid });
    try {
      // Šalje se samo promenjeni dan: ostali dani ostaju kako su na serveru (možda ih je u
      // međuvremenu menjao drugi uređaj, a ovaj ekran to još ne zna).
      const req = chain.current.then(() => api.putWeekdays({ [wd]: tid }));
      chain.current = req.catch(() => {});
      const payload = await req;
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
    <Card title="Dani u nedelji" className="sched-card-wd">
      {none && <p className="sched-empty-line">Prvo napravi šablon.</p>}
      <div className={cx('sched-wd-list', none && 'is-disabled')}>
        {WEEKDAYS.map((wd) => {
          const tid = map[wd];
          return (
            <label key={wd} className="sched-wd-row">
              <span className="sched-wd-name">
                <span>{capitalize(WEEKDAY_NAMES[wd - 1])}</span>
                {wd === today && <span className="sched-wd-today">danas</span>}
              </span>
              <Select
                value={tid != null && known.has(tid) ? String(tid) : ''}
                onChange={(e) => change(wd, e.target.value)}
                disabled={none}
              >
                <option value="">Bez šablona</option>
                {templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
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
