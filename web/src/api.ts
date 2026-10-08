// Tipizovan klijent za API. Svaka mutacija dana vraća ceo DayPayload, svaka
// mutacija rasporeda ceo SchedulePayload — klijent samo zameni stanje.
//
// Nalozi: access token (JWT, kratko traje) je samo u memoriji ovog taba i ide uz svaki zahtev kao
// `Authorization: Bearer …`. Refresh token je HttpOnly kolačić (`ritam_refresh`, Path=/api/auth) koji
// deli ceo browser; `/api/auth/refresh` ga rotira i vraća nov access token. Zahtev koji dobije 401
// zbog isteklog tokena pokrene JEDNO zajedničko osvežavanje (u ovom tabu jedno, između tabova jedno
// po jedno preko `navigator.locks`) i ponovi se jednom. Odbijeno osvežavanje = odjava
// ('ritam:unauthorized'); bez mreže = rad bez servera, ne odjava. Stranica pripada jednom nalogu
// (`pageOwner`): zahtev se nikad ne šalje sa tokenom drugog naloga.

import type {
  AuthConfig,
  AuthResponse,
  AuthUser,
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
  /** Mašinski kod greške iz tela (`{ error, code }`), npr. 'bad_code', 'token_expired'. */
  code: string | null;
  constructor(status: number, message: string, data: unknown = null) {
    super(message);
    this.status = status;
    this.data = data;
    this.code = errorCode(data);
  }
}

