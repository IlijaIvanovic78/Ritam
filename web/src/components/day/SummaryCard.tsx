import type { BlockSummary, Category } from '../../../../shared/types.ts';
import { fmtDuration, fmtPercent } from '../../../../shared/time.ts';
import { categoryColor, categoryName } from '../../lib/store.ts';
import { Card, CategoryDot, Icon, ProgressBar, Ring, cx, type IconName } from '../../ui/index.ts';
import { blocksWord } from './plural.ts';

const STATUS_COUNTS: Array<{ key: 'done' | 'partial' | 'skipped'; icon: IconName; label: string }> = [
  { key: 'done', icon: 'check', label: 'Urađeno' },
  { key: 'partial', icon: 'half', label: 'Delimično' },
  { key: 'skipped', icon: 'x', label: 'Nije urađeno' },
];

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
  const pct = preview ? '—' : fmtPercent(summary.score);
  // Samo kategorije koje se računaju u ispunjenost (blok bez kategorije se računa).
  const cats = summary.categories.filter(
    (ct) => ct.plannedMin > 0 && (ct.categoryId == null || catMap.get(ct.categoryId)?.counts !== false),
  );

  return (
    <Card title="Pregled" className="day-summary">
      <div className="day-sum-top">
        <Ring value={preview ? null : summary.score} size={68} stroke={6} label={`Ispunjenost ${pct}`}>
          {pct}
        </Ring>
        <div className="day-sum-stats">
          <p className="day-sum-line">
            Urađeno{' '}
            <strong className="tabular">
              {summary.done} / {summary.counted}
            </strong>{' '}
            {blocksWord(summary.counted)}
          </p>
          <p className="day-sum-statuses">
            {STATUS_COUNTS.map((s) => (
              <span
                key={s.key}
                className={cx('day-sum-status', `is-${s.key}`, summary[s.key] === 0 && 'is-zero')}
                title={s.label}
              >
                <Icon name={s.icon} size={14} />
                <span className="tabular">{summary[s.key]}</span>
                <span className="sr-only">{s.label}</span>
              </span>
            ))}
            {summary.pending > 0 && <span className="day-sum-pending tabular">{summary.pending} čeka</span>}
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
                  label={`${name}: ${fmtDuration(ct.doneMin)} od ${fmtDuration(ct.plannedMin)}`}
                />
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
