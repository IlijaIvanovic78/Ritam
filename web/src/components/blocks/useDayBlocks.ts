// Niz blokova dana ↔ server. Kontroler (StackController) drži niz na ekranu; ovaj hook ga puni iz DayPayload-a i
// čuva izmene:
// - raspored (premeštanje, deljenje, trajanje, dodavanje, brisanje, naziv, detalji, poništi): 700 ms posle
//   poslednje izmene ceo raspored ide kroz zajednički red zahteva (`PUT /api/days/:date/blocks`, telo iz
//   `toBlocks`, `base` = `layoutBase` stanja sa servera na koje se izmena oslanja, računato u trenutku slanja);
// - ocena (✓ ◐ ✕) bloka koji server ima: odmah `PATCH /api/blocks/:id` (isti red);
// - odgovor našeg PUT-a postaje potvrđeno stanje (`base`); odgovor PATCH-a menja u njemu samo taj blok (ceo dan sa
//   tuđim izmenama preuzima tek crtanje, kad ništa ne čeka — inače bi zastareo raspored prošao proveru `base`);
//   novi blokovi dobijaju id sa servera (isti redovi, izbor i istorija; i raspored koji već čeka u redu);
// - status / stvarno vreme / beleška bloka se šalju samo ako se razlikuju od vrednosti koje je OVAJ ekran poslednje
//   preuzeo ili poslao (`fields`), pa tuđa beleška iz odgovora koji još nije preuzet ne biva obrisana;
// - greška: vraća se poslednje potvrđeno stanje, istorija se briše, poruka; 409 (dan promenjen na drugom uređaju)
//   = ponovo učitan dan i njegova poruka. useDay ionako ponovo učita dan. Greška posle napuštanja dana / ekrana:
//   toast sa danom;
// - stanje sa servera (osvežavanje, drugi uređaj, primena šablona) se preuzima samo kad ništa nije na čekanju ni u
//   toku (gest, sheet); tada se istorija briše ako se raspored zaista promenio;
// - pregled (dan još nije upisan, negativni id-jevi): prva izmena ga upisuje (PUT inicijalizuje dan);
// - raspored zaključan (preklapanja): nikad ceo raspored (samo "Popravi"); ocene i detalji pojedinačno (PATCH), a
//   na pregledu se dan prvo upiše iz šablona kakav jeste.
// Čuvanje se ne odlaže preko promene dana, sakrivanja stranice ni napuštanja ekrana.

import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { Block, BlockPatch, Category, DayPayload, Template } from '../../../../shared/types.ts';
import { capitalize, fmtDateMedium } from '../../../../shared/time.ts';
import {
  fromBlocks,
  layoutBase,
  toBlocks,
  type BlockFields,
  type Frame,
  type ItemId,
  type StackItem,
} from '../../../../shared/blockStack.ts';
import { api, ApiError, errorMessage } from '../../api.ts';
import { toast } from '../../ui/index.ts';
import type { Lang, TFunction } from '../../i18n/index.ts';
import type { DayActions } from '../day/useDay.ts';
import { StackController, type CommitEvent } from './controller.ts';

/** Pauza posle poslednje izmene pre slanja rasporeda. */
const SAVE_DEBOUNCE_MS = 700;
/** Koliko dugo stoji "Sačuvano". */
const SAVED_MS = 2000;

const sameFrame = (a: Frame, b: Frame) => a.start === b.start && a.end === b.end;

/** Isti raspored i ista polja (slobodno vreme se poredi samo po trajanju — id mu je klijentski). */
function sameStack(a: readonly StackItem[], b: readonly StackItem[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.kind !== y.kind || x.dur !== y.dur) return false;
    if (x.kind === 'block' && y.kind === 'block') {
      if (x.id !== y.id || x.title !== y.title || x.categoryId !== y.categoryId || x.status !== y.status || x.actualMin !== y.actualMin || x.note !== y.note)
        return false;
    }
  }
  return true;
}

