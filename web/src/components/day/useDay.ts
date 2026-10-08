// Podaci jednog dana: učitavanje, optimističke izmene i zaštita od zastarelih odgovora.
//
// Pravila:
// - Svi zahtevi za dane idu kroz jedan red (lib/queue.ts, jedan po jedan, zajednički za sve
//   stranice dana — i posle prelaska na drugi dan), pa odgovor kasnije poslatog zahteva uvek
//   sadrži i efekat ranijih.
// - Svako učitavanje/mutacija za dan koji je na ekranu dobija redni broj (seq). Primenjuje se
//   samo odgovor poslednje operacije; raniji odgovori su "pregaženi" (njihov efekat je već u
//   odgovoru poslednje).
// - Odgovor za datum koji više nije na ekranu se ignoriše (ali ide u keš).
// - Greška poslednje mutacije: vrati poslednje stanje koje je server potvrdio (keš u memoriji,
//   inače stanje pre prve neuspele optimističke izmene), pa tiho ponovo učitaj dan. Isto važi i
//   kad posle neuspele izmene krene osvežavanje (pa izmena nije poslednja) a server ne odgovori.
// - Kopija iz keša service worker-a (server nije dostupan) nikad ne zamenjuje ono što je već
//   na ekranu ili u kešu u memoriji — ona je starija od svake izmene posle nje.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { BlockInput, BlockPatch, BlockStatus, DayPayload, Task, TaskPatch } from '../../../../shared/types.ts';
import { api, ApiError, errorMessage, isCachedPayload, serverStaleStore } from '../../api.ts';
import { listNoteDraftDates, isNoteOpen, readNoteDraft, removeNoteDraft } from '../../lib/noteDrafts.ts';
import { storeOfflineCopy } from '../../lib/pwa.ts';
import { enqueue, queuePending } from '../../lib/queue.ts';
import { scheduleStore } from '../../lib/store.ts';
import { toast } from '../../ui/index.ts';

export interface DayState {
  date: string;
  day: DayPayload | null;
  loading: boolean;
  error: string | null;
  /** `day` je odgovor servera dobijen u ovom prikazu (ne keš u memoriji ni kopija service worker-a). */
  fresh: boolean;
}

interface MutateOpts {
  /** Izmena koja se odmah prikaže (pre odgovora servera). */
  optimistic?: (d: DayPayload) => DayPayload;
  /** Datum na koji se mutacija odnosi (podrazumevano: dan na ekranu). */
  forDate?: string;
  /** Bez toast-a pri grešci. */
  quiet?: boolean;
}

/** Rezultat čuvanja beleške: 'conflict' = beleška je u međuvremenu promenjena na drugom uređaju. */
export type NoteSaveResult = 'ok' | 'conflict' | 'error';

const NOTE_CONFLICT = 'Beleška je u međuvremenu promenjena na drugom uređaju.';

// ---- Keš odgovora servera: trenutan prikaz pri listanju dana (pa osvežavanje u pozadini) ----

const CACHE_MAX = 40;
const cache = new Map<string, DayPayload>();

