// Mali ruter na osnovu pathname-a (bez biblioteke).

import { useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from 'react';
import { isValidISODate } from '../../../shared/time.ts';

export type Route =
  | { name: 'day'; date: string | null } // null = danas
  | { name: 'progress' }
  | { name: 'journal' }
  | { name: 'schedule' }
  | { name: 'settings' }
  | { name: 'notfound' };

export const paths = {
  today: '/',
  day: (date: string) => `/dan/${date}`,
  progress: '/napredak',
  journal: '/dnevnik',
  schedule: '/raspored',
  settings: '/podesavanja',
};

/**
 * Putanja dana. Danas ide na "/" (ne /dan/<datum>), da bi se prikaz sam prebacio na novi dan
 * posle "dan počinje u".
 */
export const dayPath = (date: string, today: string) => (date === today ? paths.today : paths.day(date));

/**
 * Link na Danas kliknut dok je "/" već otvoren (navigate tada ništa ne radi): stranica dana
 * prikaže logičko danas i ako je zadržala prethodni dan posle "dan počinje u".
 */
export const TODAY_EVENT = 'ritam:today';

export function parseRoute(pathname: string): Route {
  const p = pathname.replace(/\/+$/, '') || '/';
  if (p === '/') return { name: 'day', date: null };
  const m = /^\/dan\/(\d{4}-\d{2}-\d{2})$/.exec(p);
  if (m && isValidISODate(m[1])) return { name: 'day', date: m[1] };
  if (p === paths.progress) return { name: 'progress' };
  if (p === paths.journal) return { name: 'journal' };
  if (p === paths.schedule) return { name: 'schedule' };
  if (p === paths.settings) return { name: 'settings' };
  return { name: 'notfound' };
}

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

/**
 * Forma sa nesačuvanim izmenama može da zadrži "nazad" u browseru (vidi useUnsavedGuard):
 * blokator vraća true ako je sam obradio popstate, i tada se ruta ne menja. (Capture listener na
 * window-u ne može ovo da garantuje — listeneri na samom window-u idu redom registracije.)
 */
type PopStateBlocker = (e: PopStateEvent) => boolean;
const blockers: PopStateBlocker[] = [];

export function addPopStateBlocker(fn: PopStateBlocker): () => void {
  blockers.push(fn);
  return () => {
    const i = blockers.lastIndexOf(fn);
    if (i >= 0) blockers.splice(i, 1);
  };
}

if (typeof window !== 'undefined') {
  window.addEventListener('popstate', (e) => {
    // Poslednji registrovan (najgornja forma) ima prednost.
    for (let i = blockers.length - 1; i >= 0; i--) if (blockers[i](e)) return;
    notify();
  });
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

const getPath = () => window.location.pathname + window.location.search;

export function navigate(to: string, opts: { replace?: boolean } = {}) {
  if (to === getPath()) return;
  if (opts.replace) window.history.replaceState(null, '', to);
  else window.history.pushState(null, '', to);
  window.scrollTo(0, 0);
  notify();
}

/** Trenutni pathname (+ search), reaktivno. */
export function useLocation(): string {
  return useSyncExternalStore(subscribe, getPath);
}

export function useRoute(): Route {
  const loc = useLocation();
  return parseRoute(loc.split('?')[0]);
}

type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { to: string; replace?: boolean };

export function Link({ to, replace, onClick, children, ...rest }: LinkProps) {
  const handle = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(to, { replace });
  };
  return (
    <a href={to} onClick={handle} {...rest}>
      {children}
    </a>
  );
}
