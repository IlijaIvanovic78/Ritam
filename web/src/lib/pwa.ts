// PWA: registracija service worker-a, "Instaliraj aplikaciju", nova verzija aplikacije (traka
// "Dostupna je nova verzija." + Osveži) i brisanje API keša.

import { useSyncExternalStore } from 'react';
import { ApiError, activeUserId, api, isCachedPayload, payloadUserId } from '../api.ts';
import { NOTES_FLUSH_EVENT } from './noteDrafts.ts';
import { whenQueueIdle } from './queue.ts';

/**
 * Keš sa API odgovorima (mora da se slaže sa API_CACHE u public/sw.js). Ime je fiksno, da nova
 * verzija service worker-a ne baci podatke za rad bez mreže; 'ritam-api-v2' je ime iz starije verzije.
 */
const API_CACHE = 'ritam-api';
const isApiCache = (n: string) => n === API_CACHE || n.startsWith(`${API_CACHE}-`);

/** Chrome/Edge događaj (nije u standardnim DOM tipovima). */
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

interface InstallState {
  /** Browser je ponudio instalaciju (beforeinstallprompt). */
  canInstall: boolean;
  /** Instalirano u ovoj sesiji (appinstalled) ili je aplikacija otvorena kao instalirana. */
  installed: boolean;
}

let deferred: BeforeInstallPromptEvent | null = null;
let state: InstallState = { canInstall: false, installed: false };
const listeners = new Set<() => void>();

function setState(p: Partial<InstallState>) {
  state = { ...state, ...p };
  listeners.forEach((l) => l());
}

/** Otvoreno kao instalirana aplikacija (početni ekran / prozor aplikacije). */
export function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  );
}

/** Hvata ponudu za instalaciju što ranije (poziva se iz main.tsx, pre rendera). */
export function initInstallPrompt() {
  if (isStandalone()) state = { ...state, installed: true };
  window.addEventListener('beforeinstallprompt', (e) => {
    // Bez automatske trake — instalacija se nudi u Podešavanjima.
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    setState({ canInstall: true });
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    setState({ canInstall: false, installed: true });
  });
}

