// Editor šablona (sheet "lg"): naziv, lista blokova, pregled na traci, dupliranje i brisanje.
// Izmene su lokalne dok se ne klikne "Sačuvaj"; zatvaranje sa nesačuvanim izmenama traži potvrdu.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Category, Template, TemplateBlockInput } from '../../../../shared/types.ts';
import {
  DAY_MIN,
  WEEKDAY_SHORT,
  fmtClock,
  fmtDuration,
  isValidRange,
  normalizeRange,
  parseClock,
  toClock,
} from '../../../../shared/time.ts';
import { ApiError, api, errorMessage, isCachedPayload } from '../../api.ts';
import { categoryColor, scheduleStore, useCategoryMap, useScheduleData } from '../../lib/store.ts';
import { jumpHint, normalizeNear } from '../../lib/timeRange.ts';
import { useUnsavedGuard } from '../../lib/useUnsavedGuard.ts';
import {
  Button,
  CategoryDot,
  Field,
  Icon,
  IconButton,
  Select,
  Sheet,
  TextInput,
  TimeInput,
  confirmDialog,
  confirmDiscard,
  cx,
  guardSelectKeys,
  toast,
} from '../../ui/index.ts';
import { CategorySheet } from './CategorySheet.tsx';
import { MiniTimeline, type TimelineSegment } from './MiniTimeline.tsx';
import {
  BLOCK_TITLE_MAX,
  MAX_TEMPLATE_BLOCKS,
  TEMPLATE_NAME_MAX,
  blocksLabel,
  copyName,
  maxId,
  weekdayList,
  weekdaysUsing,
} from './util.ts';

/** Red u editoru: vremena su zidni sat "HH:MM" kao u TimeInput-u. */
interface Row {
  key: string;
  start: string;
  end: string;
  title: string;
  categoryId: number | null;
  /** Sačuvani početak (minuti dana) za blok koji već postoji u šablonu; novi red nema. */
  origStart?: number;
}

interface RowCheck {
  /** Normalizovan opseg (minuti dana) ili null ako vreme nije ispravno. */
  range: { start: number; end: number } | null;
  timeError: string | null;
  titleError: string | null;
  /** Izmena vremena je prebacila postojeći blok na suprotni kraj dana (upozorenje, ne greška). */
  jump: string | null;
}

/** Poslednja stavka u izboru kategorije reda: otvara mali sheet za novu kategoriju. */
const NEW_CATEGORY = 'new';

let rowSeq = 0;
const newKey = () => `r${++rowSeq}`;

function toRows(t: Template): Row[] {
  return t.blocks.map((b) => ({
    key: newKey(),
    start: fmtClock(b.start),
    end: fmtClock(b.end),
    title: b.title,
    categoryId: b.categoryId,
    origStart: b.start,
  }));
}

/** Otisak sadržaja za proveru nesačuvanih izmena (ključevi redova se ne računaju). */
function snapshot(name: string, rows: Row[]): string {
  return JSON.stringify([name.trim(), rows.map((r) => [r.start, r.end, r.title.trim(), r.categoryId])]);
}

/**
 * Otisak šablona kakav je na serveru (naziv i blokovi, nezavisno od redosleda i id-jeva), za
 * proveru da li ga je drugi uređaj u međuvremenu promenio.
 */
function serverPrint(t: Template): string {
  const blocks = t.blocks
    .map((b) => [b.start, b.end, b.title, b.categoryId] as const)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2].localeCompare(b[2]) || (a[3] ?? -1) - (b[3] ?? -1));
  return JSON.stringify([t.name, blocks]);
}

const CHANGED_ELSEWHERE = 'Šablon je u međuvremenu promenjen na drugom uređaju.';

/** Raspored stariji od ovoga se pri otvaranju editora tiho osveži. */
const STALE_MS = 5_000;

function checkRow(r: Row, dayStart: number): RowCheck {
  const title = r.title.trim();
  const titleError = !title ? 'Upiši naslov.' : title.length > BLOCK_TITLE_MAX ? 'Naslov je predugačak.' : null;
  const s = parseClock(r.start);
  const e = parseClock(r.end);
  if (s == null || e == null) return { range: null, timeError: 'Unesi početak i kraj.', titleError, jump: null };
  // normalizeRange bi isti početak i kraj pretvorio u blok od 24h — to je skoro uvek greška.
  if (s === e) return { range: null, timeError: 'Početak i kraj ne mogu biti isti.', titleError, jump: null };
  // Postojeći blok ostaje na svom kraju dana (npr. 01:00–09:00 pomeren na 00:30 ostaje ujutru),
  // ali samo dok se preklapa sa logičkim danom; nepromenjen red zadržava tačno sačuvani opseg.
  // Novi red ide po pravilu dana. Tako isto vreme nikad ne završi van dana (skriveno na traci).
  const range =
    r.origStart != null ? normalizeNear(s, e, r.origStart, dayStart) : normalizeRange(s, e, dayStart);
  if (!isValidRange(range.start, range.end)) return { range: null, timeError: 'Neispravno vreme.', titleError, jump: null };
  const jump = r.origStart != null ? jumpHint(range, r.origStart, dayStart) : null;
  return { range, timeError: null, titleError, jump };
}

