// Glavni ekran: jedan dan — niz blokova (Sada, mapa dana, slaganje u hodu), pregled, zadaci i beleške.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { DayPayload, Template } from '../../../shared/types.ts';
import { DAY_MIN, addDays, isoWeekday, weekdayNameAcc } from '../../../shared/time.ts';
import { summarizeBlocks } from '../../../shared/summary.ts';
import { t as tNow, useLang, useT } from '../i18n/index.ts';
import { useIsDesktop, useLogicalNow } from '../lib/hooks.ts';
import { noteTypedWithin } from '../lib/noteDrafts.ts';
import { TODAY_EVENT, dayPath, navigate } from '../lib/router.tsx';
import { useAllCategories, useAllCategoryMap, useScheduleData } from '../lib/store.ts';
import { Button, Card, Empty, Icon, PageLoader, Spinner, confirmDialog, toast } from '../ui/index.ts';
import { BlockStack, KeysCard } from '../components/blocks/BlockStack.tsx';
import type { CarryOver } from '../components/blocks/StackBar.tsx';
import { useDayBlocks } from '../components/blocks/useDayBlocks.ts';
import { DayHeader } from '../components/day/DayHeader.tsx';
import type { MenuItem } from '../components/day/DayMenu.tsx';
import { dueBlocks } from '../components/day/dayUtils.ts';
import { NotesCard } from '../components/day/NotesCard.tsx';
import { SummaryCard } from '../components/day/SummaryCard.tsx';
import { TaskSheet } from '../components/day/TaskSheet.tsx';
import { TasksCard } from '../components/day/TasksCard.tsx';
import { TemplatePickerSheet } from '../components/day/TemplatePickerSheet.tsx';
import { WelcomeCard } from '../components/day/WelcomeCard.tsx';
import { peekDay, syncNoteDrafts, useDay } from '../components/day/useDay.ts';
import { useSwipeNav } from '../components/day/useSwipeNav.ts';
import './day.css';

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
/** Do koliko sati (logički minut) traka podseća na neocenjene blokove od juče. */
const YESTERDAY_REMINDER_UNTIL = 12 * 60;

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

  // Niz blokova dana (izmene u hodu, čuvanje celog rasporeda, ocene).
  const stack = useDayBlocks({
    date,
    day: day && day.date === date ? day : null,
    dayStart: settings.dayStart,
    now: viewMinute,
    pastDay: isPast && viewMinute == null,
    catMap,
    templates,
    t,
    lang,
    actions,
  });
  const ctl = stack.ctl;
  const blocks = stack.blocks;

  // Sheet koji je stvarno na ekranu (zadatak obrisan na drugom uređaju više nema sheet).
  const editTask = taskId != null ? (day?.tasks.find((x) => x.id === taskId) ?? null) : null;
  const sheetOpen = ctl.nb != null || ctl.detId != null || editTask != null || (pickerOpen && day != null);
  // Rad u nizu koji bi prelazak na novi dan prekinuo: preimenovanje u traci, "Premesti", rezovi, prevlačenje,
  // ručica (sam izbor bloka ne zadržava dan — inače bi mogao da ostane zauvek).
  const stackBusy = useSyncExternalStore(ctl.subscribe, () => ctl.renaming || ctl.moveSt != null || ctl.splitSt != null || ctl.isBusy());

  // Na "/" logičko danas — posle "dan počinje u" se sam prebaci na novi dan, ali tek kad ništa
  // nije otvoreno (sheet bloka/zadatka, kucanje beleške, rad u nizu), da se izmene u toku ne izgube.
  useEffect(() => {
    if (routeDate != null || shownToday === today || sheetOpen || stackBusy) return;
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
  }, [routeDate, today, shownToday, sheetOpen, stackBusy, now.minute, settings.dayStart]);

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

  const dateRef = useRef(date);
  useLayoutEffect(() => {
    dateRef.current = date;
  }, [date]);

  // Promena dana zatvara otvorene sheet-ove (odnose se na prethodni dan).
  useEffect(() => {
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
  // Jučerašnji blok koji traje i posle početka ovog dana (u minutima ovog dana, −1440) i traje sada.
  const carryOver = useMemo<CarryOver | null>(() => {
    if (!isToday) return null;
    let best: CarryOver | null = null;
    for (const b of yDay?.blocks ?? []) {
      if (b.end <= settings.dayStart + DAY_MIN) continue;
      const c = { title: b.title, start: b.start - DAY_MIN, end: b.end - DAY_MIN };
      if (c.start <= now.minute && now.minute < c.end && (!best || c.start >= best.start)) best = c;
    }
    return best;
  }, [yDay, settings.dayStart, isToday, now.minute]);

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
      if (e.defaultPrevented || e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
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

  // Telefon: prevlačenje levo/desno = sledeći/prethodni dan (ne dok se blok prevlači).
  const pageRef = useRef<HTMLDivElement>(null);
  useSwipeNav(
    pageRef,
    () => keysRef.current.go(addDays(keysRef.current.date, -1)),
    () => keysRef.current.go(addDays(keysRef.current.date, 1)),
  );

  // Pregled se računa iz niza na ekranu, pa prati izmene i ocene pre odgovora servera.
  const summary = useMemo(() => summarizeBlocks(blocks, allCategories), [blocks, allCategories]);

  // ---- Šabloni ----

  const [applying, setApplying] = useState(false);

  // Primena šablona zamenjuje sve blokove dana: pita uvek, osim kad dan nema ništa svoje
  // (pregled, prazan dan ili neizmenjena kopija svog šablona).
  const pickTemplate = async (templateId: number | null) => {
    setPickerOpen(false);
    if (!day) return;
    const d = date;
    if (!isPristine(day, templates)) {
      const name = templateId == null ? null : (templates.find((x) => x.id === templateId)?.name ?? null);
      const blocksText = t('common.blocks', { n: day.blocks.length });
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
            ? t('day.template.clearBody', { blocks: blocksText })
            : t('day.template.replaceBody', { blocks: blocksText }),
        confirmText: templateId == null ? t('day.template.clear') : t('day.template.apply'),
        danger: true,
      });
      if (!ok || dateRef.current !== d) return;
    }
    // Nesačuvan raspored ide prvi (isti red), pa šablon zamenjuje dan.
    stack.flush();
    setApplying(true);
    await actions.applyTemplate(templateId);
    setApplying(false);
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
    stack.flush();
    setApplying(true);
    await actions.applyTemplate();
    setApplying(false);
  };

  const openNew = () => ctl.openNew();

  const menuItems: MenuItem[] = [
    { label: t('day.addBlock'), icon: 'plus', onSelect: openNew, disabled: !day || applying },
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

  // Izbor nudi samo neobrisane kategorije; obrisana koju zadatak već ima se prikazuje kao izabrana
  // (sheet je šalje samo ako se promeni, a promena na obrisanu nije moguća).
  const pickerCategories = (id: number | null | undefined) => {
    const own = id != null && !categories.some((c) => c.id === id) ? catMap.get(id) : undefined;
    return own ? [...categories, own] : categories;
  };

  const empty = blocks.length === 0;

  // Trake ispod trake "Sada": podsetnik za juče, pregled iz šablona, ponuda šablona, preklapanja, prazan dan.
  let notice = null;
  if (day && day.date === date) {
    const preview = !day.initialized;
    const ov = stack.overlaps[0];
    const titleOf = (id: number) => day.blocks.find((b) => b.id === id)?.title ?? '';
    notice = (
      <>
        {isToday && yesterdayDue > 0 && (
          <div className="blk-notice">
            <button type="button" className="blk-notice-link" onClick={() => go(yesterday)}>
              {t('day.now.yesterdayDue', { n: yesterdayDue })}
              <Icon name="arrow-right" size={14} />
            </button>
          </div>
        )}
        {preview && (applying || !empty) && (
          <div className="blk-notice" role="note">
            {applying ? <Spinner small /> : <Icon name="info" size={16} />}
            <span className="blk-notice-text">
              {applying
                ? t('day.timeline.preparing')
                : isPast
                  ? day.templateName
                    ? t('day.timeline.untrackedTemplate', { name: day.templateName })
                    : t('day.timeline.untrackedNoTemplate')
                  : day.templateName
                    ? t('day.timeline.previewTemplate', { name: day.templateName })
                    : t('day.timeline.previewNoTemplate')}
            </span>
          </div>
        )}
        {offerWeekday && weekdayTpl && !preview && (
          <div className="blk-notice" role="note">
            <Icon name="info" size={16} />
            <span className="blk-notice-text">
              {t('day.timeline.weekdayOffer', { day: weekdayNameAcc(isoWeekday(date), lang), name: weekdayTpl.name })}
            </span>
            <Button size="sm" variant="ghost" onClick={() => void pickTemplate(weekdayTpl.id)} disabled={applying}>
              {t('day.template.apply')}
            </Button>
          </div>
        )}
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
            <span className="blk-notice-text">{t('day.timeline.empty')}</span>
            <Button size="sm" icon="plus" onClick={openNew} disabled={applying}>
              {t('day.addBlock')}
            </Button>
            {templates.length > 0 && (
              <Button size="sm" variant="ghost" onClick={() => setPickerOpen(true)} disabled={applying}>
                {t('day.timeline.applyTemplate')}
              </Button>
            )}
          </div>
        )}
      </>
    );
  }

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

      {day && day.date === date ? (
        <div className="day-grid is-blocks">
          <div className="day-col">
            {/* Raspored još nije postavljen (nijedan dan nema šablon) i prazan dan: kako se pravi. */}
            {!anyWeekday && empty && (
              <WelcomeCard
                hasCategories={categories.length > 0}
                hasTemplates={templates.length > 0}
                isToday={isToday}
                disabled={applying}
                onAddBlock={openNew}
              />
            )}
            <BlockStack ctl={ctl} categories={categories} notice={notice} carryOver={carryOver} scrollKey={date} />
          </div>
          <div className="day-col day-col-side">
            {/* Prazan dan nema šta da sabere. Desktop: Pregled i Tastatura su na vrhu kolone (uvek na oku). */}
            {!empty && <SummaryCard summary={summary} catMap={catMap} preview={!day.initialized} />}
            <KeysCard />
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