function errorCode(data: unknown): string | null {
  const code = typeof data === 'object' && data !== null ? (data as { code?: unknown }).code : undefined;
  return typeof code === 'string' ? code : null;
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
/**
 * Osvežavanje sesije ima dug rok: prekinut zahtev koji je server ipak obradio ostavio bi u browseru
 * već zamenjen (opozvan) refresh token, pa bi sledeće osvežavanje bilo odbijeno.
 */
const TIMEOUT_REFRESH_MS = 20_000;
/** Access token se osvežava unapred kad mu je ostalo manje od ovoga (najviše četvrtina trajanja tokena). */
const REFRESH_AHEAD_MS = 60_000;
/** Token kome je ostalo bar ovoliko se koristi odmah, i dok osvežavanje traje u pozadini. */
const TOKEN_USABLE_MS = 10_000;
/** Koliko zahtev najduže čeka osvežavanje koje je u toku (posle toga ide bez novog tokena). */
const REFRESH_WAIT_MS = 4_000;
/** Koliko se najduže čeka da drugi tab završi svoje osvežavanje (`navigator.locks`). */
const LOCK_WAIT_MS = 25_000;
/**
 * Posle 401 'refresh_race' (drugi tab je upravo zamenio token; nov stiže u zajednički kolačić) novi
 * pokušaji posle nasumične pauze (tabovi koji su izgubili trku ne pokušavaju ponovo u isti mah), dok
 * ne prođe RACE_RETRY_TOTAL_MS — znatno kraće od tolerancije servera (REFRESH_RACE_GRACE_SEC, 30 s).
 */
const RACE_RETRY_MIN_MS = 300;
const RACE_RETRY_MAX_MS = 1_200;
const RACE_RETRY_TOTAL_MS = 8_000;

export const UNAUTHORIZED_EVENT = 'ritam:unauthorized';
/** Osvežena sesija pripada drugom korisniku (prijava u drugom tabu) — App učitava stranicu ponovo. */
export const USER_CHANGED_EVENT = 'ritam:user-changed';
/** `code` greške zahteva koji nije poslat jer kolačić/sesija sada pripada drugom nalogu. */
const USER_CHANGED_CODE = 'user_changed';

const delay = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

/**
 * Stranica se gasi (`pagehide` stiže pre nego što `visibilityState` postane 'hidden' pri odlasku ili
 * ponovnom učitavanju u istom tabu). Registruje se pri učitavanju modula — pre slušalaca komponenti
 * (čuvanje beleške), pa je postavljen kad one šalju.
 */
let leaving = false;
window.addEventListener(
  'pagehide',
  () => {
    leaving = true;
  },
  { capture: true },
);
window.addEventListener('pageshow', () => {
  leaving = false;
});

// ---- Sesija ----

/** Access token (JWT) — samo u memoriji ovog taba, nikad u storage-u. */
let accessToken: string | null = null;
/** Kad access token ističe, po satu ovog uređaja (vreme prijema + expiresIn). */
let accessExpiresAt = 0;
/** Koliko pre isteka se token osvežava unapred (kraće za token kratkog trajanja). */
let refreshAheadMs = REFRESH_AHEAD_MS;
/** Prijavljen korisnik; u radu bez servera poslednji korisnik ovog uređaja (vidi setOfflineUser). */
let sessionUser: AuthUser | null = null;
/** sessionUser još nije potvrdio server (pokretanje bez mreže, podaci iz keša). */
let sessionOffline = false;
/** Server je odbio osvežavanje (odjava, istekla ili opozvana sesija): do nove prijave nema pokušaja. */
let sessionEnded = false;
/**
 * Nalog čiji su podaci učitani u ovu stranicu (raspored, dani, draftovi beleški): prvi nalog sesije u
 * ovom tabu. Menja se samo ponovnim učitavanjem stranice. Dok je u tabu sesija drugog naloga (prijava
 * drugog naloga posle odjave, pre ponovnog učitavanja), nijedan zahtev se ne šalje.
 */
let pageOwner: AuthUser | null = null;
/** Osvežavanje je vratilo drugi nalog (vidi applySession): stranica se učitava ponovo, ništa se ne šalje. */
let userChanged = false;

export interface SessionState {
  user: AuthUser | null;
  /** Korisnik je poznat sa ovog uređaja, ali server još nije potvrdio sesiju (rad bez mreže). */
  offline: boolean;
}

let sessionSnapshot: SessionState = { user: null, offline: false };
const sessionListeners = new Set<() => void>();

function notifySession() {
  if (sessionSnapshot.user === sessionUser && sessionSnapshot.offline === sessionOffline) return;
  sessionSnapshot = { user: sessionUser, offline: sessionOffline };
  sessionListeners.forEach((l) => l());
}

export const sessionStore = {
  get: () => sessionSnapshot,
  subscribe(l: () => void) {
    sessionListeners.add(l);
    return () => {
      sessionListeners.delete(l);
    };
  },
};

/** Korisnik čiji su podaci na ekranu (i lokalni draftovi beleški); null = niko nije prijavljen. */
export function sessionUserId(): number | null {
  return sessionUser?.id ?? null;
}

/** Nalog čija sesija u ovom tabu i dalje traje (i rad bez servera); null posle odjave ili odbijene sesije. */
export function activeUserId(): number | null {
  return sessionEnded ? null : (sessionUser?.id ?? null);
}

/**
 * Isti nalog: isti id i isti email. Email se ne menja, pa isti id sa drugim email-om znači drugu bazu
 * (npr. nov volumen na istoj adresi) — to je drugi nalog.
 */
export function sameUser(a: AuthUser | null, b: AuthUser | null): boolean {
  return a !== null && b !== null && a.id === b.id && a.email === b.email;
}

/** Nalog čiji su podaci učitani u ovu stranicu (vidi `pageOwner`); null = još nijedan. */
export function pageOwnerUser(): AuthUser | null {
  return pageOwner;
}

/** Sesija u tabu pripada drugom nalogu nego podaci na stranici: ništa se ne šalje do ponovnog učitavanja. */
function ownerMismatch(): boolean {
  return userChanged || (pageOwner !== null && sessionUser !== null && !sameUser(sessionUser, pageOwner));
}

function userChangedError(): ApiError {
  return new ApiError(401, 'Nisi prijavljen.', { error: 'Nisi prijavljen.', code: USER_CHANGED_CODE });
}

/**
 * Nova sesija u ovom tabu. `fromRefresh`: osvežavanje preko kolačića — kolačić je zajednički za ceo
 * browser, pa može da pripada nalogu prijavljenom u drugom tabu. Token tog naloga se tada NE uzima
 * (nijedan zahtev ove stranice ne sme da ode u tuđi nalog): sesija u tabu se završava, `sessionUser`
 * ostaje prethodni (njegovi draftovi ostaju pod njegovim ključem), App učitava stranicu ponovo, a nova
 * stranica obnovi sesiju novog naloga iz kolačića. Baca ApiError 401 'user_changed'.
 */
function applySession(r: AuthResponse, fromRefresh: boolean) {
  if (fromRefresh && pageOwner !== null && !sameUser(pageOwner, r.user)) {
    userChanged = true;
    accessToken = null;
    accessExpiresAt = 0;
    sessionOffline = false;
    sessionEnded = true;
    notifySession();
    window.dispatchEvent(new Event(USER_CHANGED_EVENT));
    throw userChangedError();
  }
  const prev = sessionUser;
  accessToken = r.accessToken;
  const ttlMs = Math.max(0, Number(r.expiresIn) || 0) * 1000;
  accessExpiresAt = Date.now() + ttlMs;
  refreshAheadMs = Math.min(REFRESH_AHEAD_MS, ttlMs / 4);
  sessionUser = sameUser(prev, r.user) ? prev : { id: r.user.id, email: r.user.email };
  if (pageOwner === null) pageOwner = sessionUser;
  sessionOffline = false;
  sessionEnded = false;
  notifySession();
}

/**
 * Pokretanje bez servera: prikazuju se keširani podaci poslednjeg korisnika ovog uređaja. Zahtevi
 * idu bez tokena; prvi koji stigne do servera pokrene osvežavanje sesije (kolačić).
 */
export function setOfflineUser(u: AuthUser): void {
  if (accessToken) return;
  sessionUser = { id: u.id, email: u.email };
  if (pageOwner === null) pageOwner = sessionUser;
  sessionOffline = true;
  sessionEnded = false;
  notifySession();
}

/** Zaboravi sesiju u ovom tabu (odjava, odbijeno osvežavanje, odjava u drugom tabu). */
export function endSession(): void {
  accessToken = null;
  accessExpiresAt = 0;
  sessionUser = null;
  sessionOffline = false;
  sessionEnded = true;
  notifySession();
}

// ---- Odgovori iz keša service worker-a (header X-Ritam-Cached, vidi public/sw.js) ----

const cachedPayloads = new WeakSet<object>();

/** Podaci su kopija iz keša service worker-a (server nije odgovorio) — mogu biti zastareli. */
export function isCachedPayload(x: unknown): boolean {
  return typeof x === 'object' && x !== null && cachedPayloads.has(x);
}

/** Čiji su podaci: korisnik za koga je poslat zahtev koji ih je vratio. */
const payloadOwners = new WeakMap<object, number>();

/** Nalog kome pripada odgovor servera (za kopiju u kešu service worker-a); null = nepoznato. */
export function payloadUserId(x: unknown): number | null {
  return typeof x === 'object' && x !== null ? (payloadOwners.get(x) ?? null) : null;
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

// ---- Slanje ----

interface Sent {
  res: Response;
  data: unknown;
  cached: boolean;
  /** Korisnik u čije ime je zahtev poslat (token / X-Ritam-User). */
  user: number | null;
}

/**
 * Jedan HTTP zahtev. Greška mreže / istek roka → ApiError sa statusom 0. `uid` = nalog u čije ime
 * se šalje (header X-Ritam-User, uz svaki zahtev sa tokenom): service worker po njemu čuva kopije GET
 * odgovora i nikad ne vraća kopiju drugog naloga.
 */
async function send(
  method: string,
  path: string,
  payload: string | undefined,
  token: string | null,
  uid: number | null,
  timeoutMs: number,
): Promise<Sent> {
  const headers: Record<string, string> = { 'X-Ritam': '1' };
  if (payload !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  if (uid != null) headers['X-Ritam-User'] = String(uid);
  const ctrl = timeoutMs > 0 ? new AbortController() : null;
  const timer = ctrl ? window.setTimeout(() => ctrl.abort(), timeoutMs) : undefined;
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
    let text: string;
    try {
      text = await res.text();
    } catch {
      throw networkError();
    }
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = null;
      }
    }
    return { res, data, cached, user: uid };
  } finally {
    if (timer !== undefined) window.clearTimeout(timer);
  }
}