/** Blokovi niza kao blokovi dana (Pregled se računa iz onoga što je na ekranu, i pre čuvanja). */
export function stackBlocks(items: readonly StackItem[], frame: Frame, date: string): Block[] {
  const out: Block[] = [];
  let t = frame.start;
  items.forEach((c, i) => {
    if (c.kind === 'block')
      out.push({
        id: typeof c.id === 'number' ? c.id : -1_000_000 - i,
        date,
        start: t,
        end: t + c.dur,
        title: c.title,
        categoryId: c.categoryId,
        status: c.status,
        actualMin: c.actualMin,
        note: c.note,
      });
    t += c.dur;
  });
  return out;
}

interface SyncState {
  date: string | null;
  dayStart: number;
  /** Stanje sa servera na koje se oslanja niz na ekranu (base za PUT, potvrđene ocene i beleške). */
  base: DayPayload | null;
  frame: Frame | null;
  /** Poslednji DayPayload koji je preuzet (ili namerno preskočen jer je isti). */
  seen: DayPayload | null;
  /** Lokalna izmena koja još nije poslata (tajmer). */
  dirty: boolean;
  timer: number;
  /** Zahtevi ovog niza u redu / u toku. */
  inflight: number;
  savedTimer: number;
  overlaps: Array<{ a: number; b: number }>;
  /**
   * Odgovori servera stariji od našeg potvrđenog stanja: dan koji je bio na ekranu kad je stigao odgovor naše izmene
   * (useDay ga ne zamenjuje odgovorom ako je posle izmene krenulo osvežavanje) se više ne preuzima.
   */
  older: WeakSet<DayPayload>;
  /** `base` po danu (raspored prethodnog dana koji još čeka u redu računa `base` kad krene, ne kad je zapamćen). */
  bases: Map<string, DayPayload>;
  /** Status / stvarno vreme / beleška koje je ovaj ekran poslednje preuzeo ili poslao, po id-ju bloka sa servera. */
  fields: Map<number, Fields>;
  /** Klijentski id (nov blok, deo) → id sa servera, za raspored koji je zapamćen pre odgovora koji ga je dodelio. */
  idMap: Map<ItemId, number>;
  /** Ekran je napušten (greška čuvanja tada ide kao toast). */
  disposed: boolean;
}

type Fields = Pick<Block, 'status' | 'actualMin' | 'note'>;
const fieldsOf = (b: Fields): Fields => ({ status: b.status, actualMin: b.actualMin, note: b.note });

