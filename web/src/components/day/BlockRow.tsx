import type { Block, BlockStatus, Category } from '../../../../shared/types.ts';
import { fmtClock, fmtDuration } from '../../../../shared/time.ts';
import { blockDuration } from '../../../../shared/summary.ts';
import { categoryColor, categoryName } from '../../lib/store.ts';
import { CategoryStroke, Icon, cx } from '../../ui/index.ts';
import { StatusControl } from './StatusControl.tsx';
import { isActiveStatus } from './useDay.ts';

export const blockDomId = (id: number) => `day-block-${id}`;

/** Jedan red vremenske linije: vreme, crta kategorije, naslov + meta, kontrola statusa. */
export function BlockRow({
  block,
  index,
  catMap,
  isNow,
  progress,
  isDue,
  statusDisabled,
  onOpen,
  onStatus,
}: {
  block: Block;
  index: number;
  catMap: Map<number, Category>;
  /** Blok traje upravo sada. */
  isNow: boolean;
  /** Koliki deo trenutnog bloka je prošao (0..1). */
  progress: number;
  /** Prošao je, a još nije ocenjen. */
  isDue: boolean;
  /** Pregled budućeg dana iz šablona — statusi onemogućeni. */
  statusDisabled: boolean;
  onOpen: (block: Block, index: number) => void;
  onStatus: (block: Block, index: number, status: BlockStatus) => void;
}) {
  const color = categoryColor(catMap, block.categoryId);
  const actual = isActiveStatus(block.status) ? block.actualMin : null;

  return (
    <li className={cx('day-row', isNow && 'is-now', isDue && 'is-due', `is-${block.status}`)}>
      <button type="button" id={blockDomId(block.id)} className="day-row-main" onClick={() => onOpen(block, index)}>
        <span className="day-time">
          <span>{fmtClock(block.start)}</span>
          <span className="day-time-end">{fmtClock(block.end)}</span>
        </span>
        <CategoryStroke color={color} />
        <span className="day-text">
          <span className="day-title">{block.title}</span>
          <span className="day-meta">
            {isNow && <span className="day-now-tag">sada</span>}
            {/* Red se prelama samo pre "·": trajanje ("2h 30m") se nikad ne cepa, a tačka ne visi na kraju reda. */}
            <span>
              {categoryName(catMap, block.categoryId)}{' '}
              <span className="day-meta-seg">· {fmtDuration(blockDuration(block))}</span>
              {actual != null && (
                <>
                  {' '}
                  <span className="day-meta-seg">· stvarno {fmtDuration(actual)}</span>
                </>
              )}
            </span>
            {block.note.trim() !== '' && (
              <span className="day-meta-note" title="Ima belešku">
                <Icon name="note" size={14} />
                <span className="sr-only">ima belešku</span>
              </span>
            )}
            {isDue && <span className="day-due-tag">čeka ocenu</span>}
          </span>
        </span>
      </button>
      <StatusControl
        value={block.status}
        label={`Status: ${block.title}`}
        disabled={statusDisabled}
        onChange={(s) => onStatus(block, index, s)}
      />
      {isNow && (
        <span
          className="day-row-progress"
          style={{ width: `${Math.round(Math.max(0, Math.min(1, progress)) * 1000) / 10}%` }}
          aria-hidden="true"
        />
      )}
    </li>
  );
}
