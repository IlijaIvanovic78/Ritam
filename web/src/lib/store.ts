// Globalno stanje rasporeda (kategorije, šabloni, podešavanja). App ga učita
// posle prijave i stranice se renderuju tek kada je učitano, pa
// useScheduleData() uvek vraća podatke.

import { useMemo, useSyncExternalStore } from 'react';
import type { Category, SchedulePayload, Settings } from '../../../shared/types.ts';
import { api, errorMessage, isCachedPayload } from '../api.ts';
import { resetAccountLang, syncAccountLang, t, tIn, useLang } from '../i18n/index.ts';
import { storeOfflineCopy } from './pwa.ts';

interface ScheduleState {
  data: SchedulePayload | null;
  loading: boolean;
  error: string | null;
}

let state: ScheduleState = { data: null, loading: false, error: null };
const listeners = new Set<() => void>();
/**
 * Raste pri svakom load/refresh/set/clear: odgovor zastarelog učitavanja (npr. posle odjave, ili
 * GET poslat pre izmene koja je u međuvremenu potvrđena) se odbacuje.
 */
let generation = 0;
/** Kad je poslednji put stigao raspored sa servera (učitavanje ili odgovor izmene). */
let loadedAt = 0;

function setState(p: Partial<ScheduleState>) {
  state = { ...state, ...p };
  // Jezik naloga (podešavanja) ima prednost posle prijave i prati promenu sa drugog uređaja (i18n/index.ts).
  if (p.data) syncAccountLang(p.data.settings?.lang);
  listeners.forEach((l) => l());
}

/** Isti sadržaj kao trenutni — zadrži stari objekat (bez nepotrebnog renderovanja i brisanja keša). */
const sameData = (a: SchedulePayload | null, b: SchedulePayload) => a != null && JSON.stringify(a) === JSON.stringify(b);

export const scheduleStore = {
  get: () => state,
  subscribe(l: () => void) {
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  },
  /** Koliko je ms prošlo od poslednjeg rasporeda sa servera. */
  age: () => Date.now() - loadedAt,
  /** Zameni podatke odgovorom servera posle mutacije (i kopiju za rad bez mreže). */
  set(data: SchedulePayload) {
    generation += 1;
    loadedAt = Date.now();
    setState({ data, error: null, loading: false });
    storeOfflineCopy(['/api/schedule'], data);
  },
  async load() {
    const my = ++generation;
    setState({ loading: true });
    try {
      const data = await api.schedule();
      if (my !== generation) return;
      const cached = isCachedPayload(data);
      if (!cached) loadedAt = Date.now();
      // Kopija iz keša service worker-a (server nije dostupan) je starija od onoga što već imamo.
      if ((cached && state.data) || sameData(state.data, data)) setState({ loading: false, error: null });
      else setState({ data, error: null, loading: false });
    } catch (e) {
      if (my !== generation) return;
      setState({ error: errorMessage(e), loading: false });
    }
  },
  /**
   * Tiho osvežavanje u pozadini (drugi uređaj je možda menjao raspored): bez indikatora
   * učitavanja i bez greške; stanje se menja samo ako je server vratio nešto drugo.
   */
  async refresh() {
    if (state.loading) return;
    if (!state.data) return scheduleStore.load();
    const my = ++generation;
    try {
      const data = await api.schedule();
      if (my !== generation || isCachedPayload(data)) return;
      loadedAt = Date.now();
      if (!sameData(state.data, data)) setState({ data, error: null });
    } catch {
      // nema servera — pokušaće se sledeći put
    }
  },
  clear() {
    generation += 1;
    // Sledeća prijava ponovo primenjuje jezik naloga.
    resetAccountLang();
    setState({ data: null, loading: false, error: null });
  },
};

export function useScheduleState(): ScheduleState {
  return useSyncExternalStore(scheduleStore.subscribe, scheduleStore.get);
}

/** Podaci rasporeda. Sme da se koristi samo unutar stranica (App garantuje da su učitani). */
export function useScheduleData(): SchedulePayload {
  const { data } = useScheduleState();
  if (!data) throw new Error('Raspored nije učitan.');
  return data;
}

export function useSettings(): Settings {
  return useScheduleData().settings;
}

/** Kategorije za izbor (bez obrisanih) kao mapa id → kategorija — za šablone i izbor. */
export function useCategoryMap(): Map<number, Category> {
  const { categories } = useScheduleData();
  return useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);
}

/**
 * Sve kategorije, i obrisane: sačuvani blokovi i zadaci ih zadržavaju, pa se za prikaz i računanje
 * ispunjenosti (kao na serveru) koriste i one. Obrisana se prikazuje sa oznakom "(obrisana)" — nova
 * kategorija može imati isti naziv, pa se inače ne bi razlikovale. Kopija iz keša od starije
 * verzije servera nema `archivedCategories`.
 */
export function useAllCategories(): Category[] {
  const { categories, archivedCategories } = useScheduleData();
  const lang = useLang();
  return useMemo(
    () => [
      ...categories,
      ...(archivedCategories ?? []).map((c) => ({ ...c, name: tIn(lang, 'common.deletedCategory', { name: c.name }) })),
    ],
    [categories, archivedCategories, lang],
  );
}

/** Sve kategorije (i obrisane) kao mapa id → kategorija — za prikaz sačuvanih dana i zadataka. */
export function useAllCategoryMap(): Map<number, Category> {
  const all = useAllCategories();
  return useMemo(() => new Map(all.map((c) => [c.id, c])), [all]);
}

/** Boja kategorije ili neutralna siva. */
export function categoryColor(map: Map<number, Category>, id: number | null): string {
  return (id != null && map.get(id)?.color) || '#9a9890';
}

/** Naziv kategorije ili "Bez kategorije" (na trenutnom jeziku). */
export function categoryName(map: Map<number, Category>, id: number | null): string {
  return (id != null && map.get(id)?.name) || t('common.noCategory');
}
