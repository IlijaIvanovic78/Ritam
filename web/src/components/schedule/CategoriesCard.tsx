// Sekcija "Kategorije": lista sa bojom i nazivom, izmena u sheet-u.

import { useState } from 'react';
import type { Category } from '../../../../shared/types.ts';
import { useScheduleData } from '../../lib/store.ts';
import { Button, Card, CategoryDot, Icon } from '../../ui/index.ts';
import { CategorySheet } from './CategorySheet.tsx';

export function CategoriesCard() {
  const { categories } = useScheduleData();
  // null unutar objekta = nova kategorija; null spolja = sheet zatvoren.
  const [sheet, setSheet] = useState<{ category: Category | null } | null>(null);

  return (
    <Card
      title="Kategorije"
      flush
      actions={
        categories.length > 0 && (
          <Button variant="ghost" size="sm" icon="plus" onClick={() => setSheet({ category: null })}>
            Nova kategorija
          </Button>
        )
      }
    >
      {categories.length === 0 ? (
        <div className="sched-empty">
          <p className="sched-empty-line">Kategorija daje boju bloku i sabira vreme u Napretku.</p>
          <Button icon="plus" onClick={() => setSheet({ category: null })}>
            Nova kategorija
          </Button>
        </div>
      ) : (
        <ul className="sched-cat-list">
          {categories.map((c) => (
            <li key={c.id}>
              <button type="button" className="sched-cat" onClick={() => setSheet({ category: c })}>
                <CategoryDot color={c.color} />
                <span className="sched-cat-name truncate">{c.name}</span>
                {!c.counts && <span className="sched-tag">ne računa se</span>}
                <Icon name="chevron-right" size={18} className="sched-chev" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {sheet && <CategorySheet category={sheet.category} onClose={() => setSheet(null)} />}
    </Card>
  );
}
