import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Icon, IconButton, type IconName } from '../../ui/index.ts';

export interface MenuItem {
  label: string;
  icon: IconName;
  onSelect: () => void;
  disabled?: boolean;
}

/** Mali padajući meni (⋯). Zatvara se klikom van, Escape-om ili izborom stavke. */
export function DayMenu({ items, label = 'Još opcija' }: { items: MenuItem[]; label?: string }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  const enabledItems = () =>
    Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)') ?? []);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) wrapRef.current?.querySelector<HTMLButtonElement>('.day-menu-trigger')?.focus();
  };

  useEffect(() => {
    if (!open) return;
    enabledItems()[0]?.focus();
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [open]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const list = enabledItems();
    const i = list.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      list[(i + 1) % list.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      list[(i - 1 + list.length) % list.length]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      list[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      list[list.length - 1]?.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  return (
    <div className="day-menu-wrap" ref={wrapRef}>
      <IconButton
        icon="more"
        label={label}
        className="day-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((o) => !o)}
      />
      {open && (
        <div className="day-menu" role="menu" id={menuId} aria-label={label} ref={menuRef} onKeyDown={onKeyDown}>
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              className="day-menu-item"
              disabled={it.disabled}
              onClick={() => {
                close(false);
                it.onSelect();
              }}
            >
              <Icon name={it.icon} size={18} />
              <span>{it.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
