import type { Category, Template, Weekday, WeekdayMap } from '../../../../shared/types.ts';
import { DAY_MIN, weekdayShort } from '../../../../shared/time.ts';
import { useLang, useT } from '../../i18n/index.ts';
import { categoryColor } from '../../lib/store.ts';
import { Sheet, cx } from '../../ui/index.ts';

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
  const lang = useLang();
  const t = useT();
  const usedOn = (id: number) =>
    ([1, 2, 3, 4, 5, 6, 7] as Weekday[]).filter((wd) => weekdays[wd] === id).map((wd) => weekdayShort(wd, lang));

  return (
    <Sheet open onClose={onClose} title={t('day.picker.title')} size="sm">
      <p className="day-sheet-lead">{t('day.picker.lead')}</p>
      <ul className="day-tpl-list">
        {templates.map((tpl) => {
          const current = tpl.id === currentTemplateId;
          const days = usedOn(tpl.id);
          return (
            <li key={tpl.id}>
              <button type="button" className={cx('day-tpl', current && 'is-current')} onClick={() => onPick(tpl.id)}>
                <span className="day-tpl-top">
                  <span className="day-tpl-name">{tpl.name}</span>
                  {current && <span className="day-tpl-current">{t('day.picker.current')}</span>}
                </span>
                <MiniBar template={tpl} dayStart={dayStart} catMap={catMap} />
                <span className="day-tpl-meta">
                  {t('common.blocks', { n: tpl.blocks.length })}
                  {days.length > 0 && <> · {days.join(', ')}</>}
                </span>
              </button>
            </li>
          );
        })}
        <li>
          <button type="button" className="day-tpl" onClick={() => onPick(null)}>
            <span className="day-tpl-top">
              <span className="day-tpl-name">{t('day.picker.empty')}</span>
            </span>
            <span className="day-tpl-meta">{t('day.picker.emptyHint')}</span>
          </button>
        </li>
      </ul>
    </Sheet>
  );
}