/** Prikaži sistemski dijalog za instalaciju. Vraća true ako je korisnik prihvatio. */
async function promptInstall(): Promise<boolean> {
  const e = deferred;
  if (!e) return false;
  // Događaj može da se iskoristi samo jednom.
  deferred = null;
  setState({ canInstall: false });
  await e.prompt();
  const choice = await e.userChoice;
  return choice.outcome === 'accepted';
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useInstallPrompt(): InstallState & { promptInstall: () => Promise<boolean> } {
  const s = useSyncExternalStore(subscribe, () => state);
  return { ...s, promptInstall };
}

// ---- Nova verzija posle deploy-a ----
//
// Instalirana aplikacija (ili tab ostavljen otvoren) se pri povratku samo nastavi, bez učitavanja
// stranice, pa bi danima vrtela stari JS. Zato se build na serveru (/api/health) poredi sa ovim:
// pri pokretanju, pri povratku u aplikaciju i fokusu prozora (najviše jednom u VISIBLE_CHECK_MS), na
// POLL_CHECK_MS dok je tab vidljiv (laptop koji se nikad ne sakrije), kad se mreža vrati, kad service
// worker nađe novu verziju i na zahtev (Podešavanja → Proveri ažuriranje). Uz svaku proveru i
// reg.update() (nov sw.js).
//
// Stranica se nikad ne učitava sama (prekinula bi kucanje ili upravo kliknut status): traka
// "Dostupna je nova verzija." (App.tsx) nudi "Osveži" (applyUpdate). × je sakrije do sledećeg
// drugačijeg build-a na serveru ili do sledećeg pokretanja aplikacije.

/** Povratak u aplikaciju / fokus prozora: provera najviše jednom u ovom roku. */
const VISIBLE_CHECK_MS = 5 * 60_000;
/** Dok tab stoji vidljiv. */
const POLL_CHECK_MS = 30 * 60_000;
/** Mreža koja "trepće" (online/offline) ne zatrpava server proverama. */
const ONLINE_CHECK_MS = 15_000;
/** "Osveži": najduže čekanje da izmene iz reda (beleška, status) stignu do servera. */
const APPLY_QUEUE_WAIT_MS = 8_000;
/** "Osveži": najduže čekanje da nova verzija service worker-a preuzme stranicu. */
const SW_TAKEOVER_MS = 3_000;

/** "Osveži": najduže čekanje da service worker osveži keširanu stranicu ('/') sa mreže (kao rok zahteva). */
const SHELL_REFRESH_MS = 12_000;

/**
 * Ishod provere: 'update' = server ima drugi build (traka je prikazana, osim ako je sakrivena za taj
 * build); 'latest' = isti build; 'offline' = uređaj nema konekciju (navigator.onLine je false) ili je
 * stigla samo kopija iz keša; 'unavailable' = uređaj je na mreži, a server nije odgovorio kako treba
 * (ne odgovara, odbija konekciju, 5xx, proksi bez servera); 'unknown' = nema šta da se poredi (razvoj
 * preko Vite-a, server bez build-a).
 */
export type UpdateCheckResult = 'update' | 'latest' | 'offline' | 'unavailable' | 'unknown';

export interface UpdateState {
  /** Na serveru je druga verzija aplikacije — prikaži traku. */
  available: boolean;
  /** "Osveži" je u toku (čeka red zahteva, pa učitava stranicu ponovo). */
  applying: boolean;
}

let update: UpdateState = { available: false, applying: false };
const updateListeners = new Set<() => void>();

function setUpdate(p: Partial<UpdateState>) {
  update = { ...update, ...p };
  updateListeners.forEach((l) => l());
}

function subscribeUpdate(l: () => void) {
  updateListeners.add(l);
  return () => {
    updateListeners.delete(l);
  };
}

export function useUpdateState(): UpdateState {
  return useSyncExternalStore(subscribeUpdate, () => update);
}

let swReg: ServiceWorkerRegistration | null = null;
/** Build na serveru iz poslednje provere koja je našla drugu verziju. */
let serverBuild: string | null = null;
/** Build za koji je traka sakrivena (×); važi do sledećeg pokretanja aplikacije. */
let dismissedBuild: string | null = null;
let lastCheckAt = 0;
let autoChecking: Promise<UpdateCheckResult> | null = null;

/** Glavni JS fajl ovog build-a ("/assets/index-….js"); null u dev režimu. */
function currentBuild(): string | null {
  return document.querySelector('script[type="module"][src*="/assets/"]')?.getAttribute('src') ?? null;
}

/** Kratka oznaka ovog build-a za Podešavanja: heš iz imena glavnog JS fajla ("index-TP9-XS6p.js" → "TP9-XS6p"). */
export function buildLabel(): string | null {
  const src = currentBuild();
  if (!src) return null;
  const file = src.slice(src.lastIndexOf('/') + 1).replace(/\.js$/, '');
  return /^index[-.](.+)$/.exec(file)?.[1] ?? file;
}

const wait = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

async function runCheck(): Promise<UpdateCheckResult> {
  lastCheckAt = Date.now();
  swReg?.update().catch(() => {});
  const mine = currentBuild();
  if (!mine) return 'unknown';
  if (!navigator.onLine) return 'offline';
  let health: Awaited<ReturnType<typeof api.health>>;
  try {
    health = await api.health();
  } catch (e) {
    if (e instanceof ApiError && e.status !== 0) return 'unavailable';
    // Bez odgovora (odbijena konekcija, istek roka): uređaj na mreži = server ne radi. onLine se čita
    // ponovo, jer je konekcija mogla da nestane dok je zahtev trajao.
    return navigator.onLine ? 'unavailable' : 'offline';
  }
  // sw.js /api/health nikad ne kešira; kopija iz keša ionako ne bi govorila ništa o serveru.
  if (isCachedPayload(health)) return 'offline';
  if (!health.build) return 'unknown';
  if (health.build === mine) {
    // Server je (ponovo) na ovoj verziji, npr. vraćen prethodni deploy.
    serverBuild = null;
    if (update.available) setUpdate({ available: false });
    return 'latest';
  }
  serverBuild = health.build;
  if (health.build !== dismissedBuild && !update.available) setUpdate({ available: true });
  return 'update';
}

/**
 * Proveri da li server ima drugu verziju. `manual` (Podešavanja): uvek nova provera, a traka se
 * prikazuje i ako je ranije sakrivena za taj build. Automatske provere koje se poklope dele isti zahtev.
 */
export function checkForUpdate(manual = false): Promise<UpdateCheckResult> {
  if (manual) {
    dismissedBuild = null;
    return runCheck();
  }
  if (!autoChecking) {
    autoChecking = runCheck().finally(() => {
      autoChecking = null;
    });
  }
  return autoChecking;
}

/** Automatska provera: samo dok je tab vidljiv i ako od poslednje provere prođe bar `minGapMs`. */
function autoCheck(minGapMs: number) {
  if (document.visibilityState !== 'visible' || Date.now() - lastCheckAt < minGapMs) return;
  void checkForUpdate();
}

/** Sakrij traku do sledećeg drugačijeg build-a (ili sledećeg pokretanja). */
export function dismissUpdate() {
  dismissedBuild = serverBuild;
  setUpdate({ available: false });
}

/** Nova verzija service worker-a koja čeka (sw.js je inače aktivira sam): neka preuzme stranicu odmah. */
async function activateWaitingWorker(): Promise<void> {
  const sw = navigator.serviceWorker;
  if (!sw) return;
  const reg = swReg ?? (await sw.getRegistration().catch(() => undefined)) ?? null;
  const waiting = reg?.waiting;
  if (!waiting) return;
  await new Promise<void>((resolve) => {
    const done = () => {
      sw.removeEventListener('controllerchange', done);
      window.clearTimeout(timer);
      resolve();
    };
    const timer = window.setTimeout(done, SW_TAKEOVER_MS);
    sw.addEventListener('controllerchange', done);
    waiting.postMessage({ type: 'skip-waiting' });
  });
}

/**
 * Service worker koji kontroliše stranicu osveži keširani '/' sa mreže (poruka 'refresh-shell', vidi
 * public/sw.js): na sporoj mreži ponovno učitavanje posle NAV_TIMEOUT_MS dobija keširani '/', a on bi
 * inače (kad se sw.js nije menjao) i dalje bio stari build. Čeka odgovor najviše SHELL_REFRESH_MS, ili
 * dok stranicu ne preuzme nova verzija SW-a (ona je '/' upravo keširala pri instalaciji; i starija
 * verzija SW-a koja ne zna ovu poruku tako ne zadržava dugme do isteka roka). Nikad ne baca grešku.
 */
async function refreshShell(): Promise<void> {
  const sw = navigator.serviceWorker;
  const controller = sw?.controller;
  if (!sw || !controller) return;
  await new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    const done = () => {
      window.clearTimeout(timer);
      sw.removeEventListener('controllerchange', done);
      channel.port1.onmessage = null;
      channel.port1.close();
      resolve();
    };
    const timer = window.setTimeout(done, SHELL_REFRESH_MS);
    sw.addEventListener('controllerchange', done);
    channel.port1.onmessage = done;
    try {
      controller.postMessage({ type: 'refresh-shell' }, [channel.port2]);
    } catch {
      done();
    }
  });
}

