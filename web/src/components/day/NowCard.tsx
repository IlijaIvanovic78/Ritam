import type { Block, Category } from '../../../../shared/types.ts';
import { fmtClock, fmtDuration } from '../../../../shared/time.ts';
import { categoryColor, categoryName } from '../../lib/store.ts';
import { useT } from '../../i18n/index.ts';
import { CategoryStroke, Icon, ProgressBar } from '../../ui/index.ts';
import { currentBlock, dueBlocks, nextBlock } from './dayUtils.ts';
import { SLOT, rich } from './rich.tsx';

/** Preostalo vreme; nikad "0m" dok blok još traje. */
const left = (min: number) => fmtDuration(Math.max(1, Math.ceil(min)));

/**
 * "Sada" kartica (samo za danas): trenutni blok, koliko je ostalo i šta sledi. Jučerašnji blok koji
 * još traje (npr. noćni do jutra, `carryOver`) je trenutni dok traje. Dan bez blokova nema karticu,
 * osim podsetnika za neocenjene blokove od juče.
 */
export function NowCard({
  blocks,
  carryOver = [],
  minute,
  catMap,
  onJump,
  yesterdayDue = 0,
  onYesterday,
}: {
  blocks: Block[];
  /** Blokovi od juče koji traju posle početka ovog dana, u minutima ovog dana. */
  carryOver?: Block[];
  minute: number;
  catMap: Map<number, Category>;
  /** Skrol do bloka u vremenskoj liniji. */
  onJump: (block: Block) => void;
  /** Broj neocenjenih blokova od juče (podsetnik ujutru). */
  yesterdayDue?: number;
  onYesterday?: () => void;
}) {
  const t = useT();
  // Od blokova koji traju, onaj koji je poslednji počeo (današnji pre jučerašnjeg koji se nastavlja).
  const cur = currentBlock([...carryOver, ...blocks], minute);
  const fromYesterday = cur != null && carryOver.includes(cur);

  const yesterdayBtn =
    yesterdayDue > 0 && onYesterday ? (
      <button type="button" className="day-now-due" onClick={onYesterday}>
        {t('day.now.yesterdayDue', { n: yesterdayDue })}
        <Icon name="arrow-right" size={14} />
      </button>
    ) : null;

  if (blocks.length === 0 && !cur) {
    // Dan bez blokova (npr. dan u nedelji bez šablona): ostaje samo podsetnik za juče.
    return yesterdayBtn ? (
      <section className="card day-now day-now-only" aria-label={t('common.yesterday')}>
        {yesterdayBtn}
      </section>
    ) : null;
  }

  const next = nextBlock(blocks, minute);
  const due = dueBlocks(blocks, minute, catMap);
  const over = !cur && !next;

  return (
    <section className="card day-now" aria-label={t('day.now.label')}>
      <p className="day-now-label">{t('day.now.label')}</p>

      {cur ? (
        <>
          <div className="day-now-main">
            <CategoryStroke color={categoryColor(catMap, cur.categoryId)} />
            <div className="day-now-text">
              <p className="day-now-title">{cur.title}</p>
              <p className="day-now-sub">
                <span className="tabular">
                  {fmtClock(cur.start)}–{fmtClock(cur.end)}
                </span>{' '}
                · {categoryName(catMap, cur.categoryId)}
                {fromYesterday && ` · ${t('day.now.fromYesterday')}`}
              </p>
            </div>
            <p className="day-now-left">
              {rich(t('day.now.left', { time: SLOT }), <strong className="tabular">{left(cur.end - minute)}</strong>)}
            </p>
          </div>
          <ProgressBar
            className="day-now-pbar"
            value={(minute - cur.start) / (cur.end - cur.start)}
            color="var(--now)"
            label={t('day.now.elapsed')}
          />
        </>
      ) : over ? (
        <p className="day-now-over">{t('day.now.over')}</p>
      ) : (
        <div className="day-now-main">
          <div className="day-now-text">
            <p className="day-now-title">{t('day.now.free')}</p>
          </div>
          {next && (
            <p className="day-now-left">
              {rich(t('day.now.left', { time: SLOT }), <strong className="tabular">{left(next.start - minute)}</strong>)}
            </p>
          )}
        </div>
      )}

      {(next || due.length > 0 || yesterdayBtn) && (
        <div className="day-now-foot">
          {next && (
            <p className="day-now-next" title={t('day.now.nextTitle', { title: next.title, time: fmtClock(next.start) })}>
              <span>{t('day.now.next')}</span>
              <span className="day-now-next-title">{next.title}</span>
              <span>{rich(t('day.now.nextAt', { time: SLOT }), <span className="tabular">{fmtClock(next.start)}</span>)}</span>
            </p>
          )}
          {due.length > 0 && (
            <button type="button" className="day-now-due" onClick={() => onJump(due[0])}>
              {t('day.now.due', { n: due.length })}
              <Icon name="arrow-right" size={14} />
            </button>
          )}
          {yesterdayBtn}
        </div>
      )}
    </section>
  );
}
