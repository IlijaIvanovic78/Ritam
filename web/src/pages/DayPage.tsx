// Glavni ekran: jedan dan — "Sada", vremenska linija blokova, pregled, zadaci i beleške.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Block, BlockPatch, BlockStatus, DayPayload, Template } from '../../../shared/types.ts';
import { DAY_MIN, addDays, isoWeekday, weekdayNameAcc } from '../../../shared/time.ts';
import { summarizeBlocks } from '../../../shared/summary.ts';
import { t as tNow, useLang, useT } from '../i18n/index.ts';
import { useIsDesktop, useLogicalNow } from '../lib/hooks.ts';
import { noteTypedWithin } from '../lib/noteDrafts.ts';
import { TODAY_EVENT, dayPath, navigate } from '../lib/router.tsx';
import { useAllCategories, useAllCategoryMap, useScheduleData } from '../lib/store.ts';
import { Button, Card, Empty, PageLoader, confirmDialog, toast } from '../ui/index.ts';
import { BlockSheet } from '../components/day/BlockSheet.tsx';
import { blockDomId } from '../components/day/BlockRow.tsx';
import { DayHeader } from '../components/day/DayHeader.tsx';
import type { MenuItem } from '../components/day/DayMenu.tsx';
import { dueBlocks, scrollToEl, suggestNewRange } from '../components/day/dayUtils.ts';
import { NotesCard } from '../components/day/NotesCard.tsx';
import { NowCard } from '../components/day/NowCard.tsx';
import { SummaryCard } from '../components/day/SummaryCard.tsx';
import { TaskSheet } from '../components/day/TaskSheet.tsx';
import { TasksCard } from '../components/day/TasksCard.tsx';
import { TemplatePickerSheet } from '../components/day/TemplatePickerSheet.tsx';
import { Timeline } from '../components/day/Timeline.tsx';
import { WelcomeCard } from '../components/day/WelcomeCard.tsx';
import { peekDay, syncNoteDrafts, useDay } from '../components/day/useDay.ts';
import './day.css';
import { useSwipeNav } from '../components/day/useSwipeNav.ts';

type Editor =
  /** index = mesto bloka u danu pri otvaranju (za blok iz pregleda, vidi matchBlock). */
  | { kind: 'edit'; id: number; snapshot: Block; index: number }
  | { kind: 'new'; range: { start: number; end: number } };

/** Prečice ne rade dok se kuca ili dok je fokus u meniju. */
function isEditable(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable || t.closest('[role="menu"]')) return true;
  return t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT';
}

/**
 * Kucanje beleške u trenutku kad počinje novi dan ("dan počinje u") zadržava stari dan najviše
 * ovoliko minuta posle te granice — meri se od same granice, ne od trenutka kad je aplikacija
 * primetila promenu (telefon zaključan / laptop uspavan preko noći se budi na novom danu).
 */
const NOTE_HOLD_MIN = 10;
/** Zadržava samo ako se u beleškama stvarno kucalo nedavno (ne samo zaostali fokus). */
const NOTE_TYPING_MS = 2 * 60_000;
/** Do koliko sati (logički minut) "Sada" kartica podseća na neocenjene blokove od juče. */
const YESTERDAY_REMINDER_UNTIL = 12 * 60;

/**
 * Blok iz pregleda u danu posle inicijalizacije: isti indeks ako se poklapa, inače jedini blok sa
 * istim vremenom, naslovom i kategorijom. null ako se plan u međuvremenu promenio (drugi šablon,
 * izmena sa drugog uređaja) — tada se ništa ne menja naslepo.
 */
function matchBlock(list: Block[], b: Block, index: number): Block | null {
  const same = (x: Block | undefined): x is Block =>
    !!x && x.id > 0 && x.start === b.start && x.end === b.end && x.title === b.title && x.categoryId === b.categoryId;
  if (same(list[index])) return list[index];
  const found = list.filter(same);
  return found.length === 1 ? found[0] : null;
}

/** Dan ima ocene ili beleške blokova (primena šablona bi ih obrisala). */
function hasProgress(d: DayPayload): boolean {
  return d.initialized && d.blocks.some((b) => b.status !== 'pending' || b.note.trim() !== '');
}

const blockKey = (b: { start: number; end: number; title: string; categoryId: number | null }) =>
  JSON.stringify([b.start, b.end, b.title, b.categoryId]);

