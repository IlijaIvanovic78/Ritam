import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { logicalNow } from '../../../shared/time.ts';
import { serverStaleStore } from '../api.ts';
import { useSettings } from './store.ts';

/** Trenutno vreme, osvežava se na svakih `intervalMs` i kad se aplikacija vrati u fokus. */
export function useNow(intervalMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const tick = () => setNow(new Date());
    const id = window.setInterval(tick, intervalMs);
    const onVis = () => {
      if (document.visibilityState === 'visible') tick();
    };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('focus', tick);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('focus', tick);
    };
  }, [intervalMs]);
  return now;
}

/** Logički današnji datum i minut (poštuje "dan počinje u" iz podešavanja). */
export function useLogicalNow(intervalMs = 30_000): { date: string; minute: number } {
  const { dayStart } = useSettings();
  const now = useNow(intervalMs);
  return logicalNow(dayStart, now);
}

export function useMediaQuery(query: string): boolean {
  const [match, setMatch] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mql = window.matchMedia(query);
    const on = () => setMatch(mql.matches);
    on();
    mql.addEventListener('change', on);
    return () => mql.removeEventListener('change', on);
  }, [query]);
  return match;
}

/** true na širini >= 860px (desktop raspored). */
export function useIsDesktop(): boolean {
  return useMediaQuery('(min-width: 860px)');
}

export function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

/**
 * true kad podaci stižu iz keša service worker-a (server nije dostupan iako uređaj ima mrežu —
 * restart servera, loša veza), dok server ponovo ne odgovori. Prikazani podaci su možda zastareli.
 */
export function useServerStale(): boolean {
  return useSyncExternalStore(serverStaleStore.subscribe, serverStaleStore.get);
}

/**
 * Debounce za funkciju. `flush()` odmah izvrši poslednji poziv (npr. pri napuštanju stranice),
 * `cancel()` ga odbaci. Poslednji poziv se automatski izvrši i pri unmount-u.
 */
export function useDebouncedCallback<A extends unknown[]>(fn: (...args: A) => void, delay: number) {
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const timer = useRef<number | null>(null);
  const pending = useRef<A | null>(null);

  const flush = useCallback(() => {
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = null;
    const args = pending.current;
    pending.current = null;
    if (args) fnRef.current(...args);
  }, []);

  const cancel = useCallback(() => {
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = null;
    pending.current = null;
  }, []);

  const call = useCallback(
    (...args: A) => {
      pending.current = args;
      if (timer.current != null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(flush, delay);
    },
    [delay, flush],
  );

  useEffect(() => flush, [flush]);

  return { call, flush, cancel };
}

/** Prethodna vrednost (iz prošlog rendera). */
export function usePrevious<T>(value: T): T | undefined {
  const ref = useRef<T | undefined>(undefined);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref.current;
}
