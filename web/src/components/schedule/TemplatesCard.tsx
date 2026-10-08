// Sekcija "Šabloni": kartica po šablonu (naziv, mini traka, broj blokova, dani) + editor.

import { useEffect, useRef, useState } from 'react';
import type { Category, Template, WeekdayMap } from '../../../../shared/types.ts';
import { WEEKDAY_SHORT } from '../../../../shared/time.ts';
import { useCategoryMap, useScheduleData } from '../../lib/store.ts';
import { Button, Card, Icon } from '../../ui/index.ts';
import { MiniTimeline } from './MiniTimeline.tsx';
import { NewTemplateSheet } from './NewTemplateSheet.tsx';
import { TemplateEditor } from './TemplateEditor.tsx';
import { blocksLabel, weekdaysUsing } from './util.ts';

/**
 * `editingId` (šablon otvoren u editoru) drži stranica: kartica se pri prvom šablonu premešta na
 * drugo mesto na stranici (vidi SchedulePage), pa bi njeno stanje nestalo baš kad se editor otvara.
 */
export function TemplatesCard({
  editingId,
  setEditingId,
}: {
  editingId: number | null;
  setEditingId: (id: number | null) => void;
}) {
  const { templates, weekdays, settings } = useScheduleData();
  const catMap = useCategoryMap();
  const [newOpen, setNewOpen] = useState(false);
  // Šablon obrisan na drugom uređaju dok je editor otvoren: editor ostaje sa poslednjom poznatom
  // verzijom (izmene se ne gube bez reči; čuvanje javi da šablon više ne postoji).
  const lastEditing = useRef<Template | null>(null);
  const live = editingId != null ? templates.find((t) => t.id === editingId) : undefined;
  if (live) lastEditing.current = live;
  const editing =
    editingId == null ? null : (live ?? (lastEditing.current?.id === editingId ? lastEditing.current : null));
  // Šablon koji ova kartica nikad nije videla (obrisan dok se kartica premeštala): zaboravi ga, da
  // se editor sam ne otvori kad novi šablon dobije isti id.
  useEffect(() => {
    if (editingId != null && editing == null) setEditingId(null);
  }, [editingId, editing, setEditingId]);

  return (
    <Card
      title="Šabloni"
      flush
      actions={
        templates.length > 0 && (
          <Button variant="ghost" size="sm" icon="plus" onClick={() => setNewOpen(true)}>
            Novi šablon
          </Button>
        )
      }
    >
      {templates.length === 0 ? (
        <div className="sched-empty">
          <p className="sched-empty-line">Šablon je plan dana koji se ponavlja.</p>
          <Button icon="plus" onClick={() => setNewOpen(true)}>
            Novi šablon
          </Button>
        </div>
      ) : (
        <>
          <p className="sched-hint">
            Izmene važe za buduće dane koje nisi menjao. Danas i ranije dane osveži sa ⋯ → Vrati na šablon.
          </p>
          <ul className="sched-tpl-list">
            {templates.map((t) => (
              <li key={t.id}>
                <TemplateRow
                  template={t}
                  weekdays={weekdays}
                  dayStart={settings.dayStart}
                  catMap={catMap}
                  onOpen={() => setEditingId(t.id)}
                />
              </li>
            ))}
          </ul>
        </>
      )}

      {editing && (
        <TemplateEditor
          key={editing.id}
          template={editing}
          onClose={() => setEditingId(null)}
          onOpenTemplate={setEditingId}
        />
      )}
      {newOpen && (
        <NewTemplateSheet
          onClose={() => setNewOpen(false)}
          onCreated={(id) => {
            setNewOpen(false);
            setEditingId(id);
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
  const days = weekdaysUsing(weekdays, template.id);
  return (
    <button type="button" className="sched-tpl" onClick={onOpen}>
      <span className="sched-tpl-top">
        <span className="sched-tpl-name">{template.name}</span>
        <span className="sched-tpl-count">{blocksLabel(template.blocks.length)}</span>
        <Icon name="chevron-right" size={18} className="sched-chev" />
      </span>
      <MiniTimeline blocks={template.blocks} dayStart={dayStart} catMap={catMap} />
      <span className="sched-days">
        {days.length > 0 ? (
          days.map((d) => (
            <span key={d} className="sched-daychip">
              {WEEKDAY_SHORT[d - 1]}
            </span>
          ))
        ) : (
          <span className="sched-days-none">Nije dodeljen nijednom danu</span>
        )}
      </span>
    </button>
  );
}
