// Sekcija "Šabloni": kartica po šablonu (naziv, mini traka, broj blokova, dani); dodir otvara uređivač šablona
// (ruta /raspored/sablon/:id).

import { useState } from 'react';
import type { Category, Template, WeekdayMap } from '../../../../shared/types.ts';
import { weekdayShort } from '../../../../shared/time.ts';
import { useLang, useT } from '../../i18n/index.ts';
import { useCategoryMap, useScheduleData } from '../../lib/store.ts';
import { Button, Card, Icon } from '../../ui/index.ts';
import { MiniTimeline } from './MiniTimeline.tsx';
import { NewTemplateSheet } from './NewTemplateSheet.tsx';
import { openTemplate } from './TemplateEditor.tsx';
import { weekdaysUsing } from './util.ts';

export function TemplatesCard() {
  const t = useT();
  const { templates, weekdays, settings } = useScheduleData();
  const catMap = useCategoryMap();
  const [newOpen, setNewOpen] = useState(false);

  return (
    <Card
      title={t('schedule.templates.title')}
      flush
      actions={
        templates.length > 0 && (
          <Button variant="ghost" size="sm" icon="plus" onClick={() => setNewOpen(true)}>
            {t('schedule.templates.new')}
          </Button>
        )
      }
    >
      {templates.length === 0 ? (
        <div className="sched-empty">
          <p className="sched-empty-line">{t('schedule.templates.empty')}</p>
          <Button icon="plus" onClick={() => setNewOpen(true)}>
            {t('schedule.templates.new')}
          </Button>
        </div>
      ) : (
        <>
          <p className="sched-hint">{t('schedule.templates.hint', { action: t('day.menu.resetToTemplate') })}</p>
          <ul className="sched-tpl-list">
            {templates.map((tpl) => (
              <li key={tpl.id}>
                <TemplateRow
                  template={tpl}
                  weekdays={weekdays}
                  dayStart={settings.dayStart}
                  catMap={catMap}
                  onOpen={() => openTemplate(tpl.id)}
                />
              </li>
            ))}
          </ul>
        </>
      )}

      {newOpen && (
        <NewTemplateSheet
          onClose={() => setNewOpen(false)}
          onCreated={(id) => {
            setNewOpen(false);
            openTemplate(id);
          }}
        />
      )}
    </Card>
  );
}

function TemplateRow({
  template,
  weekdays,
  dayStart,
  catMap,
  onOpen,
}: {
  template: Template;
  weekdays: WeekdayMap;
  dayStart: number;
  catMap: Map<number, Category>;
  onOpen: () => void;
}) {
  const t = useT();
  const lang = useLang();
  const days = weekdaysUsing(weekdays, template.id);
  return (
    <button type="button" className="sched-tpl" onClick={onOpen}>
      <span className="sched-tpl-top">
        <span className="sched-tpl-name">{template.name}</span>
        <span className="sched-tpl-count">{t('common.blocks', { n: template.blocks.length })}</span>
        <Icon name="chevron-right" size={18} className="sched-chev" />
      </span>
      <MiniTimeline blocks={template.blocks} dayStart={dayStart} catMap={catMap} />
      <span className="sched-days">
        {days.length > 0 ? (
          days.map((d) => (
            <span key={d} className="sched-daychip">
              {weekdayShort(d, lang)}
            </span>
          ))
        ) : (
          <span className="sched-days-none">{t('schedule.templates.unassigned')}</span>
        )}
      </span>
    </button>
  );
}
