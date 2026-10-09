// Kratka obaveštenja. toast(t('common.saved')), toast.error('...'), toast.success('...'). Poruka je već prevedena.

import { useEffect, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { useT } from '../i18n/index.ts';
import { cx } from './cx.ts';
import { DIALOGS_EVENT } from './Sheet.tsx';

type Kind = 'info' | 'success' | 'error';
interface Item {
  id: number;
  message: string;
  kind: Kind;
}

let items: Item[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function push(message: string, kind: Kind = 'info', ms = kind === 'error' ? 5000 : 2800) {
  const id = nextId++;
  items = [...items.filter((i) => i.message !== message), { id, message, kind }].slice(-3);
  emit();
  window.setTimeout(() => dismiss(id), ms);
}

function dismiss(id: number) {
  items = items.filter((i) => i.id !== id);
  emit();
}

export const toast = Object.assign((message: string) => push(message, 'info'), {
  success: (message: string) => push(message, 'success'),
  error: (message: string) => push(message, 'error'),
});

export function Toaster() {
  const t = useT();
  const list = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    () => items,
  );

  // Otvoren Sheet je modalni <dialog>: sve van njega je ispod njega i ne prima dodir. Zato se
  // toaster dok je dijalog otvoren prikazuje UNUTAR najgornjeg otvorenog dijaloga (vidljiv je i
  // × radi), na vrhu ekrana — da ne pokrije dugmad sheet-a ni tastaturu.
  const [host, setHost] = useState<HTMLDialogElement | null>(null);
  useEffect(() => {
    const update = () => {
      const open = document.querySelectorAll<HTMLDialogElement>('dialog[open]');
      setHost(open.length ? open[open.length - 1] : null);
    };
    update();
    window.addEventListener(DIALOGS_EVENT, update);
    return () => window.removeEventListener(DIALOGS_EVENT, update);
  }, []);

  return createPortal(
    <div className={cx('toaster', host && 'toaster-top')} aria-live="polite" aria-atomic="false">
      {list.map((item) => (
        <div
          key={item.id}
          className={cx('toast', `toast-${item.kind}`)}
          role={item.kind === 'error' ? 'alert' : 'status'}
        >
          <span>{item.message}</span>
          <button type="button" className="toast-close" aria-label={t('common.close')} onClick={() => dismiss(item.id)}>
            ×
          </button>
        </div>
      ))}
    </div>,
    host ?? document.body,
  );
}