function toApiError(res: Response, data: unknown): ApiError {
  const msg = (data as { error?: unknown } | null)?.error;
  const fallback = isGatewayStatus(res.status)
    ? 'Server nije dostupan. Pokušaj ponovo.'
    : `Greška na serveru (${res.status}).`;
  return new ApiError(res.status, typeof msg === 'string' && msg ? msg : fallback, data);
}

function finish<T>({ res, data, cached, user }: Sent): T {
  if (!res.ok) throw toApiError(res, data);
  if (typeof data === 'object' && data !== null) {
    if (cached) cachedPayloads.add(data);
    if (user != null) payloadOwners.set(data, user);
  }
  return data as T;
}

/** Javne rute naloga (bez access tokena; refresh/logout rade sa kolačićem). */
const PUBLIC_PATH = /^\/api\/(health|auth\/(config|login|register|refresh|logout))(\/|\?|$)/;

/** 401 zbog access tokena (istekao, nevažeći ili ga nema) — pomaže osvežavanje sesije. */
function isTokenProblem(data: unknown): boolean {
  const code = errorCode(data);
  return code === null || code === 'unauthorized' || code === 'token_expired';
}

/** Pre zahteva: osveži token koji uskoro ističe, ili sačekaj osvežavanje koje je u toku. */
async function beforeAuthedRequest(): Promise<void> {
  if (sessionEnded) return;
  const left = accessExpiresAt - Date.now();
  // Stranica koja se gasi (beleška pri zatvaranju taba, keepalive) ili je sakrivena šalje odmah dok
  // token još važi — osvežavanje koje bi se čekalo dok se dokument gasi ne bi nikad poslalo zahtev.
  if ((leaving || document.visibilityState === 'hidden') && accessToken && left > 1_000) return;
  if (accessToken && left < refreshAheadMs && !refreshing) void refreshSession().catch(() => {});
  if (refreshing && (!accessToken || accessExpiresAt - Date.now() < Math.min(TOKEN_USABLE_MS, refreshAheadMs))) {
    await Promise.race([refreshing.catch(() => {}), delay(REFRESH_WAIT_MS)]);
  }
}