type Placed = { row: Row; start: number; end: number };

/** Parovi blokova koji se preklapaju (upozorenje, ne sprečava čuvanje). */
function findOverlaps(rows: Row[], checks: RowCheck[]): Array<[Placed, Placed]> {
  const placed: Placed[] = rows
    .flatMap((row, i) => {
      const rg = checks[i].range;
      return rg ? [{ row, ...rg }] : [];
    })
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const pairs: Array<[Placed, Placed]> = [];
  for (let i = 0; i < placed.length; i++) {
    for (let j = i + 1; j < placed.length && placed[j].start < placed[i].end; j++) {
      pairs.push([placed[i], placed[j]]);
    }
  }
  return pairs;
}

/**
 * Predlog za novi blok: počinje gde se završava poslednji u listi i traje 60 minuta.
 * Ako bi se tako preklopio sa postojećim, uzima prvu slobodnu prazninu (>= 15 min) u danu.
 */
function suggestNewBlock(rows: Row[], checks: RowCheck[], dayStart: number): { start: number; end: number } {
  const last = rows[rows.length - 1];
  const lastEnd = last ? parseClock(last.end) : null;
  const startClock = lastEnd ?? toClock(dayStart);
  const preferred = normalizeRange(startClock, toClock(startClock + 60), dayStart);

  const ranges = checks.flatMap((c) => (c.range ? [c.range] : [])).sort((a, b) => a.start - b.start);
  const overlaps = ranges.some((r) => r.start < preferred.end && preferred.start < r.end);
  if (!overlaps) return preferred;

  let cursor = dayStart;
  for (const r of ranges) {
    if (r.start - cursor >= 15) return { start: cursor, end: Math.min(cursor + 60, r.start) };
    cursor = Math.max(cursor, r.end);
  }
  if (dayStart + DAY_MIN - cursor >= 15) return { start: cursor, end: Math.min(cursor + 60, dayStart + DAY_MIN) };
  return preferred;
}

const placedLabel = (p: Placed) => `${p.row.title.trim() || 'Bez naslova'} ${fmtClock(p.start)}–${fmtClock(p.end)}`;