/**
 * "Osveži": beleška u kucanju se pošalje odmah (NOTES_FLUSH_EVENT) i sačeka se da red zahteva stigne
 * do servera (draft je ionako u localStorage-u dok server ne potvrdi tekst, pa se posle učitavanja
 * vraća sam). Zatim još jedna provera: stranica se učitava samo kad server odgovara i zaista ima drugu
 * verziju — bez servera bi service worker vratio istu, keširanu verziju. Pre učitavanja SW osveži
 * keširani '/' (refreshShell). Ako je za vreme čekanja otvoren sheet ili dijalog (traka se tada ne
 * vidi), stranica se ne učitava ('busy'): forma se ne prekida, a traka se vraća kad se sheet zatvori.
 * Vraća razlog kad ne učitava. Nikad se ne poziva sama, pa ne može da uđe u petlju.
 */
export async function applyUpdate(): Promise<UpdateCheckResult | 'busy' | 'reloading'> {
  if (update.applying) return 'reloading';
  if (!navigator.onLine) return 'offline';
  setUpdate({ applying: true });
  window.dispatchEvent(new Event(NOTES_FLUSH_EVENT));
  await Promise.race([whenQueueIdle(), wait(APPLY_QUEUE_WAIT_MS)]);
  const result = await runCheck();
  if (result !== 'update') {
    setUpdate({ applying: false });
    return result;
  }
  await activateWaitingWorker();
  await refreshShell();
  if (document.querySelector('dialog[open]')) {
    setUpdate({ applying: false });
    return 'busy';
  }
  // Do zamene stranice (i do NAV_TIMEOUT_MS u sw.js) se ništa ne otvara: forma započeta sada bi propala.
  document.body.inert = true;
  // Ako browser ipak ostane na stranici, posle 10 s stranica i dugme ponovo rade.
  window.setTimeout(() => {
    document.body.inert = false;
    setUpdate({ applying: false });
  }, 10_000);
  window.location.reload();
  return 'reloading';
}

