// Uređivač šablona (Raspored → šablon, ruta /raspored/sablon/:id): isti niz blokova kao Danas — BlockStack u režimu
// 'template' (deli, premešta, menja trajanje, ubacuje, briše, poništava; predlozi naziva samo od korisnikovih
// blokova), bez ocena i bez "sada". Izmene se čuvaju same (useTemplateBlocks). Zaglavlje: nazad na Raspored, naziv,
// dani u nedelji koji ga koriste i meni ⋯ (Preimenuj…, Dupliraj, Obriši šablon).

import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type MutableRefObject } from 'react';
import type { Template } from '../../../../shared/types.ts';
import { logicalNow } from '../../../../shared/time.ts';
import { ApiError, api, errorMessage } from '../../api.ts';
import { useLang, useT } from '../../i18n/index.ts';
import { enqueue } from '../../lib/queue.ts';
import { Link, navigate, paths } from '../../lib/router.tsx';
import { scheduleStore, useCategoryMap, useScheduleData } from '../../lib/store.ts';
import { useUnsavedGuard } from '../../lib/useUnsavedGuard.ts';
import { Button, Field, Icon, PageHeader, Sheet, TextInput, confirmDialog, confirmDiscard, toast } from '../../ui/index.ts';
import { BlockStack, KeysCard } from '../blocks/BlockStack.tsx';
import { useTemplateBlocks } from '../blocks/useTemplateBlocks.ts';
import { DayMenu, type MenuItem } from '../day/DayMenu.tsx';
import { peekDay } from '../day/useDay.ts';
import { TEMPLATE_NAME_MAX, copyName, maxId, weekdayList, weekdaySpan, weekdaysUsing } from './util.ts';

/** Oznaka u istoriji: uređivač je otvoren sa Rasporeda, pa je "nazad" korak nazad (ne nov korak). */
const BACK_KEY = 'ritamFromSchedule';
/** Raspored stariji od ovoga se pri otvaranju uređivača tiho osveži. */
const STALE_MS = 5_000;

function fromSchedule(): boolean {
  try {
    return !!(window.history.state as Record<string, unknown> | null)?.[BACK_KEY];
  } catch {
    return false;
  }
}

/** Otvori šablon u uređivaču (sa Rasporeda; `replace` = umesto trenutnog uređivača, npr. posle dupliranja). */
export function openTemplate(id: number, opts: { replace?: boolean } = {}) {
  const back = opts.replace ? fromSchedule() : true;
  navigate(paths.template(id), { replace: opts.replace });
  try {
    window.history.replaceState({ ...((window.history.state as object | null) ?? {}), [BACK_KEY]: back }, '');
  } catch {
    // istorija nije dostupna: "nazad" onda zamenjuje adresu
  }
}

/** Nazad na Raspored: korak nazad u istoriji ako je uređivač otvoren sa Rasporeda, inače zameni adresu. */
function backToSchedule() {
  if (fromSchedule()) window.history.back();
  else navigate(paths.schedule, { replace: true });
}

export function TemplateEditor({ templateId }: { templateId: number }) {
  const t = useT();
  const { templates } = useScheduleData();
  const live = templates.find((x) => x.id === templateId) ?? null;
  // Šablon obrisan na drugom uređaju: do odlaska se crta poslednja poznata verzija.
  const last = useRef<Template | null>(null);
  if (live) last.current = live;
  /** Uređivač se zatvara sam (brisanje): nestanak šablona tada nije tuđa izmena. */
  const leaving = useRef(false);

  useEffect(() => {
    if (live || leaving.current) return;
    leaving.current = true;
    // Obrisan na drugom uređaju (ili adresa šablona koji ne postoji): nazad na Raspored.
    if (last.current) toast(t('schedule.editor.goneElsewhere'));
    backToSchedule();
  }, [live, t]);

  const template = live ?? last.current;
  return template ? <EditorView template={template} leaving={leaving} /> : null;
}

