// Potvrda pre opasnih akcija: `if (await confirmDialog({...})) ...`. <ConfirmHost/> renderuje App.

import { useSyncExternalStore, type ReactNode } from 'react';
import { t, useT } from '../i18n/index.ts';
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

/** "Discard changes?" / "Odbaci izmene?" pre zatvaranja forme sa nesačuvanim izmenama. true = odbaci. */
export function confirmDiscard(body: string = t('ui.discard.body')): Promise<boolean> {
  return confirmDialog({
    title: t('ui.discard.title'),
    body,
    confirmText: t('ui.discard.confirm'),
    cancelText: t('ui.discard.keepEditing'),
    danger: true,
  });
}

function settle(ok: boolean) {
  const c = current;
  current = null;
  emit();
  c?.resolve(ok);
}

export function ConfirmHost() {
  const tr = useT();
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
            {c?.cancelText ?? tr('common.cancel')}
          </Button>
          <Button
            variant={c?.danger ? 'danger' : 'primary'}
            onClick={() => settle(true)}
            data-autofocus={c?.danger ? undefined : true}
          >
            {c?.confirmText ?? tr('ui.confirm')}
          </Button>
        </>
      }
    >
      {c?.body && <div className="confirm-body">{c.body}</div>}
    </Sheet>
  );
}
