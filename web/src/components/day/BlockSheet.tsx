import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { Block, BlockInput, BlockPatch, BlockStatus, Category, DayPayload } from '../../../../shared/types.ts';
import { DAY_MIN, fmtClock, fmtDuration, isValidRange, normalizeRange, parseClock } from '../../../../shared/time.ts';
import { blockDoneMin } from '../../../../shared/summary.ts';
import { useT, type TFunction } from '../../i18n/index.ts';
import { createInlineCategory } from '../../lib/categories.ts';
import { jumpHint, normalizeNear } from '../../lib/timeRange.ts';
import { useUnsavedGuard } from '../../lib/useUnsavedGuard.ts';
import {
  Button,
  CategoryPicker,
  Field,
  Segmented,
  Sheet,
  TextArea,
  TextInput,
  TimeInput,
  confirmDialog,
  confirmDiscard,
  cx,
  guardSelectKeys,
  toast,
  type CategoryPickerHandle,
} from '../../ui/index.ts';
import { clockInside } from './dayUtils.ts';
import { isActiveStatus } from './useDay.ts';

type Result = Promise<DayPayload | null>;
type Range = { start: number; end: number };

/** Izbor statusa u formi (Segmented): kratka oznaka, puni naziv u title. */
function statusOptions(t: TFunction): Array<{ value: BlockStatus; label: string; title: string }> {
  return [
    { value: 'pending', label: t('status.pending'), title: t('status.pendingHint') },
    { value: 'done', label: t('status.done'), title: t('status.done') },
    { value: 'partial', label: t('status.partial'), title: t('status.partial') },
    { value: 'skipped', label: t('status.skippedShort'), title: t('status.skipped') },
  ];
}

/** Najkraći deo posle deljenja (isto pravilo kao na serveru). */
const MIN_PART = 5;

/**
 * Zidno vreme iz polja → minuti dana; greška ako nije validno. Novi blok ide po pravilu dana
 * (normalizeRange); postojeći ostaje na svom kraju dana (normalizeNear oko dosadašnjeg početka),
 * da npr. blok 01:00–09:00 pomeren na 00:30 ne skoči na kraj dana — dok god ostaje u logičkom danu.
 */
function readRange(
  t: TFunction,
  startStr: string,
  endStr: string,
  dayStart: number,
  anchorStart: number | null,
): { range: Range | null; error: string | null } {
  const s = parseClock(startStr);
  const e = parseClock(endStr);
  if (s == null || e == null) return { range: null, error: t('day.block.timeRequired') };
  if (s === e) return { range: null, error: t('day.block.timeSame') };
  const r = anchorStart == null ? normalizeRange(s, e, dayStart) : normalizeNear(s, e, anchorStart, dayStart);
  if (!isValidRange(r.start, r.end)) return { range: null, error: t('day.block.timeInvalid') };
  return { range: r, error: null };
}

/** Isti blok (sva polja koja forma menja)? */
function sameBlock(a: Block, b: Block): boolean {
  return (
    a.title === b.title &&
    a.categoryId === b.categoryId &&
    a.start === b.start &&
    a.end === b.end &&
    a.status === b.status &&
    a.actualMin === b.actualMin &&
    a.note === b.note
  );
}

/**
 * "" → null (podrazumevano); inače ceo broj 0..1440, i ne više od trajanja bloka (`max`, null kad
 * vreme bloka nije ispravno) — jedna nula viška (600 umesto 60) bi inače izobličila statistiku.
 */
function readActual(t: TFunction, s: string, max: number | null): { value: number | null; error: string | null } {
  const str = s.trim();
  if (str === '') return { value: null, error: null };
  if (!/^\d{1,4}$/.test(str) || Number(str) > DAY_MIN) return { value: null, error: t('day.block.actualInvalid') };
  const v = Number(str);
  if (max != null && v > max) return { value: null, error: t('day.block.actualMax', { max }) };
  return { value: v, error: null };
}

/**
 * Izmena postojećeg bloka (block != null) ili dodavanje novog (block == null, initialRange).
 * Montira se samo dok je otvoren, pa svako otvaranje počinje od svežeg stanja.
 *
 * Forma se poredi sa blokom kakav je bio pri otvaranju (`base`), ne sa živim `block`: ako
 * osvežavanje u pozadini donese izmenu sa drugog uređaja, neizmenjena polja ostaju neizmenjena
 * i čuvanje šalje samo ono što je korisnik stvarno promenio.
 */
