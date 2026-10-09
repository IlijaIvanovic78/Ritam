import { useMemo } from 'react';
import type { Block, BlockStatus, Category, DayPayload } from '../../../../shared/types.ts';
import { fmtDuration } from '../../../../shared/time.ts';
import { useT } from '../../i18n/index.ts';
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
  const t = useT();
  const items = useMemo(() => timelineItems(day.blocks), [day.blocks]);
  const preview = !day.initialized;
  const empty = day.blocks.length === 0;

  return (
    <Card
      title={t('day.timeline.title')}
      flush
      className="day-timeline"
      actions={<IconButton icon="plus" size="sm" label={t('day.addBlock')} onClick={onAdd} disabled={initializing} />}
    >
      {/* Prazan dan bez šablona: dovoljno je prazno stanje ispod (bez trake "nema šablona"). */}
      {preview && (initializing || !empty) && (
        <div className="day-banner" role="note">
          {initializing ? <Spinner small /> : <Icon name="info" size={16} />}
          <span>
            {initializing
              ? t('day.timeline.preparing')
              : past
                ? day.templateName
                  ? t('day.timeline.untrackedTemplate', { name: day.templateName })
                  : t('day.timeline.untrackedNoTemplate')
                : day.templateName
                  ? t('day.timeline.previewTemplate', { name: day.templateName })
                  : t('day.timeline.previewNoTemplate')}
          </span>
        </div>
      )}

      {weekdayOffer && !preview && (
        <div className="day-banner" role="note">
          <Icon name="info" size={16} />
          <span className="day-banner-text">
            {t('day.timeline.weekdayOffer', { day: weekdayOffer.day, name: weekdayOffer.name })}
          </span>
          <Button size="sm" variant="ghost" className="day-banner-action" onClick={onApplyWeekday} disabled={initializing}>
            {t('day.template.apply')}
          </Button>
        </div>
      )}

      {empty ? (
        <Empty
          title={t('day.timeline.empty')}
          action={
            <span className="day-empty-actions">
              <Button size="sm" icon="plus" onClick={onAdd} disabled={initializing}>
                {t('day.addBlock')}
              </Button>
              {hasTemplates && (
                <Button size="sm" variant="ghost" onClick={onPickTemplate} disabled={initializing}>
                  {t('day.timeline.applyTemplate')}
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
                  {t('day.timeline.gap', { time: fmtDuration(it.end - it.start) })}
                  {now && <span className="day-gap-now"> · {t('day.nowTag')}</span>}
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
          {t('day.addBlock')}
        </button>
      )}
    </Card>
  );
}
