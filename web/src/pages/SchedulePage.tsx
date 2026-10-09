// Raspored: šablon po danu u nedelji, planirani sati, šabloni i kategorije (SPEC 6.4). Šablon otvoren iz kartice
// Šabloni ima svoju adresu (/raspored/sablon/:id) i uređuje se kao niz blokova (TemplateEditor).

import { WeekdaysCard } from '../components/schedule/WeekdaysCard.tsx';
import { WeeklyPlanCard } from '../components/schedule/WeeklyPlanCard.tsx';
import { TemplatesCard } from '../components/schedule/TemplatesCard.tsx';
import { CategoriesCard } from '../components/schedule/CategoriesCard.tsx';
import { TemplateEditor } from '../components/schedule/TemplateEditor.tsx';
import { useT } from '../i18n/index.ts';
import { Link, paths } from '../lib/router.tsx';
import { useScheduleData } from '../lib/store.ts';
import { Icon, PageHeader } from '../ui/index.ts';
import './schedule.css';

export default function SchedulePage({ templateId }: { templateId: number | null }) {
  return templateId != null ? <TemplateEditor key={templateId} templateId={templateId} /> : <ScheduleOverview />;
}

function ScheduleOverview() {
  const t = useT();
  const { templates } = useScheduleData();

  const weekdays = <WeekdaysCard />;
  const plan = <WeeklyPlanCard />;
  const tpls = <TemplatesCard />;
  const cats = <CategoriesCard />;

  return (
    <div className="page sched-page">
      <PageHeader
        title={t('shell.page.schedule')}
        actions={
          // Telefon: jedini put do Podešavanja. Na desktopu su u bočnoj traci, pa se ovde ne prikazuju.
          <Link
            to={paths.settings}
            className="icon-btn icon-btn-ghost sched-settings-link"
            aria-label={t('shell.page.settings')}
            title={t('shell.page.settings')}
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
