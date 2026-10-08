// Tipizovan klijent za API. Svaka mutacija dana vraća ceo DayPayload, svaka
// mutacija rasporeda ceo SchedulePayload — klijent samo zameni stanje.

import type {
  AuthState,
  BlockInput,
  BlockPatch,
  CategoryInput,
  DayPatch,
  DayPayload,
  JournalEntry,
  SchedulePayload,
  ScheduleResetInput,
  Settings,
  StatsPayload,
  Task,
  TaskPatch,
  TemplateBlockInput,
  WeekdayMap,
} from '../../shared/types.ts';

export class ApiError extends Error {
  status: number;
  /** Telo odgovora sa greškom (npr. trenutna beleška uz 409). */
  data: unknown;
  constructor(status: number, message: string, data: unknown = null) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

/** Poruka za korisnika iz bilo koje greške. */
export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error && e.message) return e.message;
  return 'Nešto nije u redu. Pokušaj ponovo.';
}

/**
 * Rok za odgovor. Zahtev koji visi (polu-otvorena veza, slab signal) inače bi zauvek držao
 * red zahteva dana (useDay) i indikator "Čuva se…". 0 = bez roka (izvoz/uvoz cele baze).
 */
const TIMEOUT_GET_MS = 12_000;
const TIMEOUT_WRITE_MS = 20_000;
/** Provera prijave pri pokretanju: kratko, da slaba veza ne drži splash (raspored stiže iz keša). */
const TIMEOUT_ME_MS = 4_000;

// ---- Odgovori iz keša service worker-a (header X-Ritam-Cached, vidi public/sw.js) ----

const cachedPayloads = new WeakSet<object>();

/** Podaci su kopija iz keša service worker-a (server nije odgovorio) — mogu biti zastareli. */
export function isCachedPayload(x: unknown): boolean {
  return typeof x === 'object' && x !== null && cachedPayloads.has(x);
}

/**
 * "Server nije dostupan": true čim stigne keširan odgovor, false tek kad server stvarno odgovori.
 * Greška mreže i 502–504 (proksi bez servera) ne menjaju stanje.
 */
let serverStale = false;
const staleListeners = new Set<() => void>();

function setServerStale(v: boolean) {
  if (serverStale === v) return;
  serverStale = v;
  staleListeners.forEach((l) => l());
}

export const serverStaleStore = {
  get: () => serverStale,
  subscribe(l: () => void) {
    staleListeners.add(l);
    return () => {
      staleListeners.delete(l);
    };
  },
};

const isGatewayStatus = (s: number) => s === 502 || s === 503 || s === 504;

