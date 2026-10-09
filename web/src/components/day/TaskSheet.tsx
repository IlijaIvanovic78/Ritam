import { useId, useRef, useState, type FormEvent } from 'react';
import type { Category, DayPayload, Task, TaskPatch } from '../../../../shared/types.ts';
import { addDays, capitalize, fmtClock, fmtDateMedium, isValidISODate, localISODate } from '../../../../shared/time.ts';
import { useLang, useT } from '../../i18n/index.ts';
import { createInlineCategory } from '../../lib/categories.ts';
import { useUnsavedGuard } from '../../lib/useUnsavedGuard.ts';
import {
  Button,
  CategoryPicker,
  Field,
  Icon,
  Sheet,
  TextInput,
  confirmDialog,
  confirmDiscard,
  cx,
  toast,
  type CategoryPickerHandle,
} from '../../ui/index.ts';
import { SLOT, rich } from './rich.tsx';

/** Izmena zadatka: naslov, kategorija, premeštanje na drugi datum, brisanje. */
export function TaskSheet({
  task,
  today,
  categories,
  onClose,
  onPatch,
  onDelete,
}: {
  task: Task;
  /** Logičko danas (za brze izbore "Danas" / "Sutra"). */
  today: string;
  categories: Category[];
  onClose: () => void;
  onPatch: (id: number, patch: TaskPatch) => Promise<DayPayload | null>;
  onDelete: (id: number) => Promise<DayPayload | null>;
}) {
  const lang = useLang();
  const t = useT();
  const formId = useId();
  /**
   * Zadatak kakav je bio pri otvaranju. Forma se poredi sa njim, ne sa živim `task`: ako
   * osvežavanje u pozadini donese izmenu sa drugog uređaja, čuvanje šalje samo polja koja je
   * korisnik ovde stvarno promenio (i ne vraća tuđu izmenu ostalih polja).
   */
  const [base] = useState(task);
  const [title, setTitle] = useState(task.title);
  const [categoryId, setCategoryId] = useState<number | null>(task.categoryId);
  const [date, setDate] = useState(task.date);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState<null | 'save' | 'delete'>(null);
  const dateRef = useRef<HTMLInputElement>(null);
  const pickerRef = useRef<CategoryPickerHandle>(null);
  /** U izboru kategorije je upisan naziv nove kategorije koji još nije napravljen. */
  const [catPending, setCatPending] = useState(false);

  const tomorrow = addDays(today, 1);
  const titleError = submitted && !title.trim() ? t('tasks.sheet.titleRequired') : null;
  const dateError = submitted && !isValidISODate(date) ? t('tasks.sheet.dateRequired') : null;
  const dirty = catPending || title.trim() !== base.title || categoryId !== base.categoryId || date !== base.date;
  const changedElsewhere =
    busy == null && (task.title !== base.title || task.categoryId !== base.categoryId || task.date !== base.date);

  /** X, Esc, "nazad", pozadina: ne gubi izmene bez pitanja. true = zatvoreno. */
  const requestClose = async (): Promise<boolean> => {
    if (busy) return false;
    if (dirty && !(await confirmDiscard())) return false;
    onClose();
    return true;
  };
  useUnsavedGuard(dirty && busy == null, requestClose);

  // Native polje za datum prikazuje format jezika uređaja (npr. 10/08/2026), pa je skriveno:
  // vidi se datum na jeziku aplikacije, a klik otvara sistemski izbor datuma.
  const openPicker = () => {
    const el = dateRef.current;
    if (!el) return;
    if (typeof el.showPicker === 'function') {
      try {
        el.showPicker();
        return;
      } catch {
        // browser bez showPicker za ovo polje — padamo na focus/click
      }
    }
    el.focus();
    el.click();
  };

  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    setSubmitted(true);
    const trimmed = title.trim();
    if (busy || !trimmed || !isValidISODate(date)) return;

    setBusy('save');
    // Upisan, a nepotvrđen naziv nove kategorije se prvo napravi (inače bi se tiho izgubio).
    let catId = categoryId;
    const picker = pickerRef.current;
    if (picker?.pending()) {
      try {
        catId = (await picker.flush()) ?? categoryId;
      } catch {
        setBusy(null);
        return;
      }
    }

    const patch: TaskPatch = {};
    if (trimmed !== base.title) patch.title = trimmed;
    if (catId !== base.categoryId) patch.categoryId = catId;
    if (date !== base.date) patch.date = date;
    if (Object.keys(patch).length === 0) {
      onClose();
      return;
    }

    const res = await onPatch(task.id, patch);
    if (!res) {
      setBusy(null);
      return;
    }
    if (patch.date) {
      toast(
        patch.date === today
          ? t('tasks.sheet.movedToday')
          : patch.date === tomorrow
            ? t('tasks.sheet.movedTomorrow')
            : t('tasks.sheet.movedTo', { date: fmtDateMedium(patch.date, lang) }),
      );
    }
    onClose();
  };

  const remove = async () => {
    const ok = await confirmDialog({
      title: t('tasks.sheet.deleteTitle'),
      body: t('tasks.sheet.deleteBody', { title: task.title }),
      confirmText: t('common.delete'),
      danger: true,
    });
    if (!ok) return;
    setBusy('delete');
    const res = await onDelete(task.id);
    if (res) onClose();
    else setBusy(null);
  };

  const doneAt = task.done && task.doneAt ? new Date(task.doneAt) : null;

  return (
    <Sheet
      open
      onClose={requestClose}
      title={t('tasks.sheet.editTitle')}
      footer={
        <>
          <Button
            variant="ghost"
            className="day-btn-danger day-foot-left"
            onClick={remove}
            loading={busy === 'delete'}
            disabled={busy != null}
          >
            {t('common.delete')}
          </Button>
          <Button variant="primary" type="submit" form={formId} loading={busy === 'save'} disabled={busy != null}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <form id={formId} className="day-form" onSubmit={save} noValidate>
        {changedElsewhere && (
          <p className="field-hint day-form-warn" role="status">
            {t('tasks.sheet.changedElsewhere')}
          </p>
        )}
        <Field label={t('tasks.sheet.titleLabel')} error={titleError}>
          <TextInput value={title} onChange={(e) => setTitle(e.target.value)} maxLength={300} autoComplete="off" />
        </Field>

        <div className="field">
          <span className="field-label">{t('tasks.sheet.category')}</span>
          <CategoryPicker
            ref={pickerRef}
            categories={categories}
            value={categoryId}
            onChange={setCategoryId}
            onCreate={createInlineCategory}
            onPendingChange={setCatPending}
          />
        </div>

        <div className="field">
          <span className="field-label">{t('tasks.sheet.date')}</span>
          <div className="day-date-row">
            <span className="day-task-date">
              <button
                type="button"
                className="input day-task-date-btn"
                onClick={openPicker}
                aria-label={t('tasks.sheet.dateAria', {
                  date: isValidISODate(date) ? fmtDateMedium(date, lang) : t('tasks.sheet.dateNone'),
                })}
              >
                <span className="truncate">
                  {isValidISODate(date) ? capitalize(fmtDateMedium(date, lang)) : t('tasks.sheet.pickDate')}
                </span>
                <Icon name="calendar" size={18} />
              </button>
              <input
                ref={dateRef}
                type="date"
                className="day-date-input"
                value={date}
                onChange={(e) => {
                  if (isValidISODate(e.target.value)) setDate(e.target.value);
                }}
                tabIndex={-1}
                aria-hidden="true"
              />
            </span>
            <button
              type="button"
              className={cx('chip', date === today && 'is-active')}
              onClick={() => setDate(today)}
            >
              {t('common.today')}
            </button>
            <button
              type="button"
              className={cx('chip', date === tomorrow && 'is-active')}
              onClick={() => setDate(tomorrow)}
            >
              {t('common.tomorrow')}
            </button>
          </div>
          {dateError ? (
            <span className="field-error">{dateError}</span>
          ) : (
            <span className="field-hint">{t('tasks.sheet.dateHint')}</span>
          )}
        </div>

        {doneAt && (
          <p className="day-sheet-note">
            {rich(
              t('tasks.sheet.doneAt', { date: fmtDateMedium(localISODate(doneAt), lang), time: SLOT }),
              <span className="tabular">{fmtClock(doneAt.getHours() * 60 + doneAt.getMinutes())}</span>,
            )}
          </p>
        )}
      </form>
    </Sheet>
  );
}
