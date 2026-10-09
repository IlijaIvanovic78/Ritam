// Detalji bloka (ponovni dodir izabranog bloka, "Detalji", Enter dvaput): naziv, kategorija, ocena (samo
// počeli blokovi), stvarno vreme (urađeno / delimično), beleška (samo dan). Vreme bloka se ovde ne menja —
// to se radi u nizu (prevlačenje, ručica, Kraće/Duže). Nastao od ranijeg sheet-a bloka (components/day/BlockSheet).

import { useId, useRef, useState, type FormEvent } from 'react';
import type { BlockStatus, Category } from '../../../../shared/types.ts';
import { DAY_MIN, fmtDuration } from '../../../../shared/time.ts';
import type { BlockFields, StackBlock } from '../../../../shared/blockStack.ts';
import { useT, type TFunction } from '../../i18n/index.ts';
import { createInlineCategory } from '../../lib/categories.ts';
import { useUnsavedGuard } from '../../lib/useUnsavedGuard.ts';
import { Button, CategoryPicker, Field, Sheet, TextArea, TextInput, confirmDiscard, type CategoryPickerHandle } from '../../ui/index.ts';
import { StatusControl } from '../day/StatusControl.tsx';

const isActive = (s: BlockStatus) => s === 'done' || s === 'partial';

/** "" → null; inače ceo broj 0..trajanje bloka. */
function readActual(t: TFunction, s: string, max: number): { value: number | null; error: string | null } {
  const str = s.trim();
  if (str === '') return { value: null, error: null };
  if (!/^\d{1,4}$/.test(str) || Number(str) > DAY_MIN) return { value: null, error: t('day.block.actualInvalid') };
  const v = Number(str);
  if (v > max) return { value: null, error: t('day.block.actualMax', { max }) };
  return { value: v, error: null };
}

export function DetailsSheet({
  block,
  range,
  started,
  withNote,
  categories,
  onSave,
  onDelete,
  onClose,
}: {
  block: StackBlock;
  /** "13:30–16:30". */
  range: string;
  /** Blok je počeo (danas) ili je dan prošao: ocena i stvarno vreme. */
  started: boolean;
  /** Beleška bloka (dan; šablon je nema). */
  withNote: boolean;
  categories: Category[];
  onSave: (patch: BlockFields) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const formId = useId();
  const [title, setTitle] = useState(block.title);
  const [categoryId, setCategoryId] = useState<number | null>(block.categoryId);
  const [status, setStatus] = useState<BlockStatus>(block.status);
  const [actualStr, setActualStr] = useState(block.actualMin != null ? String(block.actualMin) : '');
  const [note, setNote] = useState(block.note);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [catPending, setCatPending] = useState(false);
  const pickerRef = useRef<CategoryPickerHandle>(null);

  const showActual = started && isActive(status);
  const actual = readActual(t, actualStr, block.dur);
  const titleError = submitted && !title.trim() ? t('blocks.new.nameRequired') : null;

  const patch = (catId: number | null = categoryId): BlockFields => {
    const p: BlockFields = {};
    const trimmed = title.trim();
    if (trimmed && trimmed !== block.title) p.title = trimmed;
    if (catId !== block.categoryId) p.categoryId = catId;
    if (started && status !== block.status) p.status = status;
    if (showActual && actual.value !== block.actualMin) p.actualMin = actual.value;
    if (withNote && note.trim() !== block.note.trim()) p.note = note.trim();
    return p;
  };
  const dirty = catPending || Object.keys(patch()).length > 0;

  const requestClose = async (): Promise<boolean> => {
    if (busy) return false;
    if (dirty && !(await confirmDiscard())) return false;
    onClose();
    return true;
  };
  useUnsavedGuard(dirty && !busy, requestClose);

  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy) return;
    setSubmitted(true);
    if (!title.trim() || (showActual && actual.error)) return;
    let catId = categoryId;
    const picker = pickerRef.current;
    if (picker?.pending()) {
      // Upisan, a nepotvrđen naziv nove kategorije: prvo je napravi.
      setBusy(true);
      try {
        catId = (await picker.flush()) ?? categoryId;
      } catch {
        setBusy(false);
        return;
      }
      setBusy(false);
    }
    onSave(patch(catId));
  };

  return (
    <Sheet
      open
      onClose={requestClose}
      title={t('day.block.editTitle')}
      footer={
        <>
          <Button variant="ghost" className="day-btn-danger" onClick={onDelete} disabled={busy}>
            {t('common.delete')}
          </Button>
          <span className="blk-sheet-spacer" />
          <Button variant="ghost" onClick={() => void requestClose()} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" type="submit" form={formId} loading={busy}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <form id={formId} className="blk-sheet-form" onSubmit={save} noValidate>
        <p className="blk-det-when tabular">
          {range} · {fmtDuration(block.dur)}
        </p>
        <Field label={t('blocks.name')} error={titleError}>
          <TextInput
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={120}
            placeholder={t('day.block.titlePlaceholder')}
            autoComplete="off"
            enterKeyHint="done"
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
        {started && (
          <div className="field">
            <span className="field-label">{t('day.block.status')}</span>
            <StatusControl value={status} label={t('day.block.statusAria')} onChange={setStatus} />
          </div>
        )}
        {showActual && (
          <Field label={t('day.block.actualLabel')} error={actual.error} hint={t('day.block.actualMax', { max: block.dur })}>
            <TextInput
              value={actualStr}
              onChange={(e) => setActualStr(e.target.value)}
              inputMode="numeric"
              pattern="[0-9]*"
              className="tabular"
              autoComplete="off"
            />
          </Field>
        )}
        {withNote && (
          <Field label={t('day.block.note')}>
            <TextArea value={note} onChange={(e) => setNote(e.target.value)} minRows={2} maxLength={5000} placeholder={t('day.block.notePlaceholder')} />
          </Field>
        )}
      </form>
    </Sheet>
  );
}
