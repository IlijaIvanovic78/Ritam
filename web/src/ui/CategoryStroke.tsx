import { cx } from './cx.ts';

/** Kuka (gore i dole): 10×14, uspravni deo na x = 5 kao i crta između, debljina 2, zaobljeni krajevi. */
const HOOK = {
  viewBox: '0 0 10 14',
  width: 10,
  height: 14,
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  focusable: 'false',
} as const;

/**
 * Boja kategorije uz red bloka: tanka uspravna crta u obliku blagog integrala (vrh se savija desno,
 * dno levo), u boji kategorije (`currentColor`). Tri dela: kuke iste veličine gore i dole i crta
 * između njih koja raste sa visinom reda — kuke se nikad ne razvlače, pa su iste u svakom redu.
 * Element se rasteže po visini roditelja (flex `align-items: stretch` ili `top`/`bottom`).
 */
export function CategoryStroke({ color, className }: { color: string; className?: string }) {
  return (
    <span className={cx('cat-stroke', className)} style={{ color }} aria-hidden="true">
      <svg {...HOOK}>
        <path d="M5 14 V8 C5 3.4 6.8 1.2 9.2 1.6" />
      </svg>
      <span className="cat-stroke-stem" />
      <svg {...HOOK}>
        <path d="M5 0 V6 C5 10.6 3.2 12.8 0.8 12.4" />
      </svg>
    </span>
  );
}
