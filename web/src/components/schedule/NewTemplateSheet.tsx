// Mali sheet za novi šablon: naziv i opciono "Kopiraj iz" postojećeg šablona.

import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { api, errorMessage } from '../../api.ts';
import { scheduleStore, useScheduleData } from '../../lib/store.ts';
import { Button, Field, Select, Sheet, TextInput, toast } from '../../ui/index.ts';
import { TEMPLATE_NAME_MAX, maxId } from './util.ts';

export function NewTemplateSheet({ onClose, onCreated }: { onClose: () => void; onCreated: (id: number) => void }) {
  const { templates } = useScheduleData();
  const formId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState('');
  const [copyFrom, setCopyFrom] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Greška se prikazuje i u podnožju: toast ostaje ispod otvorenog modala.
  const [failure, setFailure] = useState<string | null>(null);

  // Efekat roditelja se izvršava posle Sheet-ovog showModal(), pa fokus ovde radi.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (saving) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Upiši naziv.');
      inputRef.current?.focus();
      return;
    }
    setFailure(null);
    setSaving(true);
    try {
      const payload = await api.addTemplate(copyFrom ? { name: trimmed, copyFrom: Number(copyFrom) } : { name: trimmed });
      scheduleStore.set(payload);
      const id = maxId(payload.templates);
      if (id != null) onCreated(id);
      else onClose();
    } catch (err) {
      const msg = errorMessage(err);
      toast.error(msg);
      setFailure(msg);
      setSaving(false);
    }
  }

  return (
    <Sheet
      open
      onClose={() => {
        if (!saving) onClose();
      }}
      title="Novi šablon"
      size="sm"
      footer={
        <>
          {failure && (
            <p className="sched-foot-error" role="alert">
              {failure}
            </p>
          )}
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Otkaži
          </Button>
          <Button variant="primary" type="submit" form={formId} loading={saving}>
            Napravi
          </Button>
        </>
      }
    >
      <form id={formId} className="stack" onSubmit={submit} noValidate>
        <Field label="Naziv" error={error}>
          <TextInput
            ref={inputRef}
            value={name}
            maxLength={TEMPLATE_NAME_MAX}
            placeholder="Naziv šablona"
            onChange={(e) => {
              setName(e.target.value);
              if (error) setError(null);
            }}
            aria-invalid={!!error}
          />
        </Field>
        {templates.length > 0 && (
          <Field
            label="Kopiraj iz"
            hint={copyFrom ? 'Novi šablon dobija iste blokove kao izabrani.' : 'Šablon počinje bez blokova.'}
          >
            <Select value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)}>
              <option value="">Prazan šablon</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </form>
    </Sheet>
  );
}