export function useDayBlocks(o: {
  date: string;
  day: DayPayload | null;
  dayStart: number;
  /** Logički minut za danas / zadržano juče; null = drugi dan. */
  now: number | null;
  /** Raniji dan (ne zadržano juče). */
  pastDay: boolean;
  catMap: Map<number, Category>;
  templates: Template[];
  t: TFunction;
  lang: Lang;
  actions: DayActions;
}) {
  const s = useRef<SyncState>({
    date: null,
    dayStart: o.dayStart,
    base: null,
    frame: null,
    seen: null,
    dirty: false,
    timer: 0,
    inflight: 0,
    savedTimer: 0,
    overlaps: [],
    older: new WeakSet(),
    bases: new Map(),
    fields: new Map(),
    idMap: new Map(),
    disposed: false,
  }).current;
  const optsRef = useRef(o);
  optsRef.current = o;
  const dayRef = useRef(o.day);
  dayRef.current = o.day;
  /** Naš odgovor `p` je potvrđeno stanje: dan koji je sada na ekranu (ako je drugi) je stariji od njega. */
  const supersede = (p: DayPayload) => {
    const cur = dayRef.current;
    if (cur && cur !== p && cur.date === p.date) s.older.add(cur);
  };
  const actionsRef = useRef(o.actions);
  actionsRef.current = o.actions;

  const extraNames = useMemo(() => o.templates.flatMap((tpl) => tpl.blocks.map((b) => ({ title: b.title, categoryId: b.categoryId }))), [o.templates]);

  const ctlRef = useRef<StackController | null>(null);
  const onCommitRef = useRef<(e: CommitEvent) => void>(() => {});
  const onPatchRef = useRef<(id: ItemId, f: BlockFields) => void>(() => {});
  const cfg = {
    mode: 'day' as const,
    now: o.now,
    pastDay: o.pastDay,
    locked: s.overlaps.length > 0,
    catMap: o.catMap,
    t: o.t,
    lang: o.lang,
    extraNames,
    onCommit: (e: CommitEvent) => onCommitRef.current(e),
    onPatchFields: (id: ItemId, f: BlockFields) => onPatchRef.current(id, f),
  };
  if (!ctlRef.current) ctlRef.current = new StackController(cfg, [], o.dayStart);
  const ctl = ctlRef.current;
  ctl.cfg = cfg;

  const showSaving = () => {
    window.clearTimeout(s.savedTimer);
    ctl.setSaveState(s.dirty || s.inflight > 0 ? 'saving' : 'idle');
  };

  const showSaved = () => {
    if (s.dirty || s.inflight > 0) return;
    ctl.setSaveState('saved');
    window.clearTimeout(s.savedTimer);
    s.savedTimer = window.setTimeout(() => ctl.setSaveState('idle'), SAVED_MS);
  };

  /** Potvrđeno stanje dana `date` (i `s.base`, ako je to dan na ekranu). */
  const setBase = (date: string, p: DayPayload) => {
    s.bases.set(date, p);
    if (s.date === date) s.base = p;
  };

  /** Ekran sada prikazuje ove blokove: njihova polja su ono što je ekran preuzeo. */
  const absorb = (blocks: readonly Block[]) => {
    for (const b of blocks) s.fields.set(b.id, fieldsOf(b));
  };

  /** `confirmed` za toBlocks: blokovi koje server ima, sa poljima koja je ovaj ekran poslednje preuzeo ili poslao. */
  const confirmedOf = (base: DayPayload | null): Block[] =>
    base?.initialized
      ? base.blocks.map((b) => {
          const f = s.fields.get(b.id);
          return f ? { ...b, ...f } : b;
        })
      : [];

  /** Odgovor PATCH-a: u potvrđenom stanju se menja samo taj blok (polja koja su poslata). */
  const mergePatched = (date: string, p: DayPayload, id: number, keys: ReadonlyArray<keyof BlockPatch>) => {
    const cur = s.bases.get(date);
    const pb = p.blocks.find((b) => b.id === id);
    if (!cur || !pb) return;
    const pick: Partial<Block> = {};
    for (const k of keys) if (k in pb) Object.assign(pick, { [k]: pb[k as keyof Block] });
    setBase(date, { ...cur, blocks: cur.blocks.map((b) => (b.id === id ? { ...b, ...pick } : b)) });
  };

  /** Poruka greške čuvanja (409: poruka servera; bez mreže: "Nema interneta…"). */
  const failText = (e: unknown) =>
    e instanceof ApiError && e.status === 409
      ? errorMessage(e)
      : !navigator.onLine
        ? optsRef.current.t('shell.offline')
        : optsRef.current.t('blocks.msg.saveFailed');

  /** Čuvanje dana koji više nije na ekranu (promena dana, napušten ekran) nije uspelo: toast sa danom. */
  const failedElsewhere = (date: string, e: unknown) => {
    const { t, lang } = optsRef.current;
    toast.error(t('blocks.msg.failedFor', { what: capitalize(fmtDateMedium(date, lang)), msg: failText(e) }));
  };

  /** Preuzmi stanje sa servera (bez obaveštavanja tokom crtanja — BlockStack se crta posle ovoga). */
  const adopt = (day: DayPayload, silent: boolean) => {
    const r = fromBlocks(day.blocks, o.dayStart);
    s.seen = day;
    setBase(day.date, day);
    absorb(day.blocks);
    s.overlaps = r.overlaps;
    ctl.cfg = { ...ctl.cfg, locked: r.overlaps.length > 0 };
    const frameChanged = !s.frame || !sameFrame(s.frame, r.frame);
    s.frame = r.frame;
    if (!frameChanged && sameStack(ctl.items, r.items)) return;
    const hadItems = ctl.items.length > 0;
    ctl.replace(r.items, r.frame, { resetHistory: hadItems, silent });
  };

  /** Šta se šalje: dan, okvir i niz sada; `base` se računa kad zahtev krene (ovaj samo ako za taj dan nema novijeg). */
  const snapshot = () => ({ date: s.date, frame: s.frame, items: ctl.items, base: s.base });

  /** Pošalji raspored odmah (ili posle pauze). `snap` = raspored prethodnog dana (promena dana). */
  const sendPut = (snap?: ReturnType<typeof snapshot>) => {
    if (!snap) {
      window.clearTimeout(s.timer);
      s.timer = 0;
      if (!s.dirty) return;
      s.dirty = false;
    }
    const { date, frame, items: captured } = snap ?? snapshot();
    const oldBase = snap?.base ?? null;
    if (!date || !frame) return;
    s.inflight += 1;
    showSaving();
    // Klijentski id-jevi blokova koji idu bez id-ja: posle odgovora dobijaju id sa servera.
    const map = new Map<ItemId, ItemId>();
    let failure: unknown = null;
    let failed = false;
    void actionsRef.current
      .run(
        async () => {
          try {
            // Sve se računa kad zahtev krene (posle odgovora na prethodne iz reda): `base` dana, id-jevi koje je
            // prethodni PUT dodelio novim blokovima ovog rasporeda, polja koja je ekran preuzeo.
            const base = s.date === date ? s.base : (s.bases.get(date) ?? oldBase);
            const items = captured.map((c) => (c.kind === 'block' && s.idMap.has(c.id) ? { ...c, id: s.idMap.get(c.id)! } : c));
            const { blocks, invalid } = toBlocks(items, frame, { confirmed: confirmedOf(base) });
            if (invalid.length) throw new ApiError(400, o.t('blocks.msg.saveFailed'));
            const sentIds = new Set(blocks.filter((b) => b.id != null).map((b) => b.id!));
            const p = await api.putDayBlocks(date, { blocks, base: base ? layoutBase(base.blocks) : undefined });
            // Novi blokovi → id sa servera (isto vreme, naziv i kategorija; ako ima više istih, redom); polja svih
            // poslatih blokova su sada ono što je ovaj ekran poslao.
            const used = new Set<number>();
            let k = 0;
            for (const c of items) {
              if (c.kind !== 'block') continue;
              const b = blocks[k++];
              let sid = b.id ?? null;
              if (sid == null) {
                const hit = p.blocks.find(
                  (x) => !sentIds.has(x.id) && !used.has(x.id) && x.start === b.start && x.end === b.end && x.title === b.title && x.categoryId === b.categoryId,
                );
                if (hit) {
                  used.add(hit.id);
                  sid = hit.id;
                  if (hit.id !== c.id) {
                    map.set(c.id, hit.id);
                    s.idMap.set(c.id, hit.id);
                  }
                }
              }
              if (sid != null) s.fields.set(sid, fieldsOf(c));
            }
            setBase(date, p);
            return p;
          } catch (e) {
            failure = e;
            failed = true;
            throw e;
          }
        },
        { forDate: date, quiet: true },
      )
      .then((p) => {
        // Tek ovde (posle zamene id-jeva): crtanje između odgovora i ovoga ne sme da preuzme odgovor kao tuđu izmenu.
        s.inflight -= 1;
        if (s.disposed || s.date !== date) {
          // Dan / ekran je napušten: niz više nije taj dan, pa greška ide kao toast (inače bi izmena nestala bez reči).
          if (!p || failed) failedElsewhere(date, failure);
          if (!s.disposed) showSaving();
          return;
        }
        if (!p || failed) {
          rollback(failure);
          return;
        }
        ctl.remap(map);
        supersede(p);
        if (!s.dirty && s.inflight === 0 && !ctl.isBusy()) adopt(p, false);
        showSaved();
      });
  };

  /** Čuvanje nije uspelo: vrati poslednje potvrđeno stanje (useDay ponovo učitava dan). */
  const rollback = (e: unknown) => {
    window.clearTimeout(s.timer);
    s.timer = 0;
    s.dirty = false;
    showSaving();
    const base = s.base;
    if (base && s.inflight === 0) {
      const r = fromBlocks(base.blocks, o.dayStart);
      s.seen = base;
      s.frame = r.frame;
      absorb(base.blocks);
      ctl.replace(r.items, r.frame, { resetHistory: true });
    }
    ctl.message(failText(e));
  };

  const schedule = () => {
    s.dirty = true;
    window.clearTimeout(s.timer);
    s.timer = window.setTimeout(() => sendPut(), SAVE_DEBOUNCE_MS);
    showSaving();
  };

  /** Blok koji server ima (pozitivan id u potvrđenom, upisanom danu). */
  const known = (id: ItemId | undefined): id is number =>
    typeof id === 'number' && id > 0 && !!s.base?.initialized && s.base.blocks.some((b) => b.id === id);

  /**
   * Polja jednog bloka odmah (`PATCH /api/blocks/:id`, isti red). `screen` = vrednosti koje su sada na ekranu (ocena);
   * null = ekran ih prikazuje tek kad preuzme odgovor (detalji dok je raspored zaključan). Na pregledu zaključanog
   * rasporeda (`preview`) dan se prvo upiše iz šablona kakav jeste, pa se menja njegov blok sa istim vremenom i
   * nazivom kao blok pregleda (ne mesto u rasporedu "Popravi" na ekranu).
   */
  const sendPatch = (id: ItemId, patch: BlockPatch, screen: Partial<Fields> | null, preview: Block | null) => {
    const date = s.date;
    if (!date) return;
    s.inflight += 1;
    showSaving();
    let failure: unknown = null;
    let failed = false;
    void actionsRef.current
      .run(
        async () => {
          try {
            let sid = id as number;
            if (preview) {
              // GET sa ensure upisuje dan iz šablona (preklapanja ostaju), a već upisan dan samo vraća.
              const d = await api.day(date, true);
              const hit = d.blocks.find(
                (b) => b.start === preview.start && b.end === preview.end && b.title === preview.title && b.categoryId === preview.categoryId,
              );
              if (!hit) throw new ApiError(409, optsRef.current.t('blocks.msg.saveFailed'));
              sid = hit.id;
            }
            const p = await api.patchBlock(sid, patch);
            if (!preview) {
              // Potvrđeno stanje dobija samo ovu izmenu (tuđe izmene iz odgovora preuzima crtanje, kad ništa ne čeka).
              mergePatched(date, p, sid, Object.keys(patch) as Array<keyof BlockPatch>);
              const was = s.fields.get(sid) ?? s.base?.blocks.find((b) => b.id === sid);
              if (screen && was) s.fields.set(sid, { ...fieldsOf(was), ...screen });
            }
            return p;
          } catch (err) {
            failure = err;
            failed = true;
            throw err;
          }
        },
        { forDate: date, quiet: !!preview },
      )
      .then((p) => {
        s.inflight -= 1;
        if (s.disposed || s.date !== date) {
          if (preview && (!p || failed)) failedElsewhere(date, failure);
          if (!s.disposed) showSaving();
          return;
        }
        // Greška: useDay je vratio potvrđeno stanje i ponovo učitava dan; niz ga preuzima kad stigne.
        if (!p || failed) {
          s.seen = null;
          showSaving();
          if (preview) ctl.message(failText(failure));
          return;
        }
        supersede(p);
        // Detalji dok je raspored zaključan su na ekranu tek kad crtanje preuzme odgovor (useDay ga je postavio kao dan).
        if (!screen) s.seen = null;
        showSaved();
      });
  };

  /** Raspored je zaključan (preklapanja), a dan još nije upisan: blok pregleda (negativan id) u potvrđenom stanju. */
  const lockedPreview = (id: ItemId | undefined): Block | null =>
    s.overlaps.length > 0 && !!s.base && !s.base.initialized ? (s.base.blocks.find((b) => b.id === id) ?? null) : null;

  onCommitRef.current = (e: CommitEvent) => {
    const id = e.rateId;
    if (e.kind === 'rate' && id != null) {
      const c = e.items.find((x) => x.id === id);
      if (c?.kind === 'block') {
        const screen = { status: c.status, actualMin: c.actualMin };
        if (known(id)) {
          sendPatch(id, { status: c.status }, screen, null);
          return;
        }
        const pv = lockedPreview(id);
        if (pv) {
          sendPatch(id, { status: c.status }, screen, pv);
          return;
        }
      }
    }
    // Zaključan raspored se nikad ne šalje ceo (to bi sačuvalo raspored "Popravi" bez potvrde) — samo kroz "Popravi".
    if (s.overlaps.length > 0) return;
    schedule();
  };

  /** Dok je raspored zaključan (preklapanja): polja bloka (naziv, detalji) idu pojedinačno (PATCH). */
  onPatchRef.current = (id: ItemId, f: BlockFields) => {
    if (known(id)) {
      sendPatch(id, f, null, null);
      return;
    }
    const pv = lockedPreview(id);
    if (pv) sendPatch(id, f, null, pv);
    else ctl.message(o.t('blocks.msg.saveFailed'));
  };

  // ---- Stanje sa servera → niz (u toku crtanja, da BlockStack odmah crta pravi dan) ----
  const day = o.day;
  if (day && day.date === o.date) {
    if (s.date !== o.date) {
      // Drugi dan: nesačuvan raspored prethodnog dana ide odmah (posle crtanja), pa niz kreće ispočetka.
      if (s.dirty) {
        const snap = snapshot();
        window.clearTimeout(s.timer);
        s.timer = 0;
        s.dirty = false;
        queueMicrotask(() => sendPut(snap));
      }
      s.date = o.date;
      s.base = null;
      s.seen = null;
      s.frame = null;
      s.overlaps = [];
      ctl.resetForDay();
      window.clearTimeout(s.savedTimer);
      ctl.saveState = 'idle';
    }
    if (s.dayStart !== o.dayStart) {
      s.dayStart = o.dayStart;
      s.seen = null;
    }
    if (s.seen !== day && !s.older.has(day) && !s.dirty && s.inflight === 0 && !ctl.isBusy()) adopt(day, true);
  }

  // Ponovno crtanje stranice kad se niz promeni (Pregled) ili kad se završi gest / zatvori sheet (tada se preuzima
  // stanje sa servera koje je čekalo). Posle preuzimanja, da prvo čitanje bude već novo stanje.
  useSyncExternalStore(ctl.subscribe, () => ctl.items);
  useSyncExternalStore(ctl.subscribe, () => ctl.isBusy());

  // Sakrivanje stranice i napuštanje ekrana: pošalji odmah.
  useEffect(() => {
    s.disposed = false;
    const flush = () => {
      if (s.dirty) sendPut();
    };
    const onVis = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pagehide', flush);
      s.disposed = true;
      flush();
      window.clearTimeout(s.savedTimer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => ctl.dispose(), [ctl]);

  const frame = s.frame ?? { start: o.dayStart, end: o.dayStart + 1440 };
  return {
    ctl,
    /** Blokovi kako su na ekranu (Pregled, prazan dan). */
    blocks: stackBlocks(ctl.items, frame, o.date),
    overlaps: s.overlaps,
    /** "Popravi": raspored bez preklapanja (kasniji blok iza ranijeg) postaje raspored dana. */
    fixOverlaps: () => {
      s.overlaps = [];
      ctl.cfg = { ...ctl.cfg, locked: false };
      ctl.commitAll();
    },
    /** Pošalji nesačuvan raspored odmah (pre primene šablona). */
    flush: () => {
      if (s.dirty) sendPut();
    },
  };
}
