// List "Novi blok": naziv prvo (fokus odmah), predlozi samo od korisnikovih naziva (dan + šabloni, po
// učestalosti; izabran predlog donosi i kategoriju), "Slobodno vreme", kategorija, trajanje. U nizu se uživo
// vidi isprekidan blok na mestu gde će stati i blokovi koje pomera; red ispod naslova kaže šta se pomera.

import { useEffect, useLayoutEffect, useRef } from 'react';
import type { Category } from '../../../../shared/types.ts';
import { fmtDuration } from '../../../../shared/time.ts';
import { useT } from '../../i18n/index.ts';
import { createInlineCategory } from '../../lib/categories.ts';
import { Button, CategoryDot, CategoryPicker, Sheet, cx } from '../../ui/index.ts';
import type { StackController } from './controller.ts';
import { fold } from './geometry.ts';

const DURS = [15, 30, 45, 60, 90, 120, 180];

export function NewBlockSheet({ ctl, categories }: { ctl: StackController; categories: Category[] }) {
  const t = useT();
  const nb = ctl.nb;
  const formRef = useRef<HTMLFormElement>(null);

  // Posle rasporeda lista (Sheet ga otvara u svom efektu, pre ovog) i pri svakoj promeni njegove visine: isprekidan
  // novi blok staje između trake i lista (telefon: list se po potrebi skrati, telo mu se skroluje).
  useEffect(() => {
    const dialog = formRef.current?.closest<HTMLElement>('dialog');
    const panel = dialog?.querySelector<HTMLElement>('.sheet-panel');
    if (!dialog || !panel) return;
    const fit = () => ctl.fitNewSheet(dialog);
    const ro = new ResizeObserver(fit);
    ro.observe(panel);
    window.addEventListener('resize', fit);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', fit);
    };
  }, [ctl]);

  // Telefon: kategorije i trajanja su redovi koji se pomeraju u stranu — izabran čip (i onaj koji donosi predlog
  // naziva) se vidi.
  const cat = nb?.cat;
  const dur = nb?.dur;
  useLayoutEffect(() => {
    const rows = formRef.current?.querySelectorAll<HTMLElement>('.blk-nb-cats .chips, .blk-nb-durs') ?? [];
    for (const row of rows) {
      const on = row.querySelector<HTMLElement>('[aria-checked="true"]');
      if (!on || row.scrollWidth <= row.clientWidth) continue;
      const r = row.getBoundingClientRect();
      const c = on.getBoundingClientRect();
      if (c.left < r.left + 20) row.scrollLeft -= r.left + 20 - c.left;
      else if (c.right > r.right - 20) row.scrollLeft += c.right - (r.right - 20);
    }
  }, [cat, dur]);

  if (!nb) return null;
  const q = fold(nb.name);
  const names = nb.free ? [] : ctl.knownNames().filter((s) => !q || fold(s.name).includes(q)).slice(0, 6);
  const offerFree = nb.spec.mode !== 'free' && !(q && !nb.free);
  const durs = DURS.includes(nb.dur) ? DURS : [...DURS, nb.dur].sort((a, b) => a - b);
  // Kategorija koju naziv donosi a koja je u međuvremenu obrisana: prikaži je kao izabranu.
  const own = nb.cat != null && !categories.some((c) => c.id === nb.cat) ? ctl.cfg.catMap.get(nb.cat) : undefined;
  const pickerCats = own ? [...categories, own] : categories;

  const add = () => {
    ctl.closeNew('ok');
  };

  return (
    <Sheet
      open
      className="blk-new-sheet"
      onClose={() => ctl.closeNew('cancel')}
      title={t('day.block.newTitle')}
      footer={
        <>
          {nb.canCloseGap && (
            <Button variant="ghost" className="blk-nb-gap" onClick={() => ctl.closeNew('gap')}>
              {t('blocks.closeGap')}
            </Button>
          )}
          <span className="blk-sheet-spacer" />
          <Button variant="ghost" onClick={() => ctl.closeNew('cancel')}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" onClick={add}>
            {t('common.add')}
          </Button>
        </>
      }
    >
      <form
        ref={formRef}
        className="blk-sheet-form"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <p className="blk-nb-where tabular">{nb.where}</p>
        <p className={cx('blk-nb-effect', nb.effectCls)}>{nb.effect}</p>
        {!nb.free && (
          <label className="field">
            <span className="field-label">{t('blocks.name')}</span>
            <input
              className="input"
              data-autofocus
              value={nb.name}
              onChange={(e) => ctl.nbSetName(e.target.value)}
              onKeyDown={(e) => {
                // Enter u polju naziva = Dodaj
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  add();
                }
              }}
              placeholder={t('day.block.titlePlaceholder')}
              autoComplete="off"
              maxLength={120}
              enterKeyHint="done"
              aria-invalid={nb.err || undefined}
            />
            {nb.err && <span className="field-error">{t('blocks.new.nameRequired')}</span>}
          </label>
        )}
        {(names.length > 0 || offerFree) && (
          <div className="chips blk-nb-sugs" role="group" aria-label={t('blocks.yourNames')}>
            {names.map((s) => (
              <button key={s.name} type="button" className="chip" onClick={() => ctl.nbPick(s.name, s.cat)}>
                <CategoryDot color={ctl.catColor(s.cat)} />
                <span>{s.name}</span>
              </button>
            ))}
            {offerFree && (
              <button
                type="button"
                className={cx('chip chip-dashed', nb.free && 'is-active')}
                aria-pressed={nb.free}
                onClick={() => ctl.nbSetFree(!nb.free)}
              >
                {t('blocks.freeTime')}
              </button>
            )}
          </div>
        )}
        {!nb.free && (
          <div className="field blk-nb-cats">
            <span className="field-label">{t('day.block.category')}</span>
            <CategoryPicker categories={pickerCats} value={nb.cat} onChange={(id) => ctl.nbSetCat(id)} onCreate={createInlineCategory} />
          </div>
        )}
        <div className="field">
          <span className="field-label">{t('blocks.duration')}</span>
          <div className="chips blk-nb-durs" role="radiogroup" aria-label={t('blocks.duration')}>
            {durs.map((d) => (
              <button
                key={d}
                type="button"
                role="radio"
                aria-checked={nb.dur === d}
                className={cx('chip', nb.dur === d && 'is-active')}
                onClick={() => ctl.nbSetDur(d)}
              >
                {fmtDuration(d)}
              </button>
            ))}
          </div>
        </div>
      </form>
    </Sheet>
  );
}
