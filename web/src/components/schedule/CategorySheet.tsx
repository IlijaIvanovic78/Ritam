// Sheet za novu ili postojeću kategoriju: naziv, boja iz palete, da li se računa u ispunjenost.

import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { Category, CategoryInput } from '../../../../shared/types.ts';
import { ApiError, api, errorMessage } from '../../api.ts';
import { useT } from '../../i18n/index.ts';
import { createCategory } from '../../lib/categories.ts';
import { scheduleStore, useScheduleData } from '../../lib/store.ts';
import { useUnsavedGuard } from '../../lib/useUnsavedGuard.ts';
import { Button, Field, Icon, Sheet, TextInput, Toggle, confirmDialog, confirmDiscard, toast } from '../../ui/index.ts';
import { CATEGORY_NAME_MAX, PALETTE, nextFreeColor, sameColor } from './util.ts';

/** Raspored stariji od ovoga se pri otvaranju sheet-a tiho osveži. */
const STALE_MS = 5_000;

export function CategorySheet({ category, onClose }: { category: Category | null; onClose: () => void }) {
  const t = useT();
  const { categories, archivedCategories, templates } = useScheduleData();
  const isNew = category == null;
  const formId = useId();
  const labelId = useId();
  const inputRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState(category?.name ?? '');
  const [initialColor] = useState(() => category?.color ?? nextFreeColor(categories, archivedCategories ?? []));
  const [color, setColor] = useState(initialColor);
  const [counts, setCounts] = useState(category?.counts ?? true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'save' | 'delete' | null>(null);
  // Greška se prikazuje i u podnožju: toast ostaje ispod otvorenog modala.
  const [failure, setFailure] = useState<string | null>(null);

  function fail(err: unknown) {
    const msg = errorMessage(err);
    // Naziv koji već postoji (409): greška ide uz polje za naziv.
    if (err instanceof ApiError && err.status === 409) {
      setError(msg);
      setBusy(null);
      inputRef.current?.focus();
      return;
    }
    toast.error(msg);
    setFailure(msg);
    setBusy(null);
  }

  // Ako postojeća kategorija ima boju van palete, zadrži je kao dodatnu opciju. Nazivi boja se čitaju pri
  // svakom renderu (prate jezik).
  const [extraColor] = useState(() =>
    category && !PALETTE.some((p) => sameColor(p.color, category.color)) ? category.color : null,
  );
  const swatches = extraColor
    ? [...PALETTE, { color: extraColor, name: t('schedule.category.currentColor') }]
    : PALETTE;

  useEffect(() => {
    if (isNew) inputRef.current?.focus();
  }, [isNew]);

  // Raspored je možda u međuvremenu menjan na drugom uređaju (spisak kategorija, šabloni za potvrdu brisanja).
  useEffect(() => {
    if (scheduleStore.age() > STALE_MS) void scheduleStore.refresh();
  }, []);

  const dirty =
    name.trim() !== (category?.name ?? '') || !sameColor(color, initialColor) || counts !== (category?.counts ?? true);

  /** X, Esc, "nazad", pozadina: ne gubi izmene bez pitanja. true = zatvoreno. */
  async function requestClose(): Promise<boolean> {
    if (busy) return false;
    if (dirty && !(await confirmDiscard())) return false;
    onClose();
    return true;
  }
  useUnsavedGuard(dirty && busy == null, requestClose);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setError(t('schedule.nameRequired'));
      inputRef.current?.focus();
      return;
    }
    setFailure(null);
    setBusy('save');
    try {
      let payload;
      if (category) {
        // Samo polja koja su ovde promenjena: ne vraća izmenu ostalih polja sa drugog uređaja
        // (npr. prekidač "Računa se" promenjen na telefonu dok je ovaj sheet bio otvoren).
        const patch: Partial<CategoryInput> = {};
        if (trimmed !== category.name) patch.name = trimmed;
        if (!sameColor(color, initialColor)) patch.color = color;
        if (counts !== category.counts) patch.counts = counts;
        if (Object.keys(patch).length === 0) {
          onClose();
          return;
        }
        // Uključivanje važi i za ranije dane: neocenjeni blokovi te kategorije spuštaju procenat.
        if (patch.counts === true) {
          setBusy(null);
          const ok = await confirmDialog({
            title: t('schedule.category.countOnTitle'),
            body: t('schedule.category.countOnBody'),
            confirmText: t('common.save'),
          });
          if (!ok) return;
          setBusy('save');
        }
        payload = await api.patchCategory(category.id, patch);
      } else {
        await createCategory(trimmed, { color, counts });
        toast.success(t('schedule.category.added'));
        onClose();
        return;
      }
      scheduleStore.set(payload);
      toast.success(t('schedule.category.saved'));
      onClose();
    } catch (err) {
      fail(err);
    }
  }

  async function remove() {
    if (!category || busy) return;
    const used = templates.reduce((n, tpl) => n + tpl.blocks.filter((b) => b.categoryId === category.id).length, 0);
    const blocks = t('common.blocks', { n: used });
    // Blok bez kategorije se računa u ispunjenost: brisanje kategorije koja se ne računa menja budući procenat.
    const body =
      used === 0
        ? t('schedule.category.deleteBody')
        : category.counts
          ? t('schedule.category.deleteBodyBlocks', { blocks })
          : t('schedule.category.deleteBodyBlocksStartCounting', { blocks });
    const ok = await confirmDialog({
      title: t('schedule.category.deleteTitle', { name: category.name }),
      body,
      confirmText: t('common.delete'),
      danger: true,
    });
    if (!ok) return;
    setFailure(null);
    setBusy('delete');
    try {
      const payload = await api.deleteCategory(category.id);
      scheduleStore.set(payload);
      toast.success(t('schedule.category.deleted'));
      onClose();
    } catch (err) {
      fail(err);
    }
  }

  // Radio grupa: strelice menjaju izbor (roving tabindex).
  function onSwatchKey(e: KeyboardEvent<HTMLDivElement>) {
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const idx = Math.max(0, swatches.findIndex((s) => sameColor(s.color, color)));
    const next = (idx + step + swatches.length) % swatches.length;
    setColor(swatches[next].color);
    e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
  }

  const selectedIdx = swatches.findIndex((s) => sameColor(s.color, color));

  return (
    <Sheet
      open
      onClose={() => void requestClose()}
      title={isNew ? t('schedule.categories.new') : t('schedule.category.edit')}
      size="sm"
      footer={
        <>
          {failure && (
            <p className="sched-foot-error" role="alert">
              {failure}
            </p>
          )}
          {!isNew && (
            <Button
              variant="ghost"
              className="sched-danger"
              onClick={remove}
              loading={busy === 'delete'}
              disabled={busy != null}
            >
              {t('common.delete')}
            </Button>
          )}
          <span className="sched-foot-spacer" />
          <Button variant="ghost" onClick={() => void requestClose()} disabled={busy != null}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" type="submit" form={formId} loading={busy === 'save'} disabled={busy != null}>
            {isNew ? t('common.add') : t('common.save')}
          </Button>
        </>
      }
    >
      <form id={formId} className="stack" onSubmit={submit} noValidate>
        <Field label={t('schedule.nameLabel')} error={error}>
          <TextInput
            ref={inputRef}
            value={name}
            maxLength={CATEGORY_NAME_MAX}
            placeholder={t('schedule.category.namePlaceholder')}
            onChange={(e) => {
              setName(e.target.value);
              if (error) setError(null);
            }}
            aria-invalid={!!error}
          />
        </Field>

        <div className="field">
          <span className="field-label" id={labelId}>
            {t('schedule.category.color')}
          </span>
          <div className="sched-swatches" role="radiogroup" aria-labelledby={labelId} onKeyDown={onSwatchKey}>
            {swatches.map((s, i) => {
              const selected = i === selectedIdx;
              return (
                <button
                  key={s.color}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  aria-label={s.name}
                  title={s.name}
                  tabIndex={selected || (selectedIdx < 0 && i === 0) ? 0 : -1}
                  className="sched-swatch"
                  onClick={() => setColor(s.color)}
                >
                  <span className="sched-swatch-fill" style={{ background: s.color }}>
                    {selected && <Icon name="check" size={16} />}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="stack-sm">
          <Toggle checked={counts} onChange={setCounts} label={t('schedule.category.counts')} />
          <p className="sched-muted">{t('schedule.category.countsHint')}</p>
        </div>
      </form>
    </Sheet>
  );
}
