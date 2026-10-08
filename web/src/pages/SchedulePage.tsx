// Raspored: šablon po danu u nedelji, planirani sati, šabloni i kategorije (SPEC 6.4).

import { useState } from 'react';
import { WeekdaysCard } from '../components/schedule/WeekdaysCard.tsx';
import { WeeklyPlanCard } from '../components/schedule/WeeklyPlanCard.tsx';
import { TemplatesCard } from '../components/schedule/TemplatesCard.tsx';
import { CategoriesCard } from '../components/schedule/CategoriesCard.tsx';
import { Link, paths } from '../lib/router.tsx';
import { useScheduleData } from '../lib/store.ts';
import { Icon, PageHeader } from '../ui/index.ts';
import './schedule.css';

export default function SchedulePage() {
  const { templates } = useScheduleData();
  // Šablon otvoren u editoru (kartica Šabloni menja mesto kad nastane prvi šablon, pa stanje drži stranica).
  const [editingId, setEditingId] = useState<number | null>(null);

  const weekdays = <WeekdaysCard />;
  const plan = <WeeklyPlanCard />;
  const tpls = <TemplatesCard editingId={editingId} setEditingId={setEditingId} />;
  const cats = <CategoriesCard />;

  return (
    <div className="page sched-page">
      <PageHeader
        title="Raspored"
        actions={
          // Telefon: jedini put do Podešavanja. Na desktopu su u bočnoj traci, pa se ovde ne prikazuju.
          <Link
            to={paths.settings}
            className="icon-btn icon-btn-ghost sched-settings-link"
            aria-label="Podešavanja"
            title="Podešavanja"
          >
            <Icon name="settings" size={20} />
          </Link>
        }
      />
      {templates.length === 0 ? (
        // Prvo podešavanje (još nema šablona): redom kojim se raspored pravi — kategorije, šablon,
        // pa dani u nedelji (isti redosled kao koraci na stranici Danas).
        <div className="sched-grid">
          <div className="sched-col">
            {cats}
            {tpls}
          </div>
          <div className="sched-col">{weekdays}</div>
        </div>
      ) : (
        // Telefon: jedna kolona redom. Široki ekran: nedelja i plan levo, šabloni i kategorije desno.
        <div className="sched-grid">
          <div className="sched-col">
            {weekdays}
            {plan}
          </div>
          <div className="sched-col">
            {tpls}
            {cats}
          </div>
        </div>
      )}
    </div>
  );
}