function remember(p: DayPayload) {
  cache.delete(p.date);
  cache.set(p.date, p);
  if (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
}

/** Poslednje stanje dana koje je server potvrdio (ne kopija iz keša service worker-a). */
function confirmedDay(date: string): DayPayload | null {
  const p = cache.get(date);
  return p && !isCachedPayload(p) ? p : null;
}

/** Stanje na koje se vraća dan bez stanja koje je server potvrdio (vidi `rollbackRef` u useDay). */
interface Rollback {
  date: string;
  day: DayPayload;
}

function rollbackOf(r: Rollback | null, date: string): DayPayload | null {
  return r && r.date === date ? r.day : null;
}

/** Odgovor izmene ide i u keš service worker-a (inače bi kopija za rad bez mreže ostala stara). */
function keepOffline(p: DayPayload) {
  const url = `/api/days/${p.date}`;
  // Pregled (dan nije inicijalizovan) se vraća samo bez ?ensure=1 — sa njim server pravi dan.
  storeOfflineCopy(p.initialized ? [url, `${url}?ensure=1`] : [url], p);
}

// Pregled dana (neinicijalizovan dan) se pravi iz šablona: posle izmene rasporeda stari pregledi
// iz keša više ne važe (inače bi klik na blok pregleda mogao da pogodi drugi blok novog šablona).
let lastSchedule = scheduleStore.get().data;
scheduleStore.subscribe(() => {
  const data = scheduleStore.get().data;
  if (data === lastSchedule) return;
  lastSchedule = data;
  for (const [k, v] of cache) if (!v.initialized) cache.delete(k);
});

let tempTaskId = 0;

/** Dan bez inicijalizacije (pregled ili sačuvan), kroz isti red kao izmene; ide i u keš. */
export async function peekDay(date: string): Promise<DayPayload> {
  const p = await enqueue(() => api.day(date, false));
  if (isCachedPayload(p)) return confirmedDay(date) ?? p;
  remember(p);
  return p;
}

// ---- Neposlate beleške drugih dana ----

/** Provere idu jedna za drugom (više povoda odjednom: povratak u aplikaciju, mreža, drugi dan). */
let sweepChain: Promise<unknown> = Promise.resolve();

/**
 * Beleške ostale samo u localStorage-u za dane koji nisu otvoreni (čuvanje nije uspelo pa se
 * prešlo na drugi dan ili je aplikacija zatvorena). Ako je server i dalje na belešci nad kojom je
 * draft pisan, pošalji ga; ako već ima isti tekst, samo obriši draft. Vraća datume čiji draft nije
 * mogao da se reši (nema servera, ili je beleška u međuvremenu menjana — to rešava kartica tog dana).
 * `onScreen` = dan koji je na ekranu (njegov draft rešava kartica Beleške čim se dan učita).
 */
export function syncNoteDrafts(onScreen: string): Promise<string[]> {
  const run = sweepChain.then(async () => {
    const left: string[] = [];
    for (const date of listNoteDraftDates()) {
      if (date === onScreen || isNoteOpen(date) || !readNoteDraft(date)) continue;
      try {
        const p = await enqueue(() => api.day(date, false));
        if (isCachedPayload(p)) {
          left.push(date);
          continue;
        }
        remember(p);
        const draft = readNoteDraft(date);
        // Kartica tog dana se u međuvremenu otvorila — ona preuzima draft.
        if (!draft || isNoteOpen(date)) continue;
        if (p.note === draft.text) {
          removeNoteDraft(date);
          continue;
        }
        if (p.note !== draft.base) {
          left.push(date);
          continue;
        }
        const res = await enqueue(() => api.patchDay(date, { note: draft.text, baseNote: draft.base }));
        remember(res);
        keepOffline(res);
        if (readNoteDraft(date)?.text === draft.text) removeNoteDraft(date);
      } catch {
        left.push(date);
      }
    }
    return left;
  });
  sweepChain = run.catch(() => {});
  return run;
}

/** Prozor koji nije bio sakriven (laptop): pri povratku fokusa osveži ako podaci nisu skorašnji. */
const FOCUS_REFRESH_MS = 30_000;
/** Tab koji stalno stoji otvoren i fokusiran ne dobija nijedan događaj — osveži ga povremeno. */
const POLL_MS = 60_000;
/** Na ekranu je kopija iz keša (server nije odgovorio na vreme) — pokušaj ponovo češće. */
const POLL_STALE_MS = 15_000;
const POLL_CHECK_MS = 15_000;

export const isActiveStatus = (s: BlockStatus) => s === 'done' || s === 'partial';

export function useDay(date: string, ensure: boolean) {
  const [state, setState] = useState<DayState>(() => ({
    date,
    day: cache.get(date) ?? null,
    loading: true,
    error: null,
    fresh: false,
  }));
  /** Broj uspešnih učitavanja dana sa servera (uz njih se osvežava i podsetnik za juče). */
  const [syncs, setSyncs] = useState(0);
  const stateRef = useRef(state);
  const dateRef = useRef(date);
  const ensureRef = useRef(ensure);
  const seq = useRef(0);
  /** Kad je poslat poslednji zahtev za ovaj dan (svaki odgovor je ceo dan). */
  const lastSync = useRef(0);
  /**
   * Poslednje učitavanje nije dobilo odgovor servera (kopija iz keša ili greška), iako je na
   * ekranu možda i dalje svež dan — povremeno osvežavanje tada ide češće.
   */
  const lastFailed = useRef(false);
  const initRef = useRef<{ date: string; promise: Promise<DayPayload | null> } | null>(null);
  /**
   * Dan na ekranu nema stanje koje je server potvrdio (otvoren iz keša service worker-a), a
   * optimistička izmena nije uspela dok je posle nje već čekalo osvežavanje: stanje pre (prve)
   * takve izmene, na koje se vraća kad ni osvežavanje ne dobije odgovor servera.
   */
  const rollbackRef = useRef<Rollback | null>(null);

  useLayoutEffect(() => {
    dateRef.current = date;
    ensureRef.current = ensure;
  }, [date, ensure]);

  const commit = useCallback((next: DayState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  /**
   * Server nije odgovorio, a na ekranu je dan: zadrži ga, ali bez optimističkih izmena koje server
   * nije potvrdio. Zove se samo za poslednju operaciju (my === seq), kad su sve ranije izmene iz
   * reda završene — neuspela izmena čije je vraćanje preskočeno jer je posle nje krenulo
   * osvežavanje inače bi ostala na ekranu kao da je sačuvana. Dan bez stanja koje je server
   * potvrdio (otvoren iz keša) se vraća na stanje pre prve takve izmene (`rollbackRef`).
   */
  const keepConfirmed = useCallback(
    (cur: DayState) => {
      const back = confirmedDay(cur.date) ?? rollbackOf(rollbackRef.current, cur.date);
      const day = back && back !== cur.day ? back : cur.day;
      if (day === cur.day && !cur.loading) return;
      commit({ ...cur, day, loading: false, fresh: day === cur.day ? cur.fresh : false });
    },
    [commit],
  );

  /** quiet: bez toast-a pri grešci (povremeno osvežavanje u pozadini). */
  const load = useCallback(
    (d: string, en: boolean, quiet = false) => {
      const my = ++seq.current;
      lastSync.current = Date.now();
      enqueue(() => api.day(d, en)).then(
        (p) => {
          const offline = isCachedPayload(p);
          if (!offline) {
            remember(p);
            // Server je potvrdio stanje dana: od sada se vraća na njega (confirmedDay).
            if (rollbackRef.current?.date === p.date) rollbackRef.current = null;
          } else if (!cache.has(p.date)) remember(p);
          if (my !== seq.current || p.date !== dateRef.current) return;
          lastFailed.current = offline;
          const cur = stateRef.current;
          if (offline && cur.date === p.date && cur.day) {
            // Server nije dostupan: ono što je server potvrdio je novije od kopije iz keša.
            keepConfirmed(cur);
            return;
          }
          commit({ date: p.date, day: p, loading: false, error: null, fresh: !offline });
          if (!offline) setSyncs((n) => n + 1);
        },
        (e) => {
          if (my !== seq.current || d !== dateRef.current) return;
          lastFailed.current = true;
          const cur = stateRef.current;
          if (cur.date === d && cur.day) {
            // Imamo šta da prikažemo (keš / prethodno stanje) — samo javi grešku.
            keepConfirmed(cur);
            if (!quiet) toast.error(errorMessage(e));
          } else {
            commit({ date: d, day: null, loading: false, error: errorMessage(e), fresh: false });
          }
        },
      );
    },
    [commit, keepConfirmed],
  );

  // Učitavanje pri promeni datuma (ili kad dan postane "danas" pa treba ensure).
  useEffect(() => {
    const cur = stateRef.current;
    if (rollbackRef.current && rollbackRef.current.date !== date) rollbackRef.current = null;
    if (cur.date !== date) commit({ date, day: cache.get(date) ?? null, loading: true, error: null, fresh: false });
    else if (cur.error) commit({ ...cur, loading: true, error: null });
    load(date, ensure);
  }, [date, ensure, load, commit]);

  // Povratak u aplikaciju ili mreže: tiho osveži (možda je nešto menjano na drugom uređaju,
  // a prikaz je možda stigao iz keša dok server nije bio dostupan). Tab koji sve vreme stoji
  // vidljiv (laptop) se osvežava na minut, kad ništa nije u toku.
  useEffect(() => {
    const refresh = () => load(dateRef.current, ensureRef.current);
    const onVis = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    const onFocus = () => {
      if (Date.now() - lastSync.current > FOCUS_REFRESH_MS) refresh();
    };
    const poll = window.setInterval(() => {
      if (document.visibilityState !== 'visible' || !navigator.onLine || queuePending() > 0) return;
      // Češće i kad je na ekranu svež dan, a poslednji odgovor je ipak bio kopija iz keša
      // (odbijena, jer je ekran noviji) ili greška — da se primeti čim se server vrati.
      const ok = stateRef.current.fresh && !lastFailed.current && !serverStaleStore.get();
      if (Date.now() - lastSync.current >= (ok ? POLL_MS : POLL_STALE_MS)) load(dateRef.current, ensureRef.current, true);
    }, POLL_CHECK_MS);
    // Server je ponovo odgovorio (bilo koji zahtev, npr. provera iz trake "Server nije dostupan"):
    // osveži dan odmah — tako se šalje i beleška čije čuvanje nije uspelo (vidi NotesCard, syncs).
    let wasStale = serverStaleStore.get();
    const unsubscribe = serverStaleStore.subscribe(() => {
      const stale = serverStaleStore.get();
      // Odgovor samog zahteva dana (još je u redu) ne pokreće novo učitavanje.
      if (wasStale && !stale && document.visibilityState === 'visible' && queuePending() === 0) {
        load(dateRef.current, ensureRef.current, true);
      }
      wasStale = stale;
    });
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', refresh);
    return () => {
      window.clearInterval(poll);
      unsubscribe();
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('online', refresh);
    };
  }, [load]);

  const mutate = useCallback(
    async (fn: () => Promise<DayPayload>, opts: MutateOpts = {}): Promise<DayPayload | null> => {
      const forDate = opts.forDate ?? dateRef.current;
      const onScreen = forDate === dateRef.current;
      let my = -1;
      let snapshot: DayPayload | null = null;
      if (onScreen) {
        my = ++seq.current;
        lastSync.current = Date.now();
        const cur = stateRef.current;
        if (cur.date === forDate && cur.day) {
          snapshot = cur.day;
          if (opts.optimistic) commit({ ...cur, day: opts.optimistic(cur.day) });
        }
      }
      try {
        const p = await enqueue(fn);
        remember(p);
        if (rollbackRef.current?.date === p.date) rollbackRef.current = null;
        keepOffline(p);
        if (onScreen && my === seq.current) {
          if (p.date === dateRef.current) {
            lastFailed.current = false;
            commit({ date: p.date, day: p, loading: false, error: null, fresh: true });
          } else if (forDate === dateRef.current) {
            // Odgovor za drugi datum (zadatak je u međuvremenu premešten na drugom uređaju):
            // optimistička izmena na ekranu nije potvrđena — učitaj dan ponovo.
            load(forDate, ensureRef.current);
          }
        }
        return p;
      } catch (e) {
        if (onScreen && my === seq.current && forDate === dateRef.current) {
          const cur = stateRef.current;
          if (cur.date === forDate) {
            // Sve ranije izmene su već završene (red je strogo redom): poslednje potvrđeno stanje
            // ne sadrži ni ovu ni neku raniju neuspelu optimističku izmenu.
            const back =
              confirmedDay(forDate) ?? rollbackOf(rollbackRef.current, forDate) ?? (opts.optimistic ? snapshot : null);
            if (back && back !== cur.day) commit({ ...cur, day: back });
          }
          load(forDate, ensureRef.current);
        } else if (
          onScreen &&
          opts.optimistic &&
          snapshot &&
          forDate === dateRef.current &&
          !confirmedDay(forDate) &&
          !rollbackOf(rollbackRef.current, forDate)
        ) {
          // Posle ove izmene je krenula druga operacija, pa vraćanje čeka nju; bez potvrđenog stanja
          // (dan iz keša) vraća se na stanje pre ove izmene (najstarije, ako ih je neuspelo više).
          rollbackRef.current = { date: forDate, day: snapshot };
        }
        if (!opts.quiet) toast.error(errorMessage(e));
        return null;
      }
    },
    [commit, load],
  );

  const actions = useMemo(() => {
    /** Inicijalizuj dan iz šablona (pregled → sačuvani blokovi). Paralelni pozivi dele isti zahtev. */
    const ensureInit = (): Promise<DayPayload | null> => {
      const d = dateRef.current;
      const cur = stateRef.current;
      if (cur.date === d && cur.day?.initialized) return Promise.resolve(cur.day);
      if (initRef.current?.date === d) return initRef.current.promise;
      const promise = mutate(async () => {
        try {
          return await api.initDay(d);
        } catch (e) {
          // Već inicijalizovan (npr. sa drugog uređaja) — samo učitaj.
          if (e instanceof ApiError && e.status === 409) return api.day(d, true);
          throw e;
        }
      }).finally(() => {
        if (initRef.current?.promise === promise) initRef.current = null;
      });
      initRef.current = { date: d, promise };
      return promise;
    };

    return {
      reload() {
        const d = dateRef.current;
        const cur = stateRef.current;
        commit({
          date: d,
          day: cur.date === d ? cur.day : null,
          loading: true,
          error: null,
          fresh: cur.date === d && cur.fresh,
        });
        load(d, ensureRef.current);
      },

      /** Osveži dan ako poslednji odgovor nije skorašnji (pre kucanja beleške, otvaranja bloka). */
      refreshIfStale(maxAgeMs = 15_000) {
        if (Date.now() - lastSync.current <= maxAgeMs || queuePending() > 0) return;
        load(dateRef.current, ensureRef.current);
      },

      ensureInit,

      setStatus: (id: number, status: BlockStatus) =>
        mutate(() => api.patchBlock(id, { status }), {
          optimistic: (d) => ({
            ...d,
            blocks: d.blocks.map((b) =>
              b.id === id ? { ...b, status, actualMin: isActiveStatus(status) ? b.actualMin : null } : b,
            ),
          }),
        }),

      addBlock: (input: BlockInput) => {
        const d = dateRef.current;
        return mutate(() => api.addBlock(d, input));
      },
      patchBlock: (id: number, patch: BlockPatch) => mutate(() => api.patchBlock(id, patch)),
      deleteBlock: (id: number) => mutate(() => api.deleteBlock(id)),
      splitBlock: (id: number, at: number) => mutate(() => api.splitBlock(id, at)),
      /** Naslov i kategorija dva bloka menjaju mesta (npr. dve aktivnosti menjaju termine); vreme i status ostaju. */
      swapBlocks: (id: number, withId: number) =>
        mutate(() => api.swapBlocks(id, withId), {
          optimistic: (d) => {
            const a = d.blocks.find((b) => b.id === id);
            const b = d.blocks.find((x) => x.id === withId);
            if (!a || !b) return d;
            return {
              ...d,
              blocks: d.blocks.map((x) =>
                x.id === id
                  ? { ...x, title: b.title, categoryId: b.categoryId }
                  : x.id === withId
                    ? { ...x, title: a.title, categoryId: a.categoryId }
                    : x,
              ),
            };
          },
        }),

      /** undefined = šablon za dan u nedelji, null = prazan dan, broj = taj šablon. */
      applyTemplate: (templateId?: number | null) => {
        const d = dateRef.current;
        const opts = templateId === undefined ? { reset: true } : { reset: true, templateId };
        return mutate(() => api.initDay(d, opts));
      },

      addTask: (title: string) => {
        const d = dateRef.current;
        const temp: Task = {
          id: -(++tempTaskId),
          date: d,
          title,
          done: false,
          doneAt: null,
          categoryId: null,
          sort: Number.MAX_SAFE_INTEGER,
          createdAt: new Date().toISOString(),
        };
        return mutate(() => api.addTask(d, { title }), {
          optimistic: (day) => ({ ...day, tasks: [...day.tasks, temp] }),
        });
      },
      toggleTask: (id: number, done: boolean) =>
        mutate(() => api.patchTask(id, { done }), {
          optimistic: (day) => ({
            ...day,
            tasks: day.tasks.map((t) =>
              t.id === id ? { ...t, done, doneAt: done ? new Date().toISOString() : null } : t,
            ),
          }),
        }),
      patchTask: (id: number, patch: TaskPatch) => {
        // Ciljni dan u kešu više nije tačan (dobija zadatak).
        if (patch.date) cache.delete(patch.date);
        return mutate(() => api.patchTask(id, patch));
      },
      deleteTask: (id: number) => mutate(() => api.deleteTask(id)),
      carryTasks: () => {
        const d = dateRef.current;
        // Raniji dani gube nezavršene zadatke — izbaci ih iz keša.
        for (const k of [...cache.keys()]) if (k < d) cache.delete(k);
        return mutate(() => api.carryTasks(d));
      },

      /**
       * Beleška ide za datum na kom je kucana (može se sačuvati i posle prelaska na drugi dan).
       * `base()` se čita tek kad zahtev krene iz reda (posle ranijih čuvanja) i vraća belešku sa
       * servera nad kojom je tekst pisan; null = već se zna da je beleška promenjena negde drugde.
       * `onSaved()` se zove odmah po uspehu, pre sledećeg zahteva iz reda.
       */
      saveNote: async (
        d: string,
        note: string,
        base: () => string | null,
        onSaved: () => void,
      ): Promise<NoteSaveResult> => {
        let conflict = false;
        let failure: unknown = null;
        const p = await mutate(
          async () => {
            const b = base();
            if (b == null) {
              conflict = true;
              throw new ApiError(409, NOTE_CONFLICT);
            }
            try {
              const res = await api.patchDay(d, { note, baseNote: b });
              onSaved();
              return res;
            } catch (e) {
              failure = e;
              if (e instanceof ApiError && e.status === 409) conflict = true;
              throw e;
            }
          },
          { forDate: d, quiet: true },
        );
        if (p) return 'ok';
        if (conflict) return 'conflict';
        toast.error(errorMessage(failure));
        return 'error';
      },
      setRating: (rating: number | null) => {
        const d = dateRef.current;
        return mutate(() => api.patchDay(d, { rating }), { optimistic: (day) => ({ ...day, rating }) });
      },
    };
  }, [mutate, commit, load]);

  // Pre nego što efekat za novi datum stigne da se izvrši, ne prikazuj podatke starog dana.
  const view: DayState =
    state.date === date ? state : { date, day: cache.get(date) ?? null, loading: true, error: null, fresh: false };

  return { ...view, syncs, actions };
}

export type DayActions = ReturnType<typeof useDay>['actions'];