export function BlockSheet({
  block,
  deleted = false,
  dayBlocks,
  initialRange,
  categories,
  dayStart,
  onClose,
  returnFocus,
  onAdd,
  onPatch,
  onSplit,
  onSwap,
  onDelete,
}: {
  block: Block | null;
  /** Blok je u međuvremenu obrisan na drugom uređaju (svež odgovor servera ga više nema). */
  deleted?: boolean;
  /** Svi blokovi dana (za "Zameni sa…"). */
  dayBlocks: Block[];
  initialRange: Range;
  categories: Category[];
  dayStart: number;
  onClose: () => void;
  /** Fokus pri zatvaranju ako red koji je otvorio sheet više ne postoji. */
  returnFocus?: () => HTMLElement | null;
  onAdd: (input: BlockInput) => Result;
  onPatch: (id: number, patch: BlockPatch) => Result;
  onSplit: (id: number, at: number) => Result;
  onSwap: (id: number, withId: number) => Result;
  onDelete: (id: number) => Result;
}) {
  const t = useT();
  const formId = useId();
  const isNew = block == null;
  /** Blok kakav je bio kad je forma otvorena (ili posle sopstvenog čuvanja pre deljenja/zamene). */
  const [base, setBase] = useState<Block | null>(block);
  const initStart = fmtClock(base ? base.start : initialRange.start);
  const initEnd = fmtClock(base ? base.end : initialRange.end);

  const [title, setTitle] = useState(base?.title ?? '');
  const [categoryId, setCategoryId] = useState<number | null>(base?.categoryId ?? null);
  const [startStr, setStartStr] = useState(initStart);
  const [endStr, setEndStr] = useState(initEnd);
  const [status, setStatus] = useState<BlockStatus>(base?.status ?? 'pending');
  const [actualStr, setActualStr] = useState(base?.actualMin != null ? String(base.actualMin) : '');
  const [note, setNote] = useState(base?.note ?? '');
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState<null | 'save' | 'split' | 'swap' | 'delete'>(null);
  const [splitOpen, setSplitOpen] = useState(false);
  const [splitStr, setSplitStr] = useState('');
  const [splitTried, setSplitTried] = useState(false);
  const splitRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const pickerRef = useRef<CategoryPickerHandle>(null);
  /** U izboru kategorije je upisan naziv nove kategorije koji još nije napravljen. */
  const [catPending, setCatPending] = useState(false);

  // Novi blok: fokus na naslov, ali samo sa mišem — na telefonu bi tastatura odmah prekrila
  // vreme i dugme "Dodaj blok". (autoFocus ne radi jer se <dialog> otvara tek u efektu Sheet-a,
  // koji se izvršava pre ovog efekta.)
  useEffect(() => {
    if (isNew && window.matchMedia('(hover: hover) and (pointer: fine)').matches) titleRef.current?.focus();
  }, [isNew]);

  // Vreme: ako korisnik nije dirao polja, važi sačuvani opseg (ne normalizujemo ga ponovo —
  // dan je možda sačuvan pod drugim "dan počinje u"), i to trenutni (deljenje radi nad njim).
  const timesTouched = startStr !== initStart || endStr !== initEnd;
  const { range, error: timeError } =
    block && !timesTouched
      ? { range: { start: block.start, end: block.end }, error: null }
      : readRange(t, startStr, endStr, dayStart, base ? base.start : null);
  const duration = range ? range.end - range.start : 0;

  const showActual = isActiveStatus(status);
  const actual = readActual(t, actualStr, range ? duration : null);
  const actualDefault = range ? blockDoneMin({ start: range.start, end: range.end, status, actualMin: null }) : 0;

  const titleError = submitted && !title.trim() ? t('day.block.titleRequired') : null;
  const formValid = !!title.trim() && !timeError && !(showActual && actual.error);

  useEffect(() => {
    if (splitOpen) splitRef.current?.scrollIntoView({ block: 'nearest' });
  }, [splitOpen]);

  /** Samo izmenjena polja (za PATCH); `catId` = kategorija posle pravljenja upisane nove. */
  function buildPatch(b: Block, catId: number | null = categoryId): BlockPatch {
    const p: BlockPatch = {};
    const trimmed = title.trim();
    if (trimmed !== b.title) p.title = trimmed;
    if (catId !== b.categoryId) p.categoryId = catId;
    if (timesTouched && range) {
      if (range.start !== b.start) p.start = range.start;
      if (range.end !== b.end) p.end = range.end;
    }
    if (status !== b.status) p.status = status;
    // actualMin šaljemo samo za done/partial; za ostale statuse server ga sam briše.
    if (isActiveStatus(status) && actual.value !== b.actualMin) p.actualMin = actual.value;
    const n = note.trim();
    if (n !== b.note.trim()) p.note = n;
    return p;
  }

  /** Blok više ne postoji (obrisan na drugom uređaju): ništa od ovoga ne može da se sačuva. */
  const gone = deleted && busy == null;
  // Izmene obrisanog bloka se ionako ne mogu sačuvati, pa zatvaranje ne pita.
  const dirty = !gone && (catPending || (base ? Object.keys(buildPatch(base)).length > 0 : !!title.trim()));
  /** Blok je u međuvremenu promenjen negde drugde (osvežavanje dok je forma otvorena). */
  const changedElsewhere = !gone && !!block && !!base && busy == null && !sameBlock(block, base);

  /** X, Esc, "nazad", pozadina, Otkaži: ne gubi izmene bez pitanja. true = zatvoreno. */
  const requestClose = async (): Promise<boolean> => {
    if (busy) return false;
    if (dirty && !(await confirmDiscard())) return false;
    onClose();
    return true;
  };
  useUnsavedGuard(dirty && busy == null, requestClose);

  /**
   * Kategorija za čuvanje: naziv nove kategorije koji je upisan, a nije potvrđen (Enter/✓), se prvo
   * napravi — inače bi blok tiho ostao bez nje. undefined = nije uspelo (greška stoji uz polje).
   */
  const resolveCategory = async (): Promise<number | null | undefined> => {
    const picker = pickerRef.current;
    if (!picker?.pending()) return categoryId;
    try {
      return (await picker.flush()) ?? categoryId;
    } catch {
      return undefined;
    }
  };

  /** Sačuvaj izmene forme pre deljenja/zamene; posle toga forma kreće od sačuvanog bloka. */
  const saveFormFirst = async (b: Block): Promise<boolean> => {
    const catId = await resolveCategory();
    if (catId === undefined) return false;
    const patch = buildPatch(b, catId);
    if (Object.keys(patch).length === 0) return true;
    const res = await onPatch(b.id, patch);
    const next = res?.blocks.find((x) => x.id === b.id);
    if (next) setBase(next);
    return !!res;
  };

  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy || gone) return;
    setSubmitted(true);
    if (!formValid || !range) return;

    setBusy('save');
    const catId = await resolveCategory();
    if (catId === undefined) {
      setBusy(null);
      return;
    }

    if (isNew) {
      const res = await onAdd({ start: range.start, end: range.end, title: title.trim(), categoryId: catId });
      if (res) onClose();
      else setBusy(null);
      return;
    }

    const patch = buildPatch(base ?? block, catId);
    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }
    const res = await onPatch(block.id, patch);
    if (res) onClose();
    else setBusy(null);
  };

  // ---- Deljenje ----

  const canSplit = !!block && !gone && !!range && duration >= MIN_PART * 2;

  const openSplit = () => {
    if (!range) return;
    // Podrazumevano: sredina bloka, zaokruženo na 5 min.
    setSplitStr(fmtClock(Math.round((range.start + range.end) / 2 / 5) * 5));
    setSplitTried(false);
    setSplitOpen(true);
  };

  const splitClock = parseClock(splitStr);
  const splitAt = range && splitClock != null ? clockInside(splitClock, range.start, range.end) : null;
  let splitError: string | null = null;
  if (range) {
    if (splitClock == null) splitError = t('day.split.timeRequired');
    else if (splitAt == null) splitError = t('day.split.outside', { start: fmtClock(range.start), end: fmtClock(range.end) });
    // Drugi deo mora da počne pre kraja sutrašnjeg dana (isto pravilo kao isValidRange na serveru).
    else if (splitAt >= 2 * DAY_MIN) splitError = t('day.split.invalid');
    else if (splitAt - range.start < MIN_PART || range.end - splitAt < MIN_PART) splitError = t('day.split.tooShort');
  }

  const doSplit = async () => {
    if (!block || busy || gone) return;
    setSplitTried(true);
    setSubmitted(true);
    if (!formValid || !range || splitError || splitAt == null) return;
    setBusy('split');
    // Nesačuvane izmene forme idu pre deljenja, da se ne izgube.
    if (!(await saveFormFirst(base ?? block))) {
      setBusy(null);
      return;
    }
    const res = await onSplit(block.id, splitAt);
    if (res) onClose();
    else setBusy(null);
  };

  // ---- Zamena naslova i kategorije sa drugim blokom ----

  // Blok iz pregleda (negativan id, dan još nije upisan) nema sa čim da se zameni.
  const swapWith = block && block.id > 0 && !gone ? dayBlocks.filter((b) => b.id > 0 && b.id !== block.id) : [];

  const doSwap = async (withId: number) => {
    if (!block || busy || gone || !swapWith.some((b) => b.id === withId)) return;
    setSubmitted(true);
    if (!formValid || !range) return;
    setBusy('swap');
    // Kao kod deljenja: nesačuvane izmene forme idu pre zamene, da se ne izgube.
    if (!(await saveFormFirst(base ?? block))) {
      setBusy(null);
      return;
    }
    const res = await onSwap(block.id, withId);
    if (res) {
      onClose();
      toast.success(t('day.block.swapped'));
    } else setBusy(null);
  };

  // ---- Brisanje ----

  const remove = async () => {
    if (!block || busy || gone) return;
    const ok = await confirmDialog({
      title: t('day.block.deleteTitle'),
      body: t('day.block.deleteBody', { title: block.title }),
      confirmText: t('common.delete'),
      danger: true,
    });
    if (!ok) return;
    setBusy('delete');
    const res = await onDelete(block.id);
    if (res) onClose();
    else setBusy(null);
  };

  // ---- Prikaz ----

  let footer;
  if (isNew) {
    footer = (
      <>
        <Button variant="ghost" onClick={() => void requestClose()} disabled={busy != null}>
          {t('common.cancel')}
        </Button>
        <Button variant="primary" type="submit" form={formId} loading={busy === 'save'}>
          {t('day.addBlock')}
        </Button>
      </>
    );
  } else if (splitOpen) {
    footer = (
      <>
        <Button variant="ghost" onClick={() => setSplitOpen(false)} disabled={busy != null}>
          {t('common.cancel')}
        </Button>
        <Button variant="primary" onClick={doSplit} loading={busy === 'split'} disabled={busy != null && busy !== 'split'}>
          {t('day.split.confirm')}
        </Button>
      </>
    );
  } else {
    footer = (
      <>
        <Button
          variant="ghost"
          className="day-btn-danger"
          onClick={remove}
          loading={busy === 'delete'}
          disabled={busy != null || gone}
        >
          {t('common.delete')}
        </Button>
        <Button
          variant="ghost"
          className={swapWith.length === 0 ? 'day-foot-left' : undefined}
          onClick={openSplit}
          disabled={busy != null || !canSplit}
          title={canSplit ? t('day.split.hint') : gone ? undefined : t('day.split.tooShortHint')}
        >
          {t('day.split.open')}
        </Button>
        {swapWith.length > 0 && (
          // Izgleda kao dugme, a ispod je native <select> preko celog dugmeta: na telefonu
          // otvara sistemsku listu, a izbor odmah menja blokove.
          <span
            className={cx('btn btn-ghost day-swap day-foot-left', busy != null && 'is-disabled')}
            title={t('day.swap.hint')}
          >
            {busy === 'swap' && <span className="spinner spinner-sm" aria-hidden="true" />}
            <span className="day-swap-label" aria-hidden="true">
              {t('day.swap.label')}
            </span>
            <select
              className="day-swap-select"
              aria-label={t('day.swap.aria')}
              value=""
              disabled={busy != null}
              aria-busy={busy === 'swap' || undefined}
              onKeyDown={guardSelectKeys}
              onChange={(e) => {
                const id = Number(e.target.value);
                if (id > 0) void doSwap(id);
              }}
            >
              <option value="" disabled hidden>
                {t('day.swap.label')}
              </option>
              {swapWith.map((b) => (
                <option key={b.id} value={b.id}>
                  {`${fmtClock(b.start)}–${fmtClock(b.end)} · ${b.title}`}
                </option>
              ))}
            </select>
          </span>
        )}
        <Button variant="primary" type="submit" form={formId} loading={busy === 'save'} disabled={busy != null || gone}>
          {t('common.save')}
        </Button>
      </>
    );
  }

  const timeHint = range
    ? t('day.block.duration', { time: fmtDuration(duration) }) +
      (range.start >= DAY_MIN ? ` · ${t('day.block.afterMidnight')}` : '')
    : undefined;
  // Novi blok koji počinje pre "dan počinje u" i traje do jutra (npr. 00:30–08:30) ide na KRAJ
  // ovog dana — to treba jasno reći, ne samo diskretno.
  const lateWarn = isNew && range != null && range.start >= DAY_MIN && range.end > dayStart + DAY_MIN;
  // Postojeći blok čiji je početak pomeren na suprotni kraj dana (npr. 01:00 → 23:30 postaje
  // večerašnji blok, 23:30–09:00 sutra; ili obrnuto, kad bi ostao van logičkog dana).
  const jumpWarn = !isNew && timesTouched && range != null && base != null ? jumpHint(range, base.start, dayStart) : null;

  return (
    <Sheet
      open
      onClose={requestClose}
      title={isNew ? t('day.block.newTitle') : t('day.block.editTitle')}
      footer={footer}
      returnFocus={returnFocus}
    >
      <form id={formId} className="day-form" onSubmit={save} noValidate>
        {gone ? (
          <p className="field-hint day-form-warn" role="status">
            {t('day.block.deletedElsewhere')}
          </p>
        ) : (
          changedElsewhere && (
            <p className="field-hint day-form-warn" role="status">
              {t('day.block.changedElsewhere')}
            </p>
          )
        )}
        <Field label={t('day.block.titleLabel')} error={titleError}>
          <TextInput
            ref={titleRef}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={120}
            placeholder={t('day.block.titlePlaceholder')}
            autoComplete="off"
          />
        </Field>

        <div className="field">
          <span className="field-label">{t('day.block.category')}</span>
          <CategoryPicker
            ref={pickerRef}
            categories={categories}
            value={categoryId}
            onChange={setCategoryId}
            onCreate={createInlineCategory}
            onPendingChange={setCatPending}
          />
        </div>

        <div className="day-form-times">
          <Field label={t('day.block.from')}>
            <TimeInput
              aria-label={t('day.block.from')}
              value={startStr}
              onChange={(e) => setStartStr(e.target.value)}
              required
            />
          </Field>
          <Field label={t('day.block.to')}>
            <TimeInput aria-label={t('day.block.to')} value={endStr} onChange={(e) => setEndStr(e.target.value)} required />
          </Field>
          {timeError ? (
            <span className="field-error day-form-times-msg">{timeError}</span>
          ) : lateWarn ? (
            <span className="field-hint day-form-times-msg day-form-warn tabular" role="status">
              {t('day.block.lateWarn', { hint: timeHint ?? '' })}
            </span>
          ) : jumpWarn ? (
            <span className="field-hint day-form-times-msg day-form-warn tabular" role="status">
              {jumpWarn}
            </span>
          ) : (
            <span className="field-hint day-form-times-msg tabular">{timeHint}</span>
          )}
        </div>

        {!isNew && (
          <>
            <div className="field">
              <span className="field-label">{t('day.block.status')}</span>
              <Segmented
                className="day-form-seg"
                label={t('day.block.statusAria')}
                value={status}
                options={statusOptions(t)}
                onChange={setStatus}
              />
            </div>

            {showActual && (
              <Field
                label={t('day.block.actualLabel')}
                error={actual.error}
                hint={
                  actual.value != null
                    ? `= ${fmtDuration(actual.value)}`
                    : status === 'done'
                      ? t('day.block.actualDefaultDone', { time: fmtDuration(actualDefault) })
                      : t('day.block.actualDefaultPartial', { time: fmtDuration(actualDefault) })
                }
              >
                <TextInput
                  value={actualStr}
                  onChange={(e) => setActualStr(e.target.value)}
                  inputMode="numeric"
                  pattern="[0-9]*"
                  placeholder={String(actualDefault)}
                  className="tabular"
                  autoComplete="off"
                />
              </Field>
            )}

            <Field label={t('day.block.note')}>
              <TextArea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                minRows={2}
                maxLength={5000}
                placeholder={t('day.block.notePlaceholder')}
              />
            </Field>
          </>
        )}
      </form>

      {splitOpen && range && (
        <div className="day-split" ref={splitRef}>
          <Field
            label={t('day.split.at')}
            error={splitError && (splitTried || splitStr !== '') ? splitError : null}
            hint={
              splitAt != null && !splitError
                ? t('day.split.parts', {
                    first: `${fmtClock(range.start)}–${fmtClock(splitAt)}`,
                    second: `${fmtClock(splitAt)}–${fmtClock(range.end)}`,
                  })
                : undefined
            }
          >
            <TimeInput
              aria-label={t('day.split.at')}
              value={splitStr}
              onChange={(e) => setSplitStr(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void doSplit();
                }
              }}
              autoFocus
            />
          </Field>
          <p className="day-sheet-note">{t('day.split.note')}</p>
        </div>
      )}
    </Sheet>
  );
}
