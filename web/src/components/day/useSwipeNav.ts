// Prevlačenje prstom levo/desno na telefonu → sledeći/prethodni dan.
// Reaguje samo na jasan, brz horizontalan potez koji nije počeo u polju za unos,
// kontroli ili elementu koji se sam horizontalno skroluje, ni uz samu ivicu ekrana (sistemski
// "nazad" na Androidu/iOS-u), i ne dok je otvoren dijalog (sheet, potvrda) ili meni.

import { useEffect, useRef, type RefObject } from 'react';

const MIN_DX = 70; // px
const MAX_MS = 700;
/** Potez koji počne ovoliko blizu leve/desne ivice pripada sistemu (gest "nazad"). */
const EDGE_PX = 20;

/** Nešto je otvoreno preko stranice (sheet, potvrda, meni ⋯) — prevlačenje ga ne sme zaobići. */
function overlayOpen(): boolean {
  return !!document.querySelector('dialog[open], [role="menu"]');
}

function ignoreTarget(el: EventTarget | null): boolean {
  if (!(el instanceof Element)) return false;
  return !!el.closest('input, textarea, select, [contenteditable="true"], [data-no-swipe], dialog');
}

export function useSwipeNav(ref: RefObject<HTMLElement | null>, onPrev: () => void, onNext: () => void) {
  const handlers = useRef({ onPrev, onNext });
  handlers.current = { onPrev, onNext };

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let start: { x: number; y: number; t: number } | null = null;

    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      if (
        e.touches.length !== 1 ||
        ignoreTarget(e.target) ||
        overlayOpen() ||
        t.clientX < EDGE_PX ||
        t.clientX > window.innerWidth - EDGE_PX
      ) {
        start = null;
        return;
      }
      start = { x: t.clientX, y: t.clientY, t: performance.now() };
    };

    const onEnd = (e: TouchEvent) => {
      const s = start;
      start = null;
      if (!s || e.changedTouches.length !== 1 || overlayOpen()) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - s.x;
      const dy = t.clientY - s.y;
      if (performance.now() - s.t > MAX_MS) return;
      if (Math.abs(dx) < MIN_DX || Math.abs(dx) < Math.abs(dy) * 2) return;
      if (dx < 0) handlers.current.onNext();
      else handlers.current.onPrev();
    };

    const onCancel = () => {
      start = null;
    };

    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchend', onEnd, { passive: true });
    el.addEventListener('touchcancel', onCancel, { passive: true });
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onCancel);
    };
  }, [ref]);
}