/**
 * Dan je neizmenjena kopija svog šablona (ili prazan / još pregled): primena drugog šablona ne
 * briše ništa što je korisnik uneo. Ručno dodat, pomeren ili preimenovan blok nije.
 */
function isPristine(d: DayPayload, templates: Template[]): boolean {
  if (!d.initialized || d.blocks.length === 0) return true;
  const tpl = d.templateId != null ? templates.find((t) => t.id === d.templateId) : undefined;
  if (!tpl || tpl.blocks.length !== d.blocks.length) return false;
  if (d.blocks.some((b) => b.status !== 'pending' || b.note.trim() !== '')) return false;
  const mine = d.blocks.map(blockKey).sort();
  const theirs = tpl.blocks.map(blockKey).sort();
  return mine.every((k, i) => k === theirs[i]);
}

export default function DayPage({ date: routeDate }: { date: string | null }) {
  const now = useLogicalNow();
  const lang = useLang();
  const t = useT();
  const today = now.date;
  const yesterday = addDays(today, -1);

  const [editor, setEditor] = useState<Editor | null>(null);
  const [taskId, setTaskId] = useState<number | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  const { categories, templates, weekdays, settings } = useScheduleData();
  const [shownToday, setShownToday] = useState(today);

  // Tab/logo "Danas" kliknut dok je već otvoren "/": prikaži novi dan i kad je stari zadržan.
  useEffect(() => {
    const onToday = () => setShownToday(today);
    window.addEventListener(TODAY_EVENT, onToday);
    return () => window.removeEventListener(TODAY_EVENT, onToday);
  }, [today]);

  const held = routeDate == null && shownToday !== today;
  const date = routeDate ?? shownToday;
  const isToday = date === today;
  // Logički minut za prikazani dan: danas, ili zadržan jučerašnji dan (tada je minut + 1440).
  const viewMinute = isToday ? now.minute : held && date === yesterday ? now.minute + DAY_MIN : null;
  // Samo logičko danas se pri otvaranju pravi iz šablona. Raniji dan koji nije praćen ostaje
  // pregled (ne ulazi u statistiku kao 0%) dok ga ne izmeniš ili ne oceniš neki blok.
  // I danas tek kad za taj dan u nedelji postoji šablon: dan otvoren pre nego što je raspored
  // napravljen (nova instalacija) ostaje pregled bez blokova, pa ga šablon dodeljen kasnije istog
  // dana i dalje popuni. Ako raspored na ovom uređaju kasni, a server u pregledu vrati blokove
  // (šablon dodeljen na drugom uređaju), dan se ipak pravi.
  const [previewPlanned, setPreviewPlanned] = useState<string | null>(null);
  const planned = weekdays[isoWeekday(date)] != null || previewPlanned === date;
  const ensure = (isToday || held) && planned;
  // ISO datumi se porede leksikografski.
  const isPast = date < today;

  // Sa obrisanim kategorijama: sačuvani dani ih zadržavaju (prikaz i ispunjenost kao u statistici).
  const allCategories = useAllCategories();
  const catMap = useAllCategoryMap();
  const isDesktop = useIsDesktop();
  const { day, error, loading, fresh, syncs, actions } = useDay(date, ensure);

  useEffect(() => {
    if ((isToday || held) && day?.date === date && !day.initialized && day.blocks.length > 0) setPreviewPlanned(date);
  }, [isToday, held, day, date]);

  // Sheet koji je stvarno na ekranu (zadatak obrisan na drugom uređaju više nema sheet).
  const editTask = taskId != null ? (day?.tasks.find((x) => x.id === taskId) ?? null) : null;
  const sheetOpen = (editor != null && day != null) || editTask != null || (pickerOpen && day != null);

  // Na "/" logičko danas — posle "dan počinje u" se sam prebaci na novi dan, ali tek kad ništa
  // nije otvoreno (sheet bloka/zadatka, kucanje beleške), da se izmene u toku ne izgube.
  useEffect(() => {
    if (routeDate != null || shownToday === today || sheetOpen) return;
    const sinceBoundary = now.minute - settings.dayStart;
    const active = document.activeElement;
    const typingNote =
      sinceBoundary >= 0 &&
      sinceBoundary < NOTE_HOLD_MIN &&
      document.hasFocus() &&
      active instanceof HTMLElement &&
      active.matches('.day-notes-input') &&
      noteTypedWithin(NOTE_TYPING_MS);
    if (!typingNote) setShownToday(today);
  }, [routeDate, today, shownToday, sheetOpen, now.minute, settings.dayStart]);

  // Zadatak iz otvorenog sheet-a je u međuvremenu obrisan ili premešten na drugom uređaju:
  // zatvori sheet i reci zašto (inače bi nestao bez reči, a taskId bi i dalje držao "otvoren sheet").
  const ownTaskChange = useRef(false);
  useEffect(() => {
    if (taskId == null || !day || loading || day.tasks.some((x) => x.id === taskId)) return;
    setTaskId(null);
    // Efekat posle osvežavanja: poruka na jeziku koji je izabran u tom trenutku.
    if (!ownTaskChange.current) toast(tNow('tasks.goneElsewhere'));
    ownTaskChange.current = false;
  }, [taskId, day, loading]);

  /** Izmena iz sheet-a zadatka: zadatak koji zbog nje nestane sa dana (premešten, obrisan) nije tuđa izmena. */
  const taskChange = async (p: Promise<DayPayload | null>) => {
    ownTaskChange.current = true;
    const res = await p;
    if (!res) ownTaskChange.current = false;
    return res;
  };

  const [initializing, setInitializing] = useState(false);
  const initializingRef = useRef(false);

  const dateRef = useRef(date);
  useLayoutEffect(() => {
    dateRef.current = date;
  }, [date]);

  // Promena dana zatvara otvorene sheet-ove (odnose se na prethodni dan).
  useEffect(() => {
    setEditor(null);
    setTaskId(null);
    setPickerOpen(false);
  }, [date]);

  const go = useCallback(
    (d: string) => {
      // Na "/" sa zadržanim jučerašnjim danom "Danas" samo prebacuje prikaz.
      if (d === today && routeDate == null) setShownToday(today);
      navigate(dayPath(d, today));
    },
    [today, routeDate],
  );

  // Ujutru: podseti na blokove od juče koji nisu ocenjeni (npr. blok koji se završava baš kad
  // dan pređe na sledeći), i pokaži jučerašnji blok koji još traje (npr. noćni do jutra) kao
  // trenutni. Jučerašnji dan se ovde ne pravi iz šablona.
  const [yesterdayDay, setYesterdayDay] = useState<DayPayload | null>(null);
  const morning = isToday && routeDate == null && now.minute < YESTERDAY_REMINDER_UNTIL;
  useEffect(() => {
    if (!morning) {
      setYesterdayDay(null);
      return;
    }
    let alive = true;
    peekDay(yesterday).then(
      (p) => {
        if (alive) setYesterdayDay(p);
      },
      () => {},
    );
    return () => {
      alive = false;
    };
    // syncs: i pri svakom osvežavanju dana (povratak u aplikaciju — juče je možda ocenjeno negde drugde).
  }, [morning, yesterday, syncs]);
  const yDay = morning && yesterdayDay?.date === yesterday ? yesterdayDay : null;
  // Samo blokovi od juče koji su se već završili (u minutima jučerašnjeg dana sada je minut + 1440).
  const yesterdayDue = yDay?.initialized ? dueBlocks(yDay.blocks, now.minute + DAY_MIN, catMap).length : 0;
  // Jučerašnji blokovi koji traju i posle početka ovog dana, u minutima ovog dana (−1440).
  const carryOver = useMemo(
    () =>
      (yDay?.blocks ?? [])
        .filter((b) => b.end > settings.dayStart + DAY_MIN)
        .map((b) => ({ ...b, start: b.start - DAY_MIN, end: b.end - DAY_MIN })),
    [yDay, settings.dayStart],
  );

  // Beleške drugih dana koje su ostale samo na ovom uređaju: pošalji ih ili ponudi link.
  const [otherDrafts, setOtherDrafts] = useState<string[]>([]);
  const sweepRef = useRef<() => void>(() => {});
  useEffect(() => {
    let alive = true;
    const sweep = () => {
      syncNoteDrafts(date).then(
        (left) => {
          if (alive) setOtherDrafts((cur) => (cur.join() === left.join() ? cur : left));
        },
        () => {},
      );
    };
    const onVis = () => {
      if (document.visibilityState === 'visible') sweep();
    };
    sweepRef.current = sweep;
    sweep();
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('online', sweep);
    return () => {
      alive = false;
      sweepRef.current = () => {};
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('online', sweep);
    };
  }, [date]);

  // Server je ponovo odgovorio (svež odgovor za dan): pošalji i beleške drugih dana koje su čekale.
  const hasOtherDrafts = otherDrafts.length > 0;
  const hasOtherDraftsRef = useRef(hasOtherDrafts);
  hasOtherDraftsRef.current = hasOtherDrafts;
  useEffect(() => {
    if (syncs > 0 && hasOtherDraftsRef.current) sweepRef.current();
  }, [syncs]);

  // Beleška čeka svež odgovor servera: osveži dan (najviše jednom u 3 s dok se kuca; odmah na "Pokušaj ponovo").
  const needFresh = useCallback((urgent: boolean) => actions.refreshIfStale(urgent ? 0 : 3_000), [actions]);

  // ---- Prečice na tastaturi: ← / → prethodni/sledeći dan, t = danas ----
  const keysRef = useRef({ go, date, today });
  useLayoutEffect(() => {
    keysRef.current = { go, date, today };
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
      if (isEditable(e.target) || document.querySelector('dialog[open]')) return;
      const k = keysRef.current;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        k.go(addDays(k.date, -1));
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        k.go(addDays(k.date, 1));
      } else if (e.key === 't' || e.key === 'T') {
        if (k.date !== k.today) {
          e.preventDefault();
          k.go(k.today);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Telefon: prevlačenje levo/desno = sledeći/prethodni dan.
  const pageRef = useRef<HTMLDivElement>(null);
  useSwipeNav(
    pageRef,
    () => keysRef.current.go(addDays(keysRef.current.date, -1)),
    () => keysRef.current.go(addDays(keysRef.current.date, 1)),
  );

  // Pregled se računa na klijentu, pa prati optimističke izmene statusa.
  const blocks = day?.blocks;
  const summary = useMemo(() => (blocks ? summarizeBlocks(blocks, allCategories) : null), [blocks, allCategories]);

  // ---- Pregled iz šablona → pravi dan pre prve izmene ----

  /** Inicijalizuje dan (ako treba); null ako nije uspelo ili je korisnik u međuvremenu promenio dan. */
  const withInit = async (): Promise<DayPayload | null> => {
    if (initializingRef.current) return null;
    const d = dateRef.current;
    initializingRef.current = true;
    setInitializing(true);
    const p = await actions.ensureInit();
    initializingRef.current = false;
    setInitializing(false);
    if (!p || p.date !== d || dateRef.current !== d) return null;
    return p;
  };

  /**
   * Blok iz pregleda (negativan id) se otvara bez upisa: samo gledanje ne zamrzava dan, pa kasnije
   * izmene šablona i dalje važe za njega. Dan se upisuje iz šablona tek pri prvoj izmeni u sheet-u.
   */
  const resolvedPreview = useRef<{ previewId: number; id: number } | null>(null);

  const openBlock = (block: Block, index: number) => {
    // Forma kreće od onoga što je na ekranu; ako je to staro, osveži (drugi uređaj).
    actions.refreshIfStale();
    resolvedPreview.current = null;
    setEditor({ kind: 'edit', id: block.id, snapshot: block, index });
  };

  /**
   * Pravi id bloka za izmenu iz sheet-a. Za blok iz pregleda: inicijalizuj dan, pa isti blok (isti
   * indeks, ili isto vreme i naslov); null ako nije uspelo ili se plan u međuvremenu promenio.
   */
  const realBlockId = async (id: number): Promise<number | null> => {
    if (id > 0) return id;
    if (resolvedPreview.current?.previewId === id) return resolvedPreview.current.id;
    if (editor?.kind !== 'edit' || editor.id !== id) return null;
    const { snapshot, index } = editor;
    const p = await withInit();
    if (!p) return null;
    const b = matchBlock(p.blocks, snapshot, index);
    if (!b) {
      toast(t('day.planChanged'));
      return null;
    }
    resolvedPreview.current = { previewId: id, id: b.id };
    return b.id;
  };

  const sheetPatch = async (id: number, patch: BlockPatch) => {
    const real = await realBlockId(id);
    return real == null ? null : actions.patchBlock(real, patch);
  };
  const sheetSplit = async (id: number, at: number) => {
    const real = await realBlockId(id);
    return real == null ? null : actions.splitBlock(real, at);
  };
  const sheetDelete = async (id: number) => {
    const real = await realBlockId(id);
    return real == null ? null : actions.deleteBlock(real);
  };

  /** Status iz vremenske linije. Na pregledu ranijeg dana prva ocena upisuje dan iz šablona. */
  const setBlockStatus = async (block: Block, index: number, status: BlockStatus) => {
    if (block.id > 0) {
      void actions.setStatus(block.id, status);
      return;
    }
    const p = await withInit();
    if (!p) return;
    const b = matchBlock(p.blocks, block, index);
    if (b) void actions.setStatus(b.id, status);
    else toast(t('day.planChanged'));
  };

  // Na pregledu se dan ne upisuje unapred: server ga inicijalizuje tek kad se blok stvarno doda.
  const openNew = () => {
    if (!day) return;
    resolvedPreview.current = null;
    setEditor({ kind: 'new', range: suggestNewRange(day.blocks, settings.dayStart, viewMinute) });
  };

  // ---- Šabloni ----

  // Primena šablona zamenjuje sve blokove dana: pita uvek, osim kad dan nema ništa svoje
  // (pregled, prazan dan ili neizmenjena kopija svog šablona).
  const pickTemplate = async (templateId: number | null) => {
    setPickerOpen(false);
    if (!day) return;
    const d = date;
    if (!isPristine(day, templates)) {
      const name = templateId == null ? null : (templates.find((x) => x.id === templateId)?.name ?? null);
      const blocks = t('common.blocks', { n: day.blocks.length });
      const ok = await confirmDialog({
        title:
          templateId == null
            ? t('day.template.clearTitle')
            : name
              ? t('day.template.applyNamedTitle', { name })
              : t('day.template.applyTitle'),
        body: hasProgress(day)
          ? t('day.template.progressLost')
          : templateId == null
            ? t('day.template.clearBody', { blocks })
            : t('day.template.replaceBody', { blocks }),
        confirmText: templateId == null ? t('day.template.clear') : t('day.template.apply'),
        danger: true,
      });
      if (!ok || dateRef.current !== d) return;
    }
    await actions.applyTemplate(templateId);
  };

  const resetToTemplate = async () => {
    if (!day) return;
    const d = date;
    const tpl = templates.find((x) => x.id === weekdays[isoWeekday(d)]);
    const ok = await confirmDialog({
      title: t('day.reset.title'),
      body: tpl ? t('day.reset.body', { name: tpl.name }) : t('day.reset.bodyNoTemplate'),
      confirmText: t('day.reset.confirm'),
      danger: true,
    });
    if (!ok || dateRef.current !== d) return;
    await actions.applyTemplate();
  };

  const menuItems: MenuItem[] = [
    { label: t('day.addBlock'), icon: 'plus', onSelect: openNew, disabled: !day || initializing },
    {
      label: t('day.menu.applyOtherTemplate'),
      icon: 'blocks',
      onSelect: () => setPickerOpen(true),
      disabled: !day || templates.length === 0,
    },
    { label: t('day.menu.resetToTemplate'), icon: 'refresh', onSelect: resetToTemplate, disabled: !day?.initialized },
  ];

  // Raspored još nije postavljen (nijedan dan u nedelji nema šablon): kartica sa koracima ostaje.
  const anyWeekday = Object.values(weekdays).some((id) => id != null && templates.some((x) => x.id === id));
  // Dan napravljen bez šablona (npr. blok dodat pre nego što je raspored napravljen), a njegov dan
  // u nedelji sada ima šablon: ponudi ga (ne za ranije dane — to je istorija).
  const weekdayTpl = templates.find((x) => x.id === weekdays[isoWeekday(date)]) ?? null;
  const offerWeekday = !!day && day.initialized && day.templateId == null && weekdayTpl != null && !isPast;

  const jumpTo = (b: Block) => {
    const el = document.getElementById(blockDomId(b.id));
    scrollToEl(el);
    el?.focus({ preventScroll: true });
  };

  const editBlock =
    editor?.kind === 'edit' ? (day?.blocks.find((b) => b.id === editor.id) ?? editor.snapshot) : null;
  // Sačuvan blok iz otvorenog sheet-a više ne postoji na serveru (obrisan na drugom uređaju).
  const editDeleted =
    editor?.kind === 'edit' && editor.id > 0 && !!day && fresh && !day.blocks.some((b) => b.id === editor.id);
  // Izbor nudi samo neobrisane kategorije; obrisana koju blok/zadatak već ima se prikazuje kao izabrana
  // (sheet je šalje samo ako se promeni, a promena na obrisanu nije moguća).
  const pickerCategories = (id: number | null | undefined) => {
    const own = id != null && !categories.some((c) => c.id === id) ? catMap.get(id) : undefined;
    return own ? [...categories, own] : categories;
  };

  return (
    <div className="page day-page" ref={pageRef}>
      <DayHeader
        date={date}
        today={today}
        templateName={day?.templateName ?? null}
        isDesktop={isDesktop}
        onGo={go}
        menuItems={menuItems}
      />

      {day && summary ? (
        <div className="day-grid">
          <div className="day-col">
            {/* Raspored još nije postavljen (nijedan dan nema šablon) i prazan dan: kako se pravi. */}
            {!anyWeekday && day.blocks.length === 0 && (
              <WelcomeCard
                hasCategories={categories.length > 0}
                hasTemplates={templates.length > 0}
                isToday={isToday}
                disabled={initializing}
                onAddBlock={openNew}
              />
            )}
            {viewMinute != null && (
              <NowCard
                blocks={day.blocks}
                carryOver={isToday ? carryOver : undefined}
                minute={viewMinute}
                catMap={catMap}
                onJump={jumpTo}
                yesterdayDue={isToday ? yesterdayDue : 0}
                onYesterday={() => go(yesterday)}
              />
            )}
            <Timeline
              day={day}
              minute={viewMinute}
              past={isPast}
              catMap={catMap}
              initializing={initializing}
              hasTemplates={templates.length > 0}
              weekdayOffer={
                offerWeekday && weekdayTpl
                  ? { day: weekdayNameAcc(isoWeekday(date), lang), name: weekdayTpl.name }
                  : null
              }
              onApplyWeekday={() => {
                if (weekdayTpl) void pickTemplate(weekdayTpl.id);
              }}
              onOpen={openBlock}
              onStatus={setBlockStatus}
              onAdd={openNew}
              onPickTemplate={() => setPickerOpen(true)}
            />
          </div>
          <div className="day-col">
            {/* Prazan dan nema šta da sabere. */}
            {day.blocks.length > 0 && <SummaryCard summary={summary} catMap={catMap} preview={!day.initialized} />}
            <TasksCard
              tasks={day.tasks}
              openBefore={day.openBefore}
              showCarry={isToday}
              catMap={catMap}
              onAdd={actions.addTask}
              onToggle={actions.toggleTask}
              onOpen={(task) => setTaskId(task.id)}
              onCarry={actions.carryTasks}
            />
            <NotesCard
              key={date}
              date={date}
              note={day.note}
              fresh={fresh}
              settled={!loading}
              rating={day.rating}
              otherDrafts={otherDrafts}
              syncs={syncs}
              onSaveNote={actions.saveNote}
              onRate={actions.setRating}
              onFocusNotes={() => actions.refreshIfStale()}
              onNeedFresh={needFresh}
              onOpenDay={go}
            />
          </div>
        </div>
      ) : error ? (
        <Card>
          <Empty
            title={t('day.loadError')}
            text={error}
            action={
              <Button icon="refresh" onClick={actions.reload}>
                {t('common.retry')}
              </Button>
            }
          />
        </Card>
      ) : (
        <div className="day-loader">
          <PageLoader />
        </div>
      )}

      {editor && day && (
        <BlockSheet
          key={editor.kind === 'edit' ? `edit-${editor.id}` : 'new'}
          block={editBlock}
          deleted={editDeleted}
          dayBlocks={day.blocks}
          initialRange={editor.kind === 'new' ? editor.range : { start: 0, end: 0 }}
          categories={pickerCategories(editBlock?.categoryId)}
          dayStart={settings.dayStart}
          onClose={() => setEditor(null)}
          returnFocus={editor.kind === 'edit' ? () => document.getElementById(blockDomId(editor.id)) : undefined}
          onAdd={actions.addBlock}
          onPatch={sheetPatch}
          onSplit={sheetSplit}
          onSwap={actions.swapBlocks}
          onDelete={sheetDelete}
        />
      )}

      {editTask && (
        <TaskSheet
          key={editTask.id}
          task={editTask}
          today={today}
          categories={pickerCategories(editTask.categoryId)}
          onClose={() => {
            ownTaskChange.current = false;
            setTaskId(null);
          }}
          onPatch={(id, patch) => taskChange(actions.patchTask(id, patch))}
          onDelete={(id) => taskChange(actions.deleteTask(id))}
        />
      )}

      {pickerOpen && day && (
        <TemplatePickerSheet
          templates={templates}
          weekdays={weekdays}
          currentTemplateId={day.templateId}
          dayStart={settings.dayStart}
          catMap={catMap}
          onPick={pickTemplate}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}
