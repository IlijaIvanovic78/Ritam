// PWA: registracija service worker-a, "Instaliraj aplikaciju" i brisanje API keša.

import { useSyncExternalStore } from 'react';
import { api, isCachedPayload } from '../api.ts';
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
// Instalirana aplikacija (ili tab ostavljen otvoren) se pri povratku samo nastavi, bez
// učitavanja stranice, pa bi danima vrtela stari JS. Pri povratku u aplikaciju, fokusu prozora i
// povremeno dok je tab vidljiv (najviše jednom u UPDATE_CHECK_MS) proveri sw.js i build na
// serveru; ako je nov, učitaj ponovo — ali samo kad ništa nije otvoreno ni u kucanju (nesačuvana
// beleška ionako preživi, vidi noteDrafts.ts).

const UPDATE_CHECK_MS = 10 * 60_000;
let lastUpdateCheck = Date.now();
/** Nova verzija je na serveru; stranica se učitava ponovo čim korisnik ništa ne radi. */
let updatePending = false;
/** Poslednji dodir/taster — ponovno učitavanje ne sme da "pojede" upravo kliknut status. */
let lastInputAt = 0;
/** Koliko dugo posle poslednjeg dodira/tastera se čeka pre ponovnog učitavanja. */
const QUIET_MS = 3000;

/** Glavni JS fajl ovog build-a ("/assets/index-….js"); null u dev režimu. */
function currentBuild(): string | null {
  return document.querySelector('script[type="module"][src*="/assets/"]')?.getAttribute('src') ?? null;
}

/** Ponovno učitavanje bi sad prekinulo nešto (otvoren sheet ili polje u kom se kuca). */
function busyEditing(): boolean {
  if (document.querySelector('dialog[open]')) return true;
  const a = document.activeElement;
  return a instanceof HTMLElement && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable);
}

const wait = (ms: number) => new Promise((r) => window.setTimeout(r, ms));

/**
 * Učitaj novu verziju tek kad je sve poslato (red zahteva dana je prazan — npr. status kliknut
 * odmah po povratku u aplikaciju), korisnik nekoliko sekundi ništa ne dira i ništa nije otvoreno.
 */
async function reloadWhenIdle() {
  if (updatePending) return;
  updatePending = true;
  for (;;) {
    await whenQueueIdle();
    const quietFor = Date.now() - lastInputAt;
    if (quietFor < QUIET_MS) {
      await wait(QUIET_MS - quietFor);
      continue;
    }
    if (busyEditing()) {
      await wait(QUIET_MS);
      continue;
    }
    // Ništa novo nije krenulo dok smo čekali.
    await whenQueueIdle();
    if (Date.now() - lastInputAt >= QUIET_MS) break;
  }
  window.location.reload();
}

async function checkForUpdate(reg: ServiceWorkerRegistration) {
  reg.update().catch(() => {});
  const mine = currentBuild();
  if (!mine || updatePending) return;
  try {
    // Server javlja build samo ako to podržava; bez toga provera se preskače. Kopija iz keša
    // (server nije dostupan) ne govori ništa o tome šta je na serveru.
    const health = await api.health();
    if (isCachedPayload(health)) return;
    if (health.build && health.build !== mine) void reloadWhenIdle();
  } catch {
    // bez mreže — probaće se sledeći put
  }
}

/** Registruje /sw.js (samo u produkcionom build-u, vidi main.tsx). */
export function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  const register = () => {
    navigator.serviceWorker
      .register('/sw.js', { scope: '/' })
      .then((reg) => {
        const onInput = () => {
          lastInputAt = Date.now();
        };
        window.addEventListener('pointerdown', onInput, { capture: true, passive: true });
        window.addEventListener('keydown', onInput, { capture: true, passive: true });
        // Povratak u aplikaciju, fokus prozora, i povremeno dok tab stoji vidljiv (laptop koji se
        // nikad ne sakrije ne bi inače nikad dobio novu verziju).
        const maybeCheck = () => {
          if (document.visibilityState !== 'visible' || Date.now() - lastUpdateCheck < UPDATE_CHECK_MS) return;
          lastUpdateCheck = Date.now();
          void checkForUpdate(reg);
        };
        document.addEventListener('visibilitychange', maybeCheck);
        window.addEventListener('focus', maybeCheck);
        window.setInterval(maybeCheck, 60_000);
      })
      .catch((err) => {
        console.warn('Service worker nije registrovan:', err);
      });
  };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}

/**
 * Briše keširane API odgovore (posle odjave ili vraćanja kopije), da se lični podaci
 * ne bi prikazivali iz keša. Javlja SW-u i briše keš direktno iz stranice.
 */
export async function clearApiCache(): Promise<void> {
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
 * Samo kad SW kontroliše stranicu; greške keša se ignorišu.
 */
export function storeOfflineCopy(urls: string[], data: unknown): void {
  try {
    if (!('caches' in window) || !navigator.serviceWorker?.controller || urls.length === 0) return;
    const body = JSON.stringify(data);
    // Vreme upisa: SW ne prepisuje ovu kopiju kasnim odgovorom GET zahteva poslatog pre izmene.
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'X-Ritam-Stored': String(Date.now()) };
    void caches
      .open(API_CACHE)
      .then((cache) => Promise.all(urls.map((u) => cache.put(new Request(u), new Response(body, { headers })))))
      .catch(() => {});
  } catch {
    // nema Cache API-ja
  }
}
