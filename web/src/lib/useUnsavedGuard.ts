import { useEffect, useRef } from 'react';
import { addPopStateBlocker } from './router.tsx';

/**
 * Forma sa nesačuvanim izmenama: pitaj "Odbaci izmene?" i pri "nazad" u browseru (miš, Alt+←,
 * gest na iPhone-u) i pri zatvaranju/osvežavanju taba. Popstate se hvata pre rutera i poništava,
 * pa stranica ostaje dok korisnik ne potvrdi; tek tada se "nazad" izvrši.
 *
 * `requestClose` je isto što i X/Esc u formi: vraća true ako je forma zatvorena.
 */
export function useUnsavedGuard(dirty: boolean, requestClose: () => Promise<boolean>) {
  const requestCloseRef = useRef(requestClose);
  requestCloseRef.current = requestClose;

  useEffect(() => {
    if (!dirty) return;
    const here = window.location.pathname + window.location.search;
    // Drugo "nazad" dok je pitanje otvoreno se samo poništi (ne otvara drugo pitanje).
    let asking = false;
    let leaving = false;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    const removeBlocker = addPopStateBlocker(() => {
      // Naše "nazad" posle potvrde: pusti ruter.
      if (leaving) return false;
      window.history.pushState(null, '', here);
      if (asking) return true;
      asking = true;
      void (async () => {
        try {
          const closed = await requestCloseRef.current();
          if (closed) {
            // Odbačene izmene: tek sada izvrši "nazad".
            leaving = true;
            window.history.back();
          }
        } finally {
          asking = false;
        }
      })();
      return true;
    });
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      removeBlocker();
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [dirty]);
}