/**
 * Posle 401 zbog tokena: true = postoji nov token za istog korisnika (ponovi zahtev). Odbijeno
 * osvežavanje → false (odjava je već javljena). Bez mreže baca grešku mreže — to nije odjava.
 */
async function renewAfter401(sent: string | null): Promise<boolean> {
  if (sessionEnded) return false;
  const before = sessionUser?.id ?? null;
  // Drugi zahtev je u međuvremenu već dobio nov token (osvežavanje uvek ostaje u istom nalogu, applySession).
  if (accessToken && accessToken !== sent && accessExpiresAt - Date.now() > TOKEN_USABLE_MS) return true;
  try {
    const r = await refreshSession();
    return before === null || r.user.id === before;
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return false;
    throw e;
  }
}

async function request<T>(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<T> {
  const payload = body !== undefined ? JSON.stringify(body) : undefined;
  const limit = timeoutMs ?? (method === 'GET' ? TIMEOUT_GET_MS : TIMEOUT_WRITE_MS);
  if (PUBLIC_PATH.test(path)) return finish<T>(await send(method, path, payload, null, null, limit));
  await beforeAuthedRequest();
  // Podaci ove stranice pripadaju jednom nalogu: sa sesijom drugog naloga u tabu zahtev ne ide nikud.
  if (ownerMismatch()) throw userChangedError();
  const token = accessToken;
  let r = await send(method, path, payload, token, sessionUser?.id ?? null, limit);
  if (r.res.status === 401 && isTokenProblem(r.data) && (await renewAfter401(token))) {
    if (ownerMismatch()) throw userChangedError();
    r = await send(method, path, payload, accessToken, sessionUser?.id ?? null, limit);
  }
  return finish<T>(r);
}

// ---- Osvežavanje sesije (refresh token u kolačiću) ----

let refreshing: Promise<AuthResponse> | null = null;

/**
 * Nov access token preko kolačića. Jedno osvežavanje po tabu (svi zahtevi čekaju isto), a između
 * tabova jedno po jedno (`navigator.locks`): kolačić je zajednički, pa tab koji dođe na red šalje
 * već rotiran token. 401 → sesija je završena ('ritam:unauthorized'); greška mreže → ApiError 0.
 */
export function refreshSession(): Promise<AuthResponse> {
  if (!refreshing) {
    const p: Promise<AuthResponse> = withRefreshLock(postRefresh).finally(() => {
      if (refreshing === p) refreshing = null;
    });
    refreshing = p;
  }
  return refreshing;
}

async function withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = 'locks' in navigator ? navigator.locks : undefined;
  // Bez Web Locks (http na mrežnoj adresi, stari browser): tabovi osvežavaju istovremeno; onaj koji
  // izgubi trku dobija 'refresh_race' i pokušava ponovo (postRefresh) sa tokenom koji je pobednik
  // u međuvremenu upisao u zajednički kolačić.
  if (!locks || typeof locks.request !== 'function') return fn();
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), LOCK_WAIT_MS);
  let ran = false;
  try {
    return await locks.request<Promise<T>>('ritam-refresh', { signal: ctrl.signal }, () => {
      ran = true;
      window.clearTimeout(timer);
      return fn();
    });
  } catch (e) {
    if (ran || e instanceof ApiError) throw e;
    if (ctrl.signal.aborted) throw new ApiError(0, 'Server ne odgovara. Pokušaj ponovo.');
    // Web Locks nisu upotrebljivi (npr. dokument bez pristupa) — osveži bez njih.
    return fn();
  } finally {
    window.clearTimeout(timer);
  }
}

