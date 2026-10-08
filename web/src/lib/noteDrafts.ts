// Lokalna kopija nesačuvane beleške dana (po datumu). Tekst tako preživi neuspelo čuvanje,
// prelazak na drugi dan i gašenje aplikacije; briše se čim server potvrdi isti tekst.

const PREFIX = 'ritam.note.';

export interface NoteDraft {
  /** Beleška sa servera nad kojom je draft pisan. */
  base: string;
  text: string;
}

export function readNoteDraft(date: string): NoteDraft | null {
  try {
    const raw = localStorage.getItem(PREFIX + date);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<NoteDraft> | null;
    return v && typeof v.base === 'string' && typeof v.text === 'string' ? { base: v.base, text: v.text } : null;
  } catch {
    return null;
  }
}

export function writeNoteDraft(date: string, draft: NoteDraft): void {
  try {
    localStorage.setItem(PREFIX + date, JSON.stringify(draft));
  } catch {
    // privatni režim / pun storage — draft ostaje samo u memoriji
  }
}

export function removeNoteDraft(date: string): void {
  try {
    localStorage.removeItem(PREFIX + date);
  } catch {
    // nema storage-a
  }
}

/** Datumi za koje postoji lokalni draft. */
export function listNoteDraftDates(): string[] {
  try {
    return Object.keys(localStorage)
      .filter((k) => k.startsWith(PREFIX))
      .map((k) => k.slice(PREFIX.length))
      .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
      .sort();
  } catch {
    return [];
  }
}

// ---- Otvorene beleške (kartica Beleške za taj datum je na ekranu i sama čuva svoj draft) ----

const open = new Map<string, number>();

/** Kartica beleške za `date` je otvorena; vraća funkciju koja to poništava. */
export function markNoteOpen(date: string): () => void {
  open.set(date, (open.get(date) ?? 0) + 1);
  return () => {
    const n = (open.get(date) ?? 1) - 1;
    if (n <= 0) open.delete(date);
    else open.set(date, n);
  };
}

export function isNoteOpen(date: string): boolean {
  return open.has(date);
}

let lastTypedAt = 0;

/** Korisnik je upravo kucao u belešku. */
export function markNoteTyped(): void {
  lastTypedAt = Date.now();
}

/** Da li je u beleškama kucano u poslednjih `ms` milisekundi. */
export function noteTypedWithin(ms: number): boolean {
  return Date.now() - lastTypedAt < ms;
}

/** Vraćanje rezervne kopije (stari draftovi više ne važe) i odjava (lični tekst ne ostaje na uređaju). */
export function clearNoteDrafts(): void {
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith(PREFIX)) localStorage.removeItem(k);
  } catch {
    // nema storage-a
  }
}
