// Ručno crtane ikone (24×24, linija 1.75). Bez spoljnih biblioteka.

import type { ReactNode } from 'react';

const paths = {
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  half: (
    <>
      <circle cx="12" cy="12" r="7.5" />
      <path d="M12 4.5a7.5 7.5 0 0 0 0 15z" fill="currentColor" stroke="none" />
    </>
  ),
  x: <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />,
  'chevron-left': <path d="M14.5 5.5L8 12l6.5 6.5" />,
  'chevron-right': <path d="M9.5 5.5L16 12l-6.5 6.5" />,
  'chevron-down': <path d="M5.5 9.5L12 16l6.5-6.5" />,
  'chevron-up': <path d="M5.5 14.5L12 8l6.5 6.5" />,
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  more: (
    <>
      <circle cx="5.5" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="18.5" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </>
  ),
  trash: <path d="M4.5 7h15M10 11v6M14 11v6M6.5 7l.8 11.5a2 2 0 0 0 2 1.5h5.4a2 2 0 0 0 2-1.5L17.5 7M9.5 7V4.5h5V7" />,
  calendar: (
    <>
      <rect x="3.5" y="5" width="17" height="15.5" rx="2" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
    </>
  ),
  today: (
    <>
      <rect x="3.5" y="5" width="17" height="15.5" rx="2" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
      <rect x="7.5" y="13" width="4" height="4" rx="0.5" fill="currentColor" stroke="none" />
    </>
  ),
  chart: <path d="M4 20h16M7 20v-6M12 20V6M17 20v-9" />,
  journal: (
    <>
      <path d="M6 3.5h11a1.5 1.5 0 0 1 1.5 1.5v14a1.5 1.5 0 0 1-1.5 1.5H6z" />
      <path d="M6 3.5v17M10 8.5h5M10 12h5" />
    </>
  ),
  blocks: (
    <>
      <rect x="4" y="4" width="16" height="4.5" rx="1" />
      <rect x="4" y="10" width="10" height="4.5" rx="1" />
      <rect x="4" y="16" width="13" height="4" rx="1" />
    </>
  ),
  settings: (
    <>
      <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
      <circle cx="15" cy="7" r="2" />
      <circle cx="9" cy="17" r="2" />
    </>
  ),
  logout: <path d="M14 4.5h3.5a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H14M10 16l-4-4 4-4M6 12h10" />,
  edit: <path d="M4.5 19.5h4l10-10-4-4-10 10zM13 7l4 4" />,
  split: (
    <>
      <rect x="4" y="3.5" width="16" height="6" rx="1" />
      <rect x="4" y="14.5" width="16" height="6" rx="1" />
      <path d="M3 12h2.5M8.5 12h2.5M14 12h2.5M19.5 12H21" />
    </>
  ),
  note: <path d="M5 6.5h14M5 11.5h14M5 16.5h9" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  download: <path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19.5h14" />,
  upload: <path d="M12 19V8M7.5 12.5L12 8l4.5 4.5M5 4.5h14" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4 4" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />
    </>
  ),
  moon: <path d="M19.5 14.5A7.5 7.5 0 0 1 9.5 4.5a7.5 7.5 0 1 0 10 10z" />,
  'arrow-right': <path d="M5 12h14M13 6l6 6-6 6" />,
  'arrow-left': <path d="M19 12H5M11 6l-6 6 6 6" />,
  lock: (
    <>
      <rect x="5" y="10.5" width="14" height="10" rx="2" />
      <path d="M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3" />
    </>
  ),
  copy: (
    <>
      <rect x="8.5" y="8.5" width="11" height="11" rx="1.5" />
      <path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5.5M12 7.8v.2" />
    </>
  ),
  refresh: <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3M19.5 4.5v4h-4" />,
  phone: (
    <>
      <rect x="7" y="3" width="10" height="18" rx="2" />
      <path d="M11 17.5h2" />
    </>
  ),
  dot: <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />,
  // Akcije bloka (components/blocks): premesti, završi sad, kraće, duže, zatvori prazninu, poništi.
  move: <path d="M12 3v18M3 12h18M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3" />,
  'end-now': <path d="M4 12h10M10 7.5l4.5 4.5-4.5 4.5M19 5v14" />,
  shorter: <path d="M5 4h14M5 20h14M12 7.5v3.5M9 9l3 2.5L15 9M12 16.5V13M9 15l3-2.5 3 2.5" />,
  longer: <path d="M5 12h14M12 3v6.5M9 6l3-3 3 3M12 21v-6.5M9 18l3 3 3-3" />,
  collapse: <path d="M5 12h14M12 3.5v5M9.5 6.5l2.5 2.5 2.5-2.5M12 20.5v-5M9.5 17.5l2.5-2.5 2.5 2.5" />,
  undo: <path d="M9 14L4.5 9.5 9 5M4.5 9.5H15a4.5 4.5 0 0 1 0 9h-3" />,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof paths;

export function Icon({ name, size = 20, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      className={className ? `icon ${className}` : 'icon'}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {paths[name]}
    </svg>
  );
}
