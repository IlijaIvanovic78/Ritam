// Planirano i urađeno po kategoriji za period. Kategorije koje se ne računaju
// u ispunjenost idu na kraj, prigušene.

import type { Category, CategoryTime } from '../../../../shared/types.ts';
import { fmtDuration, fmtPercent } from '../../../../shared/time.ts';
import { useLang, useT } from '../../i18n/index.ts';
import { categoryColor, categoryName } from '../../lib/store.ts';
import { CategoryDot, ProgressBar, cx } from '../../ui/index.ts';
import { fmtCount } from './period.ts';

export function CategoryList({ items, catMap }: { items: CategoryTime[]; catMap: Map<number, Category> }) {
  const t = useT();
  const planned = items.filter((c) => c.plannedMin > 0);
  // Blok bez kategorije (ili sa obrisanom) se računa, kao u shared/summary.ts.
  const counts = (c: CategoryTime) => c.categoryId == null || catMap.get(c.categoryId)?.counts !== false;
  const counting = planned.filter(counts);
  const other = planned.filter((c) => !counts(c));

  if (planned.length === 0) {
    return <p className="prog-note">{t('progress.categories.empty')}</p>;
  }

  return (
    <div className="prog-cats">
      <ul className="prog-cats-list">
        {counting.map((c) => (
          <CategoryRow key={c.categoryId ?? 'none'} item={c} catMap={catMap} />
        ))}
      </ul>
      {other.length > 0 && (
        <>
          <p className="prog-cats-sep">{t('progress.categories.notCounted')}</p>
          <ul className="prog-cats-list">
            {other.map((c) => (
              <CategoryRow key={c.categoryId ?? 'none'} item={c} catMap={catMap} dim />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function CategoryRow({ item, catMap, dim }: { item: CategoryTime; catMap: Map<number, Category>; dim?: boolean }) {
  const lang = useLang();
  const t = useT();
  const name = categoryName(catMap, item.categoryId);
  const color = categoryColor(catMap, item.categoryId);
  const ratio = item.plannedMin > 0 ? item.doneMin / item.plannedMin : 0;
  return (
    <li className={cx('prog-cat', dim && 'is-dim')}>
      <div className="prog-cat-top">
        <CategoryDot color={color} />
        <span className="prog-cat-name">{name}</span>
        <span className="prog-cat-pct">{fmtPercent(ratio)}</span>
      </div>
      <ProgressBar value={ratio} color={color} label={`${name}: ${fmtPercent(ratio)}`} className="prog-cat-bar" />
      <div className="prog-cat-meta">
        <span>
          {fmtDuration(item.doneMin)} <span className="prog-cat-of">{t('progress.categories.of')}</span>{' '}
          {fmtDuration(item.plannedMin)}
        </span>
        <span>
          {t('progress.categories.count', { done: fmtCount(item.doneCount, lang), n: item.plannedCount })}
        </span>
      </div>
    </li>
  );
}
