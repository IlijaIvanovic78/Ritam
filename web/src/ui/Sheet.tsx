// Modal preko native <dialog>: na telefonu donji "sheet", na desktopu centriran dijalog.
// Sadržaj se renderuje samo dok je otvoren (forme se resetuju pri svakom otvaranju).
//
// onClose je zahtev za zatvaranje (X, Esc, "nazad" na Androidu, klik na pozadinu). Forma sa
// nesačuvanim izmenama može da pita "Odbaci izmene?" i ostavi sheet otvoren.

import { useEffect, useRef, type ReactNode } from 'react';
import { useT } from '../i18n/index.ts';
import { IconButton } from './Button.tsx';
import { cx } from './cx.ts';

type SheetProps = {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  /**
   * Gde vratiti fokus pri zatvaranju ako element koji je otvorio sheet više ne postoji
   * (npr. red pregleda dana zamenjen sačuvanim blokom).
   */
  returnFocus?: () => HTMLElement | null;
};

/** Otvoren je ili zatvoren neki sheet (Toaster prati najgornji otvoren dijalog). */
export const DIALOGS_EVENT = 'ritam:dialogs';

let openCount = 0;

/** Polje u kom je otvorena tastatura (dodir na pozadinu je tada samo skloni). */
function isTypingField(el: Element | null): el is HTMLElement {
  if (!(el instanceof HTMLElement)) return false;
  if (el.tagName === 'TEXTAREA') return true;
  return el instanceof HTMLInputElement && !['checkbox', 'radio', 'button', 'submit', 'file'].includes(el.type);
}

export function Sheet({ open, onClose, title, children, footer, size = 'md', returnFocus }: SheetProps) {
  const t = useT();
  const ref = useRef<HTMLDialogElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const returnFocusRef = useRef(returnFocus);
  returnFocusRef.current = returnFocus;
  /** React strana smatra da je dijalog otvoren (za usklađivanje sa native zatvaranjem). */
  const openRef = useRef(false);
  /** Gde je počeo poslednji pritisak: zatvara samo klik koji je i počeo na pozadini. */
  const press = useRef({ backdrop: false, touch: false });

  useEffect(() => {
    const d = ref.current;
    if (!d || !open) return;
    openRef.current = true;
    const active = document.activeElement;
    const opener = active instanceof HTMLElement && active !== document.body ? active : null;
    if (!d.open) d.showModal();
    // showModal() fokusira prvi fokusabilan element (dugme Zatvori); element sa
    // data-autofocus ima prednost. (React-ov autoFocus se izvrši pre showModal-a.)
    d.querySelector<HTMLElement>('[data-autofocus]')?.focus();
    openCount += 1;
    document.documentElement.classList.add('no-scroll');
    window.dispatchEvent(new Event(DIALOGS_EVENT));
    return () => {
      openRef.current = false;
      if (d.open) d.close();
      openCount -= 1;
      if (openCount <= 0) {
        openCount = 0;
        document.documentElement.classList.remove('no-scroll');
      }
      window.dispatchEvent(new Event(DIALOGS_EVENT));
      // Fokus nazad na ono što je otvorilo sheet. Dijalog koji je React već uklonio iz DOM-a
      // (forma se zatvara unmount-om) to sam ne uradi, pa bi fokus pao na <body>.
      const back = opener?.isConnected ? opener : (returnFocusRef.current?.() ?? null);
      if (back && back.isConnected && !back.closest('dialog:not([open])')) back.focus({ preventScroll: true });
    };
  }, [open]);

  return (
    <dialog
      ref={ref}
      className={cx('sheet', `sheet-${size}`)}
      onCancel={(e) => {
        // Esc / "nazad". Kad događaj ne može da se otkaže (Chrome posle više uzastopnih
        // pritisaka bez dodira), browser sam zatvara dijalog — to hvata onClose ispod.
        e.preventDefault();
        if (e.cancelable) onCloseRef.current();
      }}
      onClose={() => {
        const d = ref.current;
        // Browser je zatvorio dijalog mimo React-a: vrati ga i prosledi kao zahtev za zatvaranje,
        // da forma može da ostane otvorena (inače bi bila nevidljiva, a stranica zaključana).
        if (!d || !openRef.current || d.open || !d.isConnected) return;
        d.showModal();
        onCloseRef.current();
      }}
      onPointerDown={(e) => {
        press.current = { backdrop: e.target === e.currentTarget, touch: e.pointerType === 'touch' };
      }}
      onClick={(e) => {
        const p = press.current;
        press.current = { backdrop: false, touch: false };
        // Prevlačenje (npr. označavanje teksta) koje se završi van panela nije klik na pozadinu.
        if (!p.backdrop || e.target !== e.currentTarget) return;
        const active = document.activeElement;
        if (p.touch && isTypingField(active) && e.currentTarget.contains(active)) {
          active.blur();
          return;
        }
        onCloseRef.current();
      }}
    >
      {open && (
        <div className="sheet-panel">
          <header className="sheet-head">
            <h2 className="sheet-title">{title}</h2>
            <IconButton icon="x" label={t('common.close')} onClick={() => onCloseRef.current()} />
          </header>
          <div className="sheet-body">{children}</div>
          {footer && <footer className="sheet-foot">{footer}</footer>}
        </div>
      )}
    </dialog>
  );
}