async function request<T>(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<T> {
  const headers: Record<string, string> = { 'X-Ritam': '1' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const payload = body !== undefined ? JSON.stringify(body) : undefined;
  const limit = timeoutMs ?? (method === 'GET' ? TIMEOUT_GET_MS : TIMEOUT_WRITE_MS);
  const ctrl = limit > 0 ? new AbortController() : null;
  const timer = ctrl ? window.setTimeout(() => ctrl.abort(), limit) : undefined;
  const networkError = () =>
    new ApiError(0, ctrl?.signal.aborted ? 'Server ne odgovara. Pokušaj ponovo.' : 'Nema konekcije sa serverom.');

  try {
    let res: Response;
    try {
      res = await fetch(path, {
        method,
        credentials: 'same-origin',
        headers,
        body: payload,
        signal: ctrl?.signal,
        // Mala izmena (npr. beleška sačuvana pri zatvaranju taba, `pagehide`) mora da stigne
        // do servera i kad se stranica gasi. keepalive ima limit od 64 KB, pa samo za mala tela.
        keepalive: method !== 'GET' && payload !== undefined && payload.length <= 16_000,
      });
    } catch {
      throw networkError();
    }
    const cached = res.headers.get('X-Ritam-Cached') === '1';
    if (cached) setServerStale(true);
    else if (!isGatewayStatus(res.status)) setServerStale(false);
    if (res.status === 401 && !path.startsWith('/api/auth/')) {
      window.dispatchEvent(new Event('ritam:unauthorized'));
    }
    let text: string;
    try {
      text = await res.text();
    } catch {
      throw networkError();
    }
    const data = parseResponse<T>(res, text);
    if (cached && typeof data === 'object' && data !== null) cachedPayloads.add(data);
    return data;
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
  }
}

function parseResponse<T>(res: Response, text: string): T {
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const msg = (data as { error?: string } | null)?.error;
    const fallback = isGatewayStatus(res.status)
      ? 'Server nije dostupan. Pokušaj ponovo.'
      : `Greška na serveru (${res.status}).`;
    throw new ApiError(res.status, msg || fallback, data);
  }
  return data as T;
}

const NO_TIMEOUT = 0;
const get = <T>(path: string) => request<T>('GET', path);
const post = <T>(path: string, body: unknown = {}) => request<T>('POST', path, body);
const patch = <T>(path: string, body: unknown) => request<T>('PATCH', path, body);
const put = <T>(path: string, body: unknown) => request<T>('PUT', path, body);
const del = <T>(path: string) => request<T>('DELETE', path);

function qs(params: Record<string, string | number | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export const api = {
  // Auth
  /** build = glavni JS fajl build-a koji server servira (ako ga server javlja). */
  health: () => get<{ ok: boolean; build?: string }>('/api/health'),
  me: () => request<AuthState>('GET', '/api/auth/me', undefined, TIMEOUT_ME_MS),
  login: (password: string) => post<AuthState>('/api/auth/login', { password }),
  logout: () => post<AuthState>('/api/auth/logout'),

  // Dan
  /** ensure = true: ako dan nije inicijalizovan, server ga pravi iz šablona (koristi za danas i prošlost). */
  day: (date: string, ensure: boolean) => get<DayPayload>(`/api/days/${date}${qs({ ensure: ensure ? 1 : undefined })}`),
  /** (Re)inicijalizuj dan iz šablona. reset = true briše postojeće blokove. templateId = drugi šablon. */
  initDay: (date: string, opts: { reset?: boolean; templateId?: number | null } = {}) =>
    post<DayPayload>(`/api/days/${date}/init`, opts),
  /**
   * baseNote = beleška sa servera nad kojom je `note` pisana. Ako je beleška na serveru u međuvremenu
   * postala nešto treće (drugi uređaj), server odbija izmenu sa 409 umesto da je pregazi.
   */
  patchDay: (date: string, p: DayPatch) => patch<DayPayload>(`/api/days/${date}`, p),

  // Blokovi (server automatski inicijalizuje dan ako treba)
  addBlock: (date: string, input: BlockInput) => post<DayPayload>(`/api/days/${date}/blocks`, input),
  patchBlock: (id: number, p: BlockPatch) => patch<DayPayload>(`/api/blocks/${id}`, p),
  deleteBlock: (id: number) => del<DayPayload>(`/api/blocks/${id}`),
  splitBlock: (id: number, at: number) => post<DayPayload>(`/api/blocks/${id}/split`, { at }),
  /** Zameni naslov i kategoriju dva bloka istog dana (vreme, status i beleška ostaju na mestu). */
  swapBlocks: (id: number, withId: number) => post<DayPayload>(`/api/blocks/${id}/swap`, { with: withId }),

  // Zadaci — vraćaju DayPayload dana kome je zadatak pripadao PRE izmene
  addTask: (date: string, input: { title: string; categoryId?: number | null }) =>
    post<DayPayload>('/api/tasks', { date, ...input }),
  patchTask: (id: number, p: TaskPatch) => patch<DayPayload>(`/api/tasks/${id}`, p),
  deleteTask: (id: number) => del<DayPayload>(`/api/tasks/${id}`),
  /** Prebaci sve nezavršene zadatke sa datumom < to na `to`. */
  carryTasks: (to: string) => post<DayPayload>('/api/tasks/carry', { to }),
  doneTasks: (from: string, to: string) => get<Task[]>(`/api/tasks/done${qs({ from, to })}`),

  // Statistika i dnevnik
  /**
   * today = logičko danas klijenta. Kad je `to` pre njega, period je završen i poslednji dan
   * prekida niz kao svaki drugi; bez njega server `to` smatra danom koji još traje.
   */
  stats: (from: string, to: string, today?: string) =>
    get<StatsPayload>(`/api/stats${qs({ from, to, today })}`),
  journal: (opts: { before?: string; q?: string; limit?: number } = {}) =>
    get<JournalEntry[]>(`/api/journal${qs(opts)}`),

  // Raspored
  schedule: () => get<SchedulePayload>('/api/schedule'),
  addCategory: (input: CategoryInput) => post<SchedulePayload>('/api/categories', input),
  patchCategory: (id: number, p: Partial<CategoryInput> & { sort?: number }) =>
    patch<SchedulePayload>(`/api/categories/${id}`, p),
  deleteCategory: (id: number) => del<SchedulePayload>(`/api/categories/${id}`),
  addTemplate: (input: { name: string; copyFrom?: number | null }) => post<SchedulePayload>('/api/templates', input),
  patchTemplate: (id: number, p: { name?: string; sort?: number }) => patch<SchedulePayload>(`/api/templates/${id}`, p),
  deleteTemplate: (id: number) => del<SchedulePayload>(`/api/templates/${id}`),
  putTemplateBlocks: (id: number, blocks: TemplateBlockInput[]) =>
    put<SchedulePayload>(`/api/templates/${id}/blocks`, { blocks }),
  /** Menjaju se samo poslati dani (server ostale ostavlja kako jesu). */
  putWeekdays: (map: Partial<WeekdayMap>) => put<SchedulePayload>('/api/weekdays', map),
  patchSettings: (p: Partial<Settings>) => patch<SchedulePayload>('/api/settings', p),
  /**
   * "Raspored ispočetka": briše sve kategorije, šablone i dodelu šablona danima u nedelji (sačuvani dani,
   * zadaci i beleške ostaju). dayStart = true vraća i početak dana na 00:00.
   */
  resetSchedule: (input: ScheduleResetInput = {}) => post<SchedulePayload>('/api/schedule/reset', input),

  // Rezervna kopija
  exportData: () => request<unknown>('GET', '/api/export', undefined, NO_TIMEOUT),
  importData: (data: unknown) => request<{ ok: true }>('POST', '/api/import', data, NO_TIMEOUT),
};
