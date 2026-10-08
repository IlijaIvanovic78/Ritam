import { useLayoutEffect, useRef, useState } from 'react';

/**
 * Širina elementa u pikselima (ResizeObserver). Grafik koristi viewBox iste širine,
 * pa je 1 jedinica = 1px i tekst ostaje iste veličine na telefonu i desktopu.
 */
export function useElementWidth<T extends HTMLElement>(fallback: number) {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      const w = Math.round(el.getBoundingClientRect().width);
      if (w > 0) setWidth(w);
    };
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return [ref, width] as const;
}
