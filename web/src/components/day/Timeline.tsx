import { useMemo } from 'react';
import type { Block, BlockStatus, Category, DayPayload } from '../../../../shared/types.ts';
import { fmtDuration } from '../../../../shared/time.ts';
import { Button, Card, Empty, Icon, IconButton, Spinner, cx } from '../../ui/index.ts';
import { BlockRow } from './BlockRow.tsx';
import { isDue, timelineItems } from './dayUtils.ts';

/** Vremenska linija dana: redovi blokova u kartici, praznine i "Dodaj blok" na kraju. */
export function Timeline({
  day,
  minute,
  past,
  catMap,
  initializing,
  hasTemplates,
  weekdayOffer = null,
  onApplyWeekday,
  onOpen,
  onStatus,
  onAdd,
  onPickTemplate,
}: {
  day: DayPayload;
  /** Logički minut ako je dan na ekranu danas, inače null. */
  minute: number | null;
  /** Dan pre današnjeg: na pregledu se blok može oceniti (to upisuje dan iz šablona). */
  past: boolean;
  catMap: Map<number, Category>;
  /** Dan se upravo inicijalizuje iz šablona. */
  initializing: boolean;
  /** Postoji bar jedan šablon (prazan dan nudi "Primeni šablon…"). */
  hasTemplates: boolean;
  /**
   * Dan je napravljen bez šablona, a za njegov dan u nedelji sada važi šablon (npr. blok je dodat
   * pre nego što je raspored napravljen): traka nudi da se primeni.
   */
  weekdayOffer?: { day: string; name: string } | null;
  onApplyWeekday?: () => void;
  onOpen: (block: Block, index: number) => void;
  onStatus: (block: Block, index: number, status: BlockStatus) => void;
  onAdd: () => void;
  onPickTemplate: () => void;
}) {
  const items = useMemo(() => timelineItems(day.blocks), [day.blocks]);
  const preview = !day.initialized;
  const empty = day.blocks.length === 0;

  return (
    <Card
      title="Blokovi"
      flush
      className="day-timeline"
      actions={<IconButton icon="plus" size="sm" label="Dodaj blok" onClick={onAdd} disabled={initializing} />}
    >
      {/* Prazan dan bez šablona: dovoljno je prazno stanje ispod (bez trake "nema šablona"). */}
      {preview && (initializing || !empty) && (
        <div className="day-banner" role="note">
          {initializing ? <Spinner small /> : <Icon name="info" size={16} />}
          <span>
            {initializing
              ? 'Pripremam dan…'
              : past
                ? day.templateName
                  ? `Dan nije praćen. Plan iz šablona „${day.templateName}“ — oceni neki blok i dan počinje da se prati.`
                  : 'Dan nije praćen. Za ovaj dan u nedelji nema šablona.'
                : day.templateName
                  ? `Plan iz šablona „${day.templateName}“ — izmene važe samo za ovaj dan.`
                  : 'Za ovaj dan u nedelji nema šablona. Dodaj blokove po želji.'}
          </span>
        </div>
      )}

      {weekdayOffer && !preview && (
        <div className="day-banner" role="note">
          <Icon name="info" size={16} />
          <span className="day-banner-text">
            Za {weekdayOffer.day} važi šablon „{weekdayOffer.name}“, a ovaj dan je napravljen bez šablona.
          </span>
          <Button size="sm" variant="ghost" className="day-banner-action" onClick={onApplyWeekday} disabled={initializing}>
            Primeni
          </Button>
        </div>
      )}

      {empty ? (
        <Empty
          title="Nema plana za ovaj dan."
          action={
            <span className="day-empty-actions">
              <Button size="sm" icon="plus" onClick={onAdd} disabled={initializing}>
                Dodaj blok
              </Button>
              {hasTemplates && (
                <Button size="sm" variant="ghost" onClick={onPickTemplate} disabled={initializing}>
                  Primeni šablon…
                </Button>
              )}
            </span>
          }
        />
      ) : (
        <ul className={cx('day-list', initializing && 'is-busy')}>
          {items.map((it) => {
            if (it.kind === 'gap') {
              const now = minute != null && minute >= it.start && minute < it.end;
              return (
                <li key={`gap-${it.start}`} className={cx('day-gap', now && 'is-now')}>
                  slobodno · {fmtDuration(it.end - it.start)}
                  {now && <span className="day-gap-now"> · sada</span>}
                </li>
              );
            }
            const b = it.block;
            const isNow = minute != null && b.start <= minute && minute < b.end;
            return (
              <BlockRow
                key={b.id}
                block={b}
                index={it.index}
                catMap={catMap}
                isNow={isNow}
                progress={isNow && minute != null ? (minute - b.start) / (b.end - b.start) : 0}
                isDue={minute != null && isDue(b, minute, catMap)}
                statusDisabled={preview && !past}
                onOpen={onOpen}
                onStatus={onStatus}
              />
            );
          })}
        </ul>
      )}

      {!empty && (
        <button type="button" className="day-add-row" onClick={onAdd} disabled={initializing}>
          <span className="day-add-icon">
            <Icon name="plus" size={18} />
          </span>
          Dodaj blok
        </button>
      )}
    </Card>
  );
}