async function postRefresh(): Promise<AuthResponse> {
  const started = Date.now();
  for (;;) {
    const r = await send('POST', '/api/auth/refresh', '{}', null, null, TIMEOUT_REFRESH_MS);
    if (r.res.ok) {
      const resp = r.data as AuthResponse;
      applySession(resp, true);
      return resp;
    }
    if (r.res.status === 401) {
      // Drugi tab (ili ranija stranica ovog taba) je upravo zamenio refresh token: sesija važi, a nov
      // token stiže u kolačić. To nikad nije odjava — samo ovaj zahtev ne uspeva ako trka ne prestane.
      if (errorCode(r.data) === 'refresh_race') {
        if (Date.now() - started >= RACE_RETRY_TOTAL_MS) throw new ApiError(0, 'Server ne odgovara. Pokušaj ponovo.');
        await delay(RACE_RETRY_MIN_MS + Math.random() * (RACE_RETRY_MAX_MS - RACE_RETRY_MIN_MS));
        continue;
      }
      endSession();
      window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    }
    throw toApiError(r.res, r.data);
  }
}

// ---- Putanje ----

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

/** Prijava/registracija/promena lozinke: nova sesija u ovom tabu (i nov kolačić). */
async function startSession(path: string, body: unknown): Promise<AuthResponse> {
  const r = await post<AuthResponse>(path, body);
  applySession(r, false);
  return r;
}

export const api = {
  /** build = glavni JS fajl build-a koji server servira (ako ga server javlja). */
  health: () => get<{ ok: boolean; build?: string }>('/api/health'),

  // Nalog
  /** Da li je registracija otvorena, traži kod ili je zatvorena. */
  authConfig: () => get<AuthConfig>('/api/auth/config'),
  register: (email: string, password: string, code?: string) =>
    startSession('/api/auth/register', code ? { email, password, code } : { email, password }),
  login: (email: string, password: string) => startSession('/api/auth/login', { email, password }),
  /** Obnovi sesiju preko kolačića (pokretanje aplikacije). 401 = nije prijavljen. */
  refresh: () => refreshSession(),
  /** Opoziva sesiju ovog uređaja na serveru i briše kolačić; lokalno čišćenje radi lib/account.ts. */
  logout: () => post<{ ok: true }>('/api/auth/logout'),
  me: () => get<{ user: AuthUser }>('/api/auth/me'),
  /** Ostali uređaji se odjavljuju; ovaj dobija novu sesiju. 401 'bad_password' = pogrešna trenutna lozinka. */
  changePassword: (currentPassword: string, newPassword: string) =>
    startSession('/api/auth/password', { currentPassword, newPassword }),

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

  // Rezervna kopija (samo podaci prijavljenog naloga)
  exportData: () => request<unknown>('GET', '/api/export', undefined, NO_TIMEOUT),
  importData: (data: unknown) => request<{ ok: true }>('POST', '/api/import', data, NO_TIMEOUT),
};
