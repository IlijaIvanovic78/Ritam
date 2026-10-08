// Logo "Ritam" (Pinyon Script kao SVG putanja). Boja prati tekst (currentColor).

import { WORDMARK } from './wordmarkPath.ts';
import { cx } from './cx.ts';

export function Wordmark({ height = 28, className }: { height?: number; className?: string }) {
  const width = (WORDMARK.width / WORDMARK.height) * height;
  return (
    <svg
      className={cx('wordmark', className)}
      width={width}
      height={height}
      viewBox={`0 0 ${WORDMARK.width} ${WORDMARK.height}`}
      role="img"
      aria-label="Ritam"
    >
      <path d={WORDMARK.d} fill="currentColor" />
    </svg>
  );
}