/** Provere nove verzije (bez obzira na to da li service worker postoji — http na mrežnoj adresi ga nema). */
function startUpdateChecks() {
  // Povratak u aplikaciju i fokus prozora.
  const onVisible = () => autoCheck(VISIBLE_CHECK_MS);
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('focus', onVisible);
  window.addEventListener('online', () => autoCheck(ONLINE_CHECK_MS));
  window.setInterval(() => autoCheck(POLL_CHECK_MS), 60_000);
  // Pokretanje: stranica je možda stigla iz keša service worker-a (spora mreža), a server ima noviju.
  autoCheck(0);
}

/** Registruje /sw.js i pokreće provere nove verzije (samo u produkcionom build-u, vidi main.tsx). */
export function registerSW() {
  const init = () => {
    startUpdateChecks();
    if (!('serviceWorker' in navigator)) return;
    // Nov sw.js je obično i nov deploy: proveri odmah (ne čeka se povratak u aplikaciju).
    navigator.serviceWorker.addEventListener('controllerchange', () => autoCheck(0));
    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((reg) => {
        swReg = reg;
        reg.addEventListener('updatefound', () => autoCheck(0));
      })
      .catch((err) => {
        console.warn('Service worker nije registrovan:', err);
      });
  };
  if (document.readyState === 'complete') init();
  else window.addEventListener('load', init, { once: true });
}

/** Raste pri svakom brisanju API keša: upis započet pre brisanja se odbacuje (vidi storeOfflineCopy). */
let cacheEpoch = 0;

/**
 * Briše keširane API odgovore (odjava, prijava drugog naloga na ovom uređaju, vraćanje kopije), da se
 * lični podaci ne bi prikazivali iz keša. Javlja SW-u (on odbacuje i odgovore GET zahteva koji su još
 * u toku) i briše keš direktno iz stranice.
 */
export async function clearApiCache(): Promise<void> {
  cacheEpoch += 1;
  try {
    navigator.serviceWorker?.controller?.postMessage({ type: 'clear-api-cache' });
  } catch {
    // nema aktivnog SW-a
  }
  try {
    if (!('caches' in window)) return;
    const names = await caches.keys();
    await Promise.all(names.filter(isApiCache).map((n) => caches.delete(n)));
  } catch {
    // Cache API nije dostupan (npr. http bez localhost-a)
  }
}

/**
 * Service worker čuva samo GET odgovore, pa bi posle izmene (status, beleška) kopija za rad bez
 * mreže ostala stara. Odgovor izmene se zato upiše i u keš, pod GET adresama koje ga vraćaju.
 * Samo kad SW kontroliše stranicu, kad se zna čiji je odgovor i kad je taj nalog i dalje prijavljen:
 * odgovor izmene koji stigne posle odjave (spora mreža) ne sme ponovo da napravi upravo obrisan keš.
 * Greške keša se ignorišu.
 */
export function storeOfflineCopy(urls: string[], data: unknown): void {
  try {
    const user = payloadUserId(data);
    if (!('caches' in window) || !navigator.serviceWorker?.controller || urls.length === 0 || user == null) return;
    const stillSignedIn = () => user === activeUserId();
    if (!stillSignedIn()) return;
    const epoch = cacheEpoch;
    const body = JSON.stringify(data);
    // Vreme upisa: SW ne prepisuje ovu kopiju kasnim odgovorom GET zahteva poslatog pre izmene.
    // X-Ritam-User: kopija pripada ovom nalogu (SW je ne vraća drugom nalogu, vidi public/sw.js).
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Ritam-Stored': String(Date.now()),
      'X-Ritam-User': String(user),
    };
    void caches
      .open(API_CACHE)
      .then((cache) => {
        // Sesija se mogla završiti (ili keš obrisati) dok se keš otvarao.
        if (epoch !== cacheEpoch || !stillSignedIn()) return;
        return Promise.all(urls.map((u) => cache.put(new Request(u), new Response(body, { headers }))));
      })
      .catch(() => {});
  } catch {
    // nema Cache API-ja
  }
}
