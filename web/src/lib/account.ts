// Nalog na ovom uređaju: poslednji prijavljen korisnik, čišćenje podataka prethodnog korisnika,
// odjava i javljanje prijave/odjave ostalim tabovima (localStorage događaj `storage`).

import type { AuthUser } from '../../../shared/types.ts';
import { api, endSession, sameUser, sessionUserId, UNAUTHORIZED_EVENT } from '../api.ts';
import { adoptLegacyNoteDrafts, clearNoteDraftsOf } from './noteDrafts.ts';
import { clearApiCache } from './pwa.ts';
import { whenQueueIdle } from './queue.ts';
import { navigate, paths } from './router.tsx';

/**
 * Poslednji nalog prijavljen na ovom uređaju (ostaje i posle odjave — za prepoznavanje promene naloga).
 * `signedOut`: sesija tog naloga je završena (odjava, odbijena sesija) — pokretanje bez servera tada ne
 * prikazuje njegovu aplikaciju, nego Prijavu.
 */
const LAST_USER_KEY = 'ritam.lastUser';
/** Prijava/odjava u jednom tabu; ostali tabovi je dobiju kao `storage` događaj. */
const AUTH_EVENT_KEY = 'ritam.authEvent';

/** Koliko odjava najduže čeka da se pošalju izmene iz reda (npr. beleška sačuvana pri izlasku sa dana). */
const LOGOUT_QUEUE_WAIT_MS = 5_000;

export interface LastUser extends AuthUser {
  signedOut?: true;
}

function parseUser(raw: string | null): LastUser | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<LastUser> | null;
    if (!v || typeof v.id !== 'number' || typeof v.email !== 'string') return null;
    return v.signedOut === true ? { id: v.id, email: v.email, signedOut: true } : { id: v.id, email: v.email };
  } catch {
    return null;
  }
}

export function readLastUser(): LastUser | null {
  try {
    return parseUser(localStorage.getItem(LAST_USER_KEY));
  } catch {
    return null;
  }
}

function writeLastUser(u: LastUser) {
  try {
    localStorage.setItem(LAST_USER_KEY, JSON.stringify(u));
  } catch {
    // bez storage-a nema ni lokalnih podataka za čišćenje
  }
}

/**
 * Sesija poslednjeg naloga je završena (odjava, odbijena sesija): id i email ostaju (prepoznavanje
 * promene naloga), a pokretanje bez servera ne prikazuje više njegove podatke.
 */
export function markSignedOut(): void {
  const last = readLastUser();
  if (last && !last.signedOut) writeLastUser({ id: last.id, email: last.email, signedOut: true });
}

/**
 * Server označava nalog koji je pri registraciji preuzeo podatke iz verzije bez naloga
 * (`legacyOwner: true` uz korisnika, opciono). Samo njemu pripadaju i draftovi iz te verzije.
 */
function isLegacyOwner(user: AuthUser): boolean {
  return user.legacyOwner === true;
}

/**
 * Posle prijave, registracije i obnove sesije pri pokretanju. Ako se na ovom uređaju prijavio drugi
 * nalog, brišu se kopije API odgovora (service worker) i nesačuvane beleške prethodnog naloga. Isti id
 * sa drugim email-om je drugi nalog (email se ne menja, pa je to druga baza na istoj adresi). Draftove
 * iz verzije bez naloga preuzima samo nalog koji je preuzeo i podatke te verzije na serveru.
 */
export async function adoptUser(user: AuthUser): Promise<void> {
  const last = readLastUser();
  const same = sameUser(last, user);
  if (!same || last?.signedOut) writeLastUser({ id: user.id, email: user.email });
  if (!same && last) clearNoteDraftsOf(last.id);
  if (isLegacyOwner(user)) adoptLegacyNoteDrafts(user.id);
  if (!same) await clearApiCache();
}

// ---- Ostali tabovi ----

export type AuthEvent = { type: 'login'; userId: number } | { type: 'logout' };

function announce(ev: AuthEvent) {
  try {
    // `at` čini svaku vrednost novom, pa `storage` stiže i kad se isti nalog prijavi ponovo.
    localStorage.setItem(AUTH_EVENT_KEY, JSON.stringify({ ...ev, at: Date.now() }));
  } catch {
    // bez storage-a ostali tabovi saznaju pri sledećem osvežavanju sesije
  }
}

export function announceLogin(user: AuthUser): void {
  announce({ type: 'login', userId: user.id });
}

/** Prijava ili odjava u drugom tabu ovog browsera. Vraća funkciju za odjavu slušanja. */
export function onOtherTabAuth(handler: (ev: AuthEvent) => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key !== AUTH_EVENT_KEY || !e.newValue) return;
    try {
      const v = JSON.parse(e.newValue) as { type?: unknown; userId?: unknown };
      if (v.type === 'logout') handler({ type: 'logout' });
      else if (v.type === 'login' && typeof v.userId === 'number') handler({ type: 'login', userId: v.userId });
    } catch {
      // neispravna vrednost — ignoriši
    }
  };
  window.addEventListener('storage', onStorage);
  return () => window.removeEventListener('storage', onStorage);
}

// ---- Odjava ----

/** Sačekaj da se pošalju izmene iz reda (najviše nekoliko sekundi). */
export function settlePendingWrites(): Promise<void> {
  return Promise.race([whenQueueIdle(), new Promise<void>((r) => window.setTimeout(r, LOGOUT_QUEUE_WAIT_MS))]);
}

/**
 * Odjava ovog uređaja: server opoziva sesiju i briše kolačić (bez servera odjava ne uspeva — kolačić
 * je HttpOnly, pa bi sledeće pokretanje ponovo prijavilo isti nalog). Sesija u tabu se završava odmah
 * (odgovor izmene koji stigne posle toga ne upisuje ništa u keš ni u draftove), pa se brišu nesačuvane
 * beleške i kopije API odgovora ovog naloga, a ostali tabovi i App prelaze na prijavu. Sledeća prijava
 * (bilo kog naloga) počinje od stranice Danas.
 */
export async function logout(): Promise<void> {
  const uid = sessionUserId();
  await api.logout();
  endSession();
  if (uid != null) clearNoteDraftsOf(uid);
  markSignedOut();
  await clearApiCache();
  announce({ type: 'logout' });
  window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
  navigate(paths.today, { replace: true });
}

/** Odjava u drugom tabu: ovaj tab zaboravlja svoj token i prelazi na prijavu. */
export function endSessionFromOtherTab(): void {
  endSession();
  window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
}
