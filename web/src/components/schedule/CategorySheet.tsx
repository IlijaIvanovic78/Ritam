// Sheet za novu ili postojeću kategoriju: naziv, boja iz palete, da li se računa u ispunjenost.
// Kratka verzija (quick) samo pravi novu kategoriju iz izbora u editoru šablona (bez brisanja);
// kategorija sa istim nazivom koja već postoji se tada samo izabere.

import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { Category, CategoryInput } from '../../../../shared/types.ts';
import { ApiError, api, errorMessage } from '../../api.ts';
import { createCategory } from '../../lib/categories.ts';
import { scheduleStore, useScheduleData } from '../../lib/store.ts';
import { useUnsavedGuard } from '../../lib/useUnsavedGuard.ts';
import { Button, Field, Icon, Sheet, TextInput, Toggle, confirmDialog, confirmDiscard, toast } from '../../ui/index.ts';
import { CATEGORY_NAME_MAX, PALETTE, blocksLabel, nextFreeColor, sameColor } from './util.ts';

/** Raspored stariji od ovoga se pri otvaranju sheet-a tiho osveži. */
const STALE_MS = 5_000;

export function CategorySheet({
  category,
  onClose,
  onCreated,
  quick = false,
}: {
  category: Category | null;
  onClose: () => void;
  /** Nova kategorija je napravljena (id), pre zatvaranja sheet-a. */
  onCreated?: (id: number) => void;
  /** Nova kategorija iz izbora u editoru šablona (postojeća sa istim nazivom se samo izabere). */
  quick?: boolean;
}) {
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

  // Ako postojeća kategorija ima boju van palete, zadrži je kao dodatnu opciju.
  const [swatches] = useState(() =>
    category && !PALETTE.some((p) => sameColor(p.color, category.color))
      ? [...PALETTE, { color: category.color, name: 'Trenutna boja' }]
      : PALETTE,
  );

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
      setError('Upiši naziv.');
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
            title: 'Uključi u ispunjenost?',
            body: 'Važi i za ranije dane: dani u kojima blokovi ove kategorije nisu ocenjeni dobiće niži procenat, a niz dana može da se prekine.',
            confirmText: 'Sačuvaj',
          });
          if (!ok) return;
          setBusy('save');
        }
        payload = await api.patchCategory(category.id, patch);
      } else {
        const { id, reused } = await createCategory(trimmed, { color, counts, reuseExisting: quick });
        toast.success(reused ? 'Kategorija sa tim nazivom već postoji — izabrana je ona.' : 'Kategorija je dodata.');
        if (id != null) onCreated?.(id);
        onClose();
        return;
      }
      scheduleStore.set(payload);
      toast.success('Kategorija je sačuvana.');
      onClose();
    } catch (err) {
      fail(err);
    }
  }

  async function remove() {
    if (!category || busy) return;
    const used = templates.reduce((n, t) => n + t.blocks.filter((b) => b.categoryId === category.id).length, 0);
    // Blok bez kategorije se računa u ispunjenost: brisanje kategorije koja se ne računa menja budući procenat.
    const inTemplates =
      used === 0
        ? ''
        : category.counts
          ? ` Blokovi u šablonima sa njom (${blocksLabel(used)}) ostaju bez kategorije.`
          : ` Blokovi u šablonima sa njom (${blocksLabel(used)}) ostaju bez kategorije i od sada se računaju u ispunjenost budućih dana. Ako to ne želiš, prvo im promeni kategoriju.`;
    const ok = await confirmDialog({
      title: `Obriši kategoriju „${category.name}“?`,
      body: `Kategorija nestaje iz izbora.${inTemplates} Sačuvani dani je zadržavaju, pa se njihova ispunjenost ne menja.`,
      confirmText: 'Obriši',
      danger: true,
    });
    if (!ok) return;
    setFailure(null);
    setBusy('delete');
    try {
      const payload = await api.deleteCategory(category.id);
      scheduleStore.set(payload);
      toast.success('Kategorija je obrisana.');
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
      title={isNew ? 'Nova kategorija' : 'Izmeni kategoriju'}
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
              Obriši
            </Button>
          )}
          <span className="sched-foot-spacer" />
          <Button variant="ghost" onClick={() => void requestClose()} disabled={busy != null}>
            Otkaži
          </Button>
          <Button variant="primary" type="submit" form={formId} loading={busy === 'save'} disabled={busy != null}>
            {isNew ? 'Dodaj' : 'Sačuvaj'}
          </Button>
        </>
      }
    >
      <form id={formId} className="stack" onSubmit={submit} noValidate>
        <Field label="Naziv" error={error}>
          <TextInput
            ref={inputRef}
            value={name}
            maxLength={CATEGORY_NAME_MAX}
            placeholder="Naziv kategorije"
            onChange={(e) => {
              setName(e.target.value);
              if (error) setError(null);
            }}
            aria-invalid={!!error}
          />
        </Field>

        <div className="field">
          <span className="field-label" id={labelId}>
            Boja
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
          <Toggle checked={counts} onChange={setCounts} label="Računa se u ispunjenost dana" />
          <p className="sched-muted">
            Isključi za ono što ne želiš da ocenjuješ. Važi i za ranije dane: procenat i niz se preračunavaju.
          </p>
        </div>
      </form>
    </Sheet>
  );
}
