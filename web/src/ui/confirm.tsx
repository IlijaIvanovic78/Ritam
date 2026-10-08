// Potvrda pre opasnih akcija: `if (await confirmDialog({...})) ...`. <ConfirmHost/> renderuje App.

import { useSyncExternalStore, type ReactNode } from 'react';
import { Button } from './Button.tsx';
import { Sheet } from './Sheet.tsx';

interface ConfirmOptions {
  title: string;
  body?: ReactNode;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}

interface Pending extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

let current: Pending | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  current?.resolve(false);
  return new Promise((resolve) => {
    current = { ...opts, resolve };
    emit();
  });
}

/** "Odbaci izmene?" pre zatvaranja forme sa nesačuvanim izmenama. true = odbaci. */
export function confirmDiscard(body = 'Izmene nisu sačuvane.'): Promise<boolean> {
  return confirmDialog({ title: 'Odbaci izmene?', body, confirmText: 'Odbaci', cancelText: 'Nastavi izmenu', danger: true });
}

function settle(ok: boolean) {
  const c = current;
  current = null;
  emit();
  c?.resolve(ok);
}

export function ConfirmHost() {
  const c = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    () => current,
  );
  return (
    <Sheet
      open={!!c}
      onClose={() => settle(false)}
      title={c?.title ?? ''}
      size="sm"
      footer={
        <>
          {/* Fokus: kod opasnih akcija na "Otkaži" (Enter ne briše slučajno), inače na potvrdu. */}
          <Button variant="ghost" onClick={() => settle(false)} data-autofocus={c?.danger ? true : undefined}>
            {c?.cancelText ?? 'Otkaži'}
          </Button>
          <Button
            variant={c?.danger ? 'danger' : 'primary'}
            onClick={() => settle(true)}
            data-autofocus={c?.danger ? undefined : true}
          >
            {c?.confirmText ?? 'Potvrdi'}
          </Button>
        </>
      }
    >
      {c?.body && <div className="confirm-body">{c.body}</div>}
    </Sheet>
  );
}
