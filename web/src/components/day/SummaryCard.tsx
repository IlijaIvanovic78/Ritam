import type { BlockSummary, Category } from '../../../../shared/types.ts';
import { fmtDuration, fmtPercent } from '../../../../shared/time.ts';
import { useT } from '../../i18n/index.ts';
import { categoryColor, categoryName } from '../../lib/store.ts';
import { Card, CategoryDot, Icon, ProgressBar, Ring, cx, type IconName } from '../../ui/index.ts';
import { SLOT } from './rich.tsx';

const STATUS_COUNTS: Array<{
  key: 'done' | 'partial' | 'skipped';
  icon: IconName;
  label: 'status.done' | 'status.partial' | 'status.skipped';
}> = [
  { key: 'done', icon: 'check', label: 'status.done' },
  { key: 'partial', icon: 'half', label: 'status.partial' },
  { key: 'skipped', icon: 'x', label: 'status.skipped' },
];

/**
 * "Urađeno 5 / 11 blokova" / "5 / 11 blocks done": "5 / 11" (od {done} do {n} u poruci) je istaknuto.
 * Poruka bez tog redosleda se prikaže kao običan tekst.
 */
function doneLine(text: string, done: number, counted: number) {
  const i = text.indexOf(SLOT);
  const j = i < 0 ? -1 : text.indexOf(String(counted), i + SLOT.length);
  if (j < 0) return text.replace(SLOT, String(done));
  const end = j + String(counted).length;
  return (
    <>
      {text.slice(0, i)}
      <strong className="tabular">{text.slice(i, end).replace(SLOT, String(done))}</strong>
      {text.slice(end)}
    </>
  );
}

/** Pregled dana: ispunjenost, statusi blokova i vreme po kategoriji. Računa se na klijentu. */
export function SummaryCard({
  summary,
  catMap,
  preview,
}: {
  summary: BlockSummary;
  catMap: Map<number, Category>;
  /** Pregled iz šablona — dan još nije počeo da se prati. */
  preview: boolean;
}) {
  const t = useT();
  const pct = preview ? '—' : fmtPercent(summary.score);
  // Samo kategorije koje se računaju u ispunjenost (blok bez kategorije se računa).
  const cats = summary.categories.filter(
    (ct) => ct.plannedMin > 0 && (ct.categoryId == null || catMap.get(ct.categoryId)?.counts !== false),
  );

  return (
    <Card title={t('day.summary.title')} className="day-summary">
      <div className="day-sum-top">
        <Ring value={preview ? null : summary.score} size={68} stroke={6} label={t('day.summary.scoreAria', { pct })}>
          {pct}
        </Ring>
        <div className="day-sum-stats">
          <p className="day-sum-line">
            {doneLine(
              t('day.summary.done', { done: SLOT, n: summary.counted }),
              summary.done,
              summary.counted,
            )}
          </p>
          <p className="day-sum-statuses">
            {STATUS_COUNTS.map((s) => (
              <span
                key={s.key}
                className={cx('day-sum-status', `is-${s.key}`, summary[s.key] === 0 && 'is-zero')}
                title={t(s.label)}
              >
                <Icon name={s.icon} size={14} />
                <span className="tabular">{summary[s.key]}</span>
                <span className="sr-only">{t(s.label)}</span>
              </span>
            ))}
            {summary.pending > 0 && (
              <span className="day-sum-pending tabular">{t('day.summary.pending', { count: summary.pending })}</span>
            )}
          </p>
        </div>
      </div>

      {cats.length > 0 && (
        <ul className="day-sum-cats">
          {cats.map((ct) => {
            const name = categoryName(catMap, ct.categoryId);
            const color = categoryColor(catMap, ct.categoryId);
            return (
              <li key={ct.categoryId ?? 'none'} className="day-sum-cat">
                <div className="day-sum-cat-head">
                  <span className="day-sum-cat-name">
                    <CategoryDot color={color} />
                    <span className="truncate">{name}</span>
                  </span>
                  <span className="day-sum-cat-time tabular">
                    {fmtDuration(ct.doneMin)} / {fmtDuration(ct.plannedMin)}
                  </span>
                </div>
                <ProgressBar
                  value={ct.doneMin / ct.plannedMin}
                  color={color}
                  label={t('day.summary.categoryAria', {
                    name,
                    done: fmtDuration(ct.doneMin),
                    planned: fmtDuration(ct.plannedMin),
                  })}
                />
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