export function TemplateEditor({
  template,
  onClose,
  onOpenTemplate,
}: {
  template: Template;
  onClose: () => void;
  /** Otvori drugi šablon u editoru (posle dupliranja). */
  onOpenTemplate: (id: number) => void;
}) {
  const { categories, weekdays, settings } = useScheduleData();
  const catMap = useCategoryMap();
  const dayStart = settings.dayStart;

  const [name, setName] = useState(template.name);
  const [rows, setRows] = useState<Row[]>(() => toRows(template));
  const [initial, setInitial] = useState(() => snapshot(template.name, toRows(template)));
  /**
   * Šablon nad kojim se radi (kakav je bio na serveru pri otvaranju). Čuvanje zamenjuje sve blokove,
   * pa se pre slanja proverava da ga drugi uređaj u međuvremenu nije promenio.
   */
  const [base, setBase] = useState(template);
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState<'save' | 'dup' | 'del' | null>(null);
  // Greška se prikazuje i u podnožju: toast ostaje ispod otvorenog modala.
  const [failure, setFailure] = useState<string | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  /** Red za koji se upravo pravi nova kategorija (izbor "+ Nova kategorija…"). */
  const [newCatRow, setNewCatRow] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const checks = useMemo(() => rows.map((r) => checkRow(r, dayStart)), [rows, dayStart]);
  const overlaps = useMemo(() => findOverlaps(rows, checks), [rows, checks]);
  const preview: TimelineSegment[] = rows.flatMap((r, i) => {
    const rg = checks[i].range;
    return rg ? [{ ...rg, title: r.title, categoryId: r.categoryId }] : [];
  });
  const totalMin = preview.reduce((sum, b) => sum + (b.end - b.start), 0);
  const usedBy = weekdaysUsing(weekdays, template.id);

  const nameError = !name.trim() ? 'Upiši naziv šablona.' : null;
  const dirty = snapshot(name, rows) !== initial;

  /** Forma kreće ispočetka od verzije `t` (izmena sa drugog uređaja dok ovde ništa nije menjano). */
  function resetTo(t: Template) {
    const fresh = toRows(t);
    setRows(fresh);
    setName(t.name);
    setInitial(snapshot(t.name, fresh));
    setBase(t);
  }

  // Raspored osvežen u pozadini doneo je drugu verziju ovog šablona: ako ovde još ništa nije
  // menjano, prikaži nju (inače provera pri čuvanju javlja sukob).
  if (template !== base && !dirty && busy == null && serverPrint(template) !== serverPrint(base)) resetTo(template);

  // Raspored je možda u međuvremenu menjan na drugom uređaju.
  useEffect(() => {
    if (scheduleStore.age() > STALE_MS) void scheduleStore.refresh();
  }, []);

  const updateRow = (key: string, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const removeRow = (key: string) => setRows((rs) => rs.filter((r) => r.key !== key));

  function begin(kind: 'save' | 'dup' | 'del') {
    setFailure(null);
    setBusy(kind);
  }

  function fail(e: unknown) {
    const msg = errorMessage(e);
    toast.error(msg);
    setFailure(msg);
    setBusy(null);
  }

  function addRow() {
    const { start, end } = suggestNewBlock(rows, checks, dayStart);
    const key = newKey();
    setRows((rs) => [...rs, { key, start: fmtClock(start), end: fmtClock(end), title: '', categoryId: null }]);
    setFocusKey(key);
  }

  /** true ako je editor zatvoren. */
  async function requestClose(): Promise<boolean> {
    if (busy) return false;
    if (dirty && !(await confirmDiscard('Izmene u ovom šablonu nisu sačuvane.'))) return false;
    onClose();
    return true;
  }

  // Nesačuvane izmene: pitaj i pri "nazad" u browseru (miš, Alt+←) i pri zatvaranju/osvežavanju taba.
  useUnsavedGuard(dirty, requestClose);

  async function save() {
    if (busy) return;
    setSubmitted(true);
    if (nameError || checks.some((c) => c.timeError || c.titleError)) {
      // Fokus na prvo neispravno polje (aria-invalid se pojavljuje posle ovog rendera).
      requestAnimationFrame(() => {
        rootRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
      });
      return;
    }

    const blocks: TemplateBlockInput[] = rows
      .flatMap((r, i) => {
        const rg = checks[i].range;
        if (!rg) return [];
        const categoryId = r.categoryId != null && catMap.has(r.categoryId) ? r.categoryId : null;
        return [{ start: rg.start, end: rg.end, title: r.title.trim(), categoryId }];
      })
      .sort((a, b) => a.start - b.start || a.end - b.end);
    const trimmedName = name.trim();

    begin('save');
    try {
      // Čuvanje zamenjuje ceo šablon: ako ga je drugi uređaj u međuvremenu promenio, ne gazi tu
      // izmenu naslepo. Ova verzija postaje osnova, pa ponovni klik na Sačuvaj svesno zamenjuje tu.
      const fresh = await api.schedule();
      const current = isCachedPayload(fresh) ? null : fresh.templates.find((t) => t.id === template.id);
      if (current && serverPrint(current) !== serverPrint(base)) {
        scheduleStore.set(fresh);
        setBase(current);
        fail(new Error(`${CHANGED_ELSEWHERE} Sačuvaj ponovo da ga zameniš ovom verzijom, ili zatvori bez čuvanja.`));
        return;
      }
      let payload = await api.putTemplateBlocks(template.id, blocks);
      scheduleStore.set(payload);
      // Naziv samo ako je ovde promenjen (ne vraća naziv promenjen na drugom uređaju).
      if (trimmedName !== base.name) {
        payload = await api.patchTemplate(template.id, { name: trimmedName });
        scheduleStore.set(payload);
      }
      toast.success('Šablon je sačuvan.');
      onClose();
    } catch (e) {
      // Server koji i sam proverava verziju šablona javlja sukob sa 409.
      if (e instanceof ApiError && e.status === 409) void scheduleStore.refresh();
      fail(e);
    }
  }

  async function duplicate() {
    if (busy) return;
    if (dirty) {
      const ok = await confirmDialog({
        title: 'Dupliraj sačuvanu verziju?',
        body: 'Kopija se pravi od poslednje sačuvane verzije. Nesačuvane izmene ovde se odbacuju.',
        confirmText: 'Dupliraj',
      });
      if (!ok) return;
    }
    begin('dup');
    try {
      const payload = await api.addTemplate({ name: copyName(template.name), copyFrom: template.id });
      scheduleStore.set(payload);
      toast.success('Kopija je napravljena.');
      const id = maxId(payload.templates);
      if (id != null) onOpenTemplate(id);
      else onClose();
    } catch (e) {
      fail(e);
    }
  }

  async function remove() {
    if (busy) return;
    const ok = await confirmDialog({
      title: `Obriši šablon „${template.name}“?`,
      body: usedBy.length
        ? `Dodeljen je danima: ${weekdayList(usedBy)}. Ti dani ostaju bez šablona. Već započeti dani se ne menjaju.`
        : 'Nije dodeljen nijednom danu. Već započeti dani se ne menjaju.',
      confirmText: 'Obriši',
      danger: true,
    });
    if (!ok) return;
    begin('del');
    try {
      const payload = await api.deleteTemplate(template.id);
      scheduleStore.set(payload);
      toast.success('Šablon je obrisan.');
      onClose();
    } catch (e) {
      fail(e);
    }
  }

  return (
    <>
      <Sheet
        open
        onClose={requestClose}
        title="Izmeni šablon"
        size="lg"
        footer={
          <>
            {failure && (
              <p className="sched-foot-error" role="alert">
                {failure}
              </p>
            )}
            <Button variant="ghost" onClick={requestClose} disabled={busy != null}>
              Otkaži
            </Button>
            <Button variant="primary" onClick={save} loading={busy === 'save'} disabled={busy != null}>
              Sačuvaj
            </Button>
          </>
        }
      >
        <div className="sched-ed" ref={rootRef}>
          <Field label="Naziv" error={submitted ? nameError : null}>
            <TextInput
              value={name}
              maxLength={TEMPLATE_NAME_MAX}
              onChange={(e) => setName(e.target.value)}
              aria-invalid={submitted && !!nameError}
            />
          </Field>

          <div className="sched-ed-preview">
            <MiniTimeline blocks={preview} dayStart={dayStart} catMap={catMap} large />
            <p className="sched-ed-sum">
              {blocksLabel(preview.length)} · {fmtDuration(totalMin)}
              {' · '}
              {usedBy.length ? usedBy.map((d) => WEEKDAY_SHORT[d - 1]).join(', ') : 'nije dodeljen danima'}
            </p>
          </div>

          <section className="sched-ed-blocks" aria-label="Blokovi">
            <h3 className="sched-ed-h">Blokovi</h3>
            {rows.length > 0 && (
              <div className="sched-ed-head" aria-hidden="true">
                <span>Od – do</span>
                <span>Naslov</span>
                <span>Kategorija</span>
              </div>
            )}
            <ul className="sched-ed-list">
              {rows.map((r, i) => (
                <EditorRow
                  key={r.key}
                  row={r}
                  index={i}
                  check={checks[i]}
                  showErrors={submitted}
                  categories={categories}
                  catMap={catMap}
                  autoFocus={r.key === focusKey}
                  disabled={busy != null}
                  onChange={(patch) => updateRow(r.key, patch)}
                  onNewCategory={() => setNewCatRow(r.key)}
                  onRemove={() => removeRow(r.key)}
                />
              ))}
            </ul>
            {rows.length === 0 && <p className="sched-muted">Šablon još nema blokova.</p>}
            <div className="sched-ed-addrow">
              <Button
                variant="secondary"
                size="sm"
                icon="plus"
                onClick={addRow}
                disabled={busy != null || rows.length >= MAX_TEMPLATE_BLOCKS}
              >
                Dodaj blok
              </Button>
              {rows.length >= MAX_TEMPLATE_BLOCKS && (
                <span className="sched-muted">Najviše {MAX_TEMPLATE_BLOCKS} blokova.</span>
              )}
            </div>
          </section>

          {overlaps.length > 0 && (
            <div className="sched-ed-warn" role="status">
              <Icon name="info" size={18} />
              <div>
                <p>Neki blokovi se preklapaju. Možeš da sačuvaš i ovako.</p>
                <ul>
                  {overlaps.slice(0, 3).map(([a, b]) => (
                    <li key={`${a.row.key}-${b.row.key}`}>
                      {placedLabel(a)} i {placedLabel(b)}
                    </li>
                  ))}
                </ul>
                {overlaps.length > 3 && <p>i još {overlaps.length - 3}</p>}
              </div>
            </div>
          )}

          <div className="sched-ed-more">
            <Button variant="ghost" size="sm" icon="copy" onClick={duplicate} loading={busy === 'dup'} disabled={busy != null}>
              Dupliraj
            </Button>
            <Button
              variant="ghost"
              size="sm"
              icon="trash"
              className="sched-danger"
              onClick={remove}
              loading={busy === 'del'}
              disabled={busy != null}
            >
              Obriši šablon
            </Button>
          </div>
        </div>
      </Sheet>
      {/* Pored editora, ne u njemu: Esc i klikovi u malom sheet-u ne stižu do editora. */}
      {newCatRow != null && (
        <CategorySheet
          category={null}
          quick
          onCreated={(id) => updateRow(newCatRow, { categoryId: id })}
          onClose={() => setNewCatRow(null)}
        />
      )}
    </>
  );
}

function EditorRow({
  row,
  index,
  check,
  showErrors,
  categories,
  catMap,
  autoFocus,
  disabled,
  onChange,
  onNewCategory,
  onRemove,
}: {
  row: Row;
  index: number;
  check: RowCheck;
  showErrors: boolean;
  categories: Category[];
  catMap: Map<number, Category>;
  autoFocus: boolean;
  disabled: boolean;
  onChange: (patch: Partial<Row>) => void;
  onNewCategory: () => void;
  onRemove: () => void;
}) {
  const n = index + 1;
  const timeError = showErrors ? check.timeError : null;
  const titleError = showErrors ? check.titleError : null;
  const catKnown = row.categoryId != null && catMap.has(row.categoryId);
  const color = categoryColor(catMap, catKnown ? row.categoryId : null);
  const errorText = [timeError, titleError].filter(Boolean).join(' ');
  // Blok koji traje posle ponoći pripada ovom danu (prikazuje se na njegovom kraju).
  const rg = check.range;
  const night =
    rg && rg.end > DAY_MIN
      ? rg.start >= DAY_MIN
        ? 'Posle ponoći, na kraju ovog dana.'
        : `Preko ponoći, do ${fmtClock(rg.end)} sutra.`
      : null;

  return (
    <li className={cx('sched-ed-row', errorText && 'is-invalid')}>
      <span className="sched-ed-bar" style={{ background: color }} aria-hidden="true" />
      <div className="sched-ed-time">
        <TimeInput
          aria-label={`Početak, blok ${n}`}
          value={row.start}
          onChange={(e) => onChange({ start: e.target.value })}
          aria-invalid={!!timeError}
          disabled={disabled}
        />
        <span className="sched-ed-dash" aria-hidden="true">
          –
        </span>
        <TimeInput
          aria-label={`Kraj, blok ${n}`}
          value={row.end}
          onChange={(e) => onChange({ end: e.target.value })}
          aria-invalid={!!timeError}
          disabled={disabled}
        />
      </div>
      <TextInput
        className="sched-ed-title"
        aria-label={`Naslov, blok ${n}`}
        placeholder="Naslov"
        value={row.title}
        maxLength={BLOCK_TITLE_MAX}
        onChange={(e) => onChange({ title: e.target.value })}
        aria-invalid={!!titleError}
        autoFocus={autoFocus}
        disabled={disabled}
      />
      <div className="sched-ed-cat">
        <CategoryDot color={color} />
        <Select
          aria-label={`Kategorija, blok ${n}`}
          // Ceo naziv i kad je kolona uska (slični nazivi se inače ne razlikuju).
          title={catKnown ? catMap.get(row.categoryId as number)?.name : 'Bez kategorije'}
          value={catKnown ? String(row.categoryId) : ''}
          // "+ Nova kategorija…" otvara sheet: strelice na zatvorenom izboru ne smeju da ga otvore same.
          onKeyDown={(e) => guardSelectKeys(e, NEW_CATEGORY)}
          onChange={(e) => {
            const v = e.target.value;
            // Izbor ostaje na dosadašnjoj kategoriji dok nova ne bude napravljena.
            if (v === NEW_CATEGORY) onNewCategory();
            else onChange({ categoryId: v ? Number(v) : null });
          }}
          disabled={disabled}
        >
          <option value="">Bez kategorije</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
          <option value={NEW_CATEGORY}>+ Nova kategorija…</option>
        </Select>
      </div>
      <IconButton
        className="sched-ed-del"
        icon="trash"
        label={`Ukloni blok ${n}`}
        onClick={onRemove}
        disabled={disabled}
      />
      {errorText ? (
        <p className="sched-ed-err">{errorText}</p>
      ) : check.jump ? (
        <p className="sched-ed-hint is-warn" role="status">
          {check.jump}
        </p>
      ) : (
        night && <p className="sched-ed-hint">{night}</p>
      )}
    </li>
  );
}
