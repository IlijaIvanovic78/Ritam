import type { Category, Template, Weekday, WeekdayMap } from '../../../../shared/types.ts';
import { DAY_MIN, WEEKDAY_SHORT } from '../../../../shared/time.ts';
import { categoryColor } from '../../lib/store.ts';
import { Sheet, cx } from '../../ui/index.ts';
import { blocksWord } from './plural.ts';

/** Mala 24h traka šablona (od "dan počinje u" do istog vremena sutra). */
function MiniBar({ template, dayStart, catMap }: { template: Template; dayStart: number; catMap: Map<number, Category> }) {
  return (
    <span className="day-tpl-bar" aria-hidden="true">
      {template.blocks.map((b) => {
        const from = Math.max(0, b.start - dayStart);
        const to = Math.min(DAY_MIN, b.end - dayStart);
        if (to <= from) return null;
        return (
          <span
            key={b.id}
            style={{
              left: `${(from / DAY_MIN) * 100}%`,
              width: `${((to - from) / DAY_MIN) * 100}%`,
              background: categoryColor(catMap, b.categoryId),
            }}
          />
        );
      })}
    </span>
  );
}

/** Izbor šablona za jedan dan (ili prazan dan). */
export function TemplatePickerSheet({
  templates,
  weekdays,
  currentTemplateId,
  dayStart,
  catMap,
  onPick,
  onClose,
}: {
  templates: Template[];
  weekdays: WeekdayMap;
  /** Šablon iz kog je dan napravljen (ili koji se prikazuje kao pregled). */
  currentTemplateId: number | null;
  dayStart: number;
  catMap: Map<number, Category>;
  onPick: (templateId: number | null) => void;
  onClose: () => void;
}) {
  const usedOn = (id: number) =>
    ([1, 2, 3, 4, 5, 6, 7] as Weekday[]).filter((wd) => weekdays[wd] === id).map((wd) => WEEKDAY_SHORT[wd - 1]);

  return (
    <Sheet open onClose={onClose} title="Primeni šablon" size="sm">
      <p className="day-sheet-lead">Izabrani šablon zamenjuje blokove samo za ovaj dan. Raspored ostaje isti.</p>
      <ul className="day-tpl-list">
        {templates.map((t) => {
          const current = t.id === currentTemplateId;
          const days = usedOn(t.id);
          return (
            <li key={t.id}>
              <button type="button" className={cx('day-tpl', current && 'is-current')} onClick={() => onPick(t.id)}>
                <span className="day-tpl-top">
                  <span className="day-tpl-name">{t.name}</span>
                  {current && <span className="day-tpl-current">trenutni</span>}
                </span>
                <MiniBar template={t} dayStart={dayStart} catMap={catMap} />
                <span className="day-tpl-meta">
                  {t.blocks.length} {blocksWord(t.blocks.length)}
                  {days.length > 0 && <> · {days.join(', ')}</>}
                </span>
              </button>
            </li>
          );
        })}
        <li>
          <button type="button" className="day-tpl" onClick={() => onPick(null)}>
            <span className="day-tpl-top">
              <span className="day-tpl-name">Prazan dan</span>
            </span>
            <span className="day-tpl-meta">Bez blokova — dodaješ ih sam.</span>
          </button>
        </li>
      </ul>
    </Sheet>
  );
}