function EditorView({ template, leaving }: { template: Template; leaving: MutableRefObject<boolean> }) {
  const t = useT();
  const lang = useLang();
  const { categories, templates, weekdays, settings } = useScheduleData();
  const catMap = useCategoryMap();
  const [busy, setBusy] = useState<'dup' | 'del' | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [dayNames, setDayNames] = useState<Array<{ title: string; categoryId: number | null }>>([]);

  // Raspored je možda u međuvremenu menjan na drugom uređaju.
  useEffect(() => {
    if (scheduleStore.age() > STALE_MS) void scheduleStore.refresh();
  }, []);

  // Predlozi naziva: i blokovi današnjeg dana (samo korisnikovi podaci; obrisana kategorija se ne predlaže).
  useEffect(() => {
    let alive = true;
    peekDay(logicalNow(settings.dayStart).date).then(
      (d) => {
        if (alive) setDayNames(d.blocks.map((b) => ({ title: b.title, categoryId: b.categoryId != null && catMap.has(b.categoryId) ? b.categoryId : null })));
      },
      () => {},
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.dayStart]);

  const extraNames = useMemo(
    () => [
      ...templates.filter((x) => x.id !== template.id).flatMap((x) => x.blocks.map((b) => ({ title: b.title, categoryId: b.categoryId }))),
      ...dayNames,
    ],
    [templates, template.id, dayNames],
  );

  const stack = useTemplateBlocks({
    template,
    dayStart: settings.dayStart,
    catMap,
    extraNames,
    t,
    lang,
    onLostChanges: () => toast.error(t('schedule.editor.notSaved', { name: template.name })),
  });
  const ctl = stack.ctl;

  /** Izmena koja čeka (blok posle kraja dana) se odbacuje tek uz potvrdu. true = odbačena. */
  const discardHeld = async (): Promise<boolean> => {
    if (!(await confirmDiscard(t('schedule.editor.discardBody')))) return false;
    stack.discard();
    return true;
  };
  // "Nazad" u browseru i zatvaranje taba dok izmena čeka.
  useUnsavedGuard(stack.held && busy == null, discardHeld);

  const goBack = async () => {
    // Iz istorije: "nazad" (useUnsavedGuard pita ako izmena čeka).
    if (fromSchedule()) {
      window.history.back();
      return;
    }
    if (stack.isHeld() && !(await discardHeld())) return;
    navigate(paths.schedule, { replace: true });
  };

  const duplicate = async () => {
    if (busy) return;
    if (stack.isHeld()) {
      const ok = await confirmDialog({
        title: t('schedule.editor.duplicateTitle'),
        body: t('schedule.editor.duplicateBody'),
        confirmText: t('schedule.editor.duplicate'),
      });
      if (!ok) return;
      stack.discard();
    }
    setBusy('dup');
    try {
      // Kopija dobija i poslednju izmenu (red zahteva: prvo čuvanje, pa kopija).
      await stack.settle();
      const payload = await enqueue(() => api.addTemplate({ name: copyName(template.name), copyFrom: template.id }));
      scheduleStore.set(payload);
      toast.success(t('schedule.editor.duplicated'));
      const id = maxId(payload.templates);
      if (id != null && id !== template.id) openTemplate(id, { replace: true });
      else setBusy(null);
    } catch (e) {
      toast.error(errorMessage(e));
      setBusy(null);
    }
  };

  const remove = async () => {
    if (busy) return;
    const usedBy = weekdaysUsing(weekdays, template.id);
    const ok = await confirmDialog({
      title: t('schedule.editor.deleteTitle', { name: template.name }),
      body: usedBy.length ? t('schedule.editor.deleteBodyUsed', { days: weekdayList(usedBy, lang) }) : t('schedule.editor.deleteBodyUnused'),
      confirmText: t('common.delete'),
      danger: true,
    });
    if (!ok) return;
    setBusy('del');
    stack.discard();
    leaving.current = true;
    try {
      const payload = await enqueue(() => api.deleteTemplate(template.id));
      scheduleStore.set(payload);
      toast.success(t('schedule.editor.deleted'));
      backToSchedule();
    } catch (e) {
      leaving.current = false;
      toast.error(errorMessage(e));
      setBusy(null);
    }
  };

  const menu: MenuItem[] = [
    { label: t('schedule.editor.rename'), icon: 'edit', onSelect: () => setRenaming(true), disabled: busy != null },
    { label: t('schedule.editor.duplicate'), icon: 'copy', onSelect: () => void duplicate(), disabled: busy != null },
    { label: t('schedule.editor.delete'), icon: 'trash', onSelect: () => void remove(), disabled: busy != null },
  ];

  const usedBy = weekdaysUsing(weekdays, template.id);
  const sub = t('schedule.editor.sub', { days: usedBy.length ? weekdaySpan(usedBy, lang) : t('schedule.editor.unassigned') });

  // Trake ispod trake šablona: preklapanja iz starijih podataka, prazan šablon.
  const ov = stack.overlaps[0];
  const titleOf = (id: number) => template.blocks.find((b) => b.id === id)?.title ?? '';
  const empty = !ctl.items.some((c) => c.kind === 'block');
  const notice = (
    <>
      {ov && (
        <div className="blk-notice is-warn" role="alert">
          <span className="blk-notice-text">{t('blocks.overlap.banner', { a: titleOf(ov.a), b: titleOf(ov.b) })}</span>
          <Button size="sm" onClick={stack.fixOverlaps}>
            {t('blocks.overlap.fix')}
          </Button>
        </div>
      )}
      {empty && (
        <div className="blk-notice">
          <span className="blk-notice-text">{t('schedule.editor.noBlocks')}</span>
          <Button size="sm" icon="plus" onClick={() => ctl.openNew()}>
            {t('day.addBlock')}
          </Button>
        </div>
      )}
    </>
  );

  return (
    <div className="page blk-page sched-ed-page">
      <div className="sched-ed-top">
        <Link
          to={paths.schedule}
          className="sched-back"
          aria-label={t('schedule.editor.back')}
          onClick={(e) => {
            e.preventDefault();
            void goBack();
          }}
        >
          <Icon name="chevron-left" size={18} />
          <span>{t('shell.page.schedule')}</span>
        </Link>
        <PageHeader className="sched-ed-head" title={template.name} sub={sub} actions={<DayMenu items={menu} />} />
      </div>
      <div className="sched-ed-grid">
        <div className="sched-ed-main">
          <BlockStack ctl={ctl} categories={categories} title={template.name} notice={notice} />
        </div>
        <aside className="sched-ed-side">
          <section className="card sched-ed-note">
            <p>
              <strong>{t('blocks.tpl.noteLead')}</strong> {t('blocks.tpl.note')}
            </p>
          </section>
          <KeysCard mode="template" />
        </aside>
      </div>
      {renaming && <RenameSheet template={template} onClose={() => setRenaming(false)} />}
    </div>
  );
}

/** Mali sheet: novi naziv šablona (jedinstven — 409 ide uz polje). */
function RenameSheet({ template, onClose }: { template: Template; onClose: () => void }) {
  const t = useT();
  const formId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(template.name);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Greška se prikazuje i u podnožju (kao u ostalim sheet-ovima Rasporeda).
  const [failure, setFailure] = useState<string | null>(null);
  const dirty = name.trim() !== template.name;

  // Efekat roditelja se izvršava posle Sheet-ovog showModal(), pa fokus ovde radi.
  useEffect(() => {
    const el = inputRef.current;
    el?.focus();
    el?.select();
  }, []);

  async function requestClose(): Promise<boolean> {
    if (saving) return false;
    if (dirty && !(await confirmDiscard())) return false;
    onClose();
    return true;
  }
  useUnsavedGuard(dirty && !saving, requestClose);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setError(t('schedule.editor.nameRequired'));
      inputRef.current?.focus();
      return;
    }
    if (trimmed === template.name) {
      onClose();
      return;
    }
    setFailure(null);
    setSaving(true);
    try {
      const payload = await enqueue(() => api.patchTemplate(template.id, { name: trimmed }));
      scheduleStore.set(payload);
      onClose();
    } catch (err) {
      setSaving(false);
      const msg = errorMessage(err);
      // Naziv koji već postoji (409): greška ide uz polje za naziv.
      if (err instanceof ApiError && err.status === 409) {
        setError(msg);
        inputRef.current?.focus();
        return;
      }
      toast.error(msg);
      setFailure(msg);
    }
  }

  return (
    <Sheet
      open
      onClose={() => void requestClose()}
      title={t('schedule.editor.renameTitle')}
      size="sm"
      footer={
        <>
          {failure && (
            <p className="sched-foot-error" role="alert">
              {failure}
            </p>
          )}
          <Button variant="ghost" onClick={() => void requestClose()} disabled={saving}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" type="submit" form={formId} loading={saving}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <form id={formId} className="stack" onSubmit={submit} noValidate>
        <Field label={t('schedule.nameLabel')} error={error}>
          <TextInput
            ref={inputRef}
            value={name}
            maxLength={TEMPLATE_NAME_MAX}
            placeholder={t('schedule.newTemplate.namePlaceholder')}
            enterKeyHint="done"
            onChange={(e) => {
              setName(e.target.value);
              if (error) setError(null);
            }}
            aria-invalid={!!error}
          />
        </Field>
      </form>
    </Sheet>
  );
}
