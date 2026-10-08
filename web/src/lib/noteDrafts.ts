// Lokalna kopija nesačuvane beleške dana (po nalogu i datumu). Tekst tako preživi neuspelo čuvanje,
// prelazak na drugi dan i gašenje aplikacije; briše se čim server potvrdi isti tekst.
//
// Ključ: `ritam.note.<userId>.<datum>` — draft jednog naloga se nikad ne šalje u drugi nalog.
// Bez prijavljenog korisnika nema ni draftova (čitanje vraća null, upis se preskače). `owner` (kartica
// beleške pamti nalog za koji je otvorena): draft samo tog naloga, i samo dok je on prijavljen u tabu.

import { sessionUserId } from '../api.ts';

const ROOT = 'ritam.note.';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const prefixOf = (userId: number) => `${ROOT}${userId}.`;

/** `owner` izostavljen = prijavljen nalog; zadat = samo ako je baš on prijavljen (inače nijedan). */
function currentPrefix(owner?: number | null): string | null {
  const id = sessionUserId();
  if (id == null || (owner !== undefined && owner !== id)) return null;
  return prefixOf(id);
}

export interface NoteDraft {
  /** Beleška sa servera nad kojom je draft pisan. */
  base: string;
  text: string;
}

export function readNoteDraft(date: string, owner?: number | null): NoteDraft | null {
  const prefix = currentPrefix(owner);
  if (!prefix) return null;
  try {
    const raw = localStorage.getItem(prefix + date);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<NoteDraft> | null;
    return v && typeof v.base === 'string' && typeof v.text === 'string' ? { base: v.base, text: v.text } : null;
  } catch {
    return null;
  }
}

export function writeNoteDraft(date: string, draft: NoteDraft, owner?: number | null): void {
  const prefix = currentPrefix(owner);
  if (!prefix) return;
  try {
    localStorage.setItem(prefix + date, JSON.stringify(draft));
  } catch {
    // privatni režim / pun storage — draft ostaje samo u memoriji
  }
}

export function removeNoteDraft(date: string, owner?: number | null): void {
  const prefix = currentPrefix(owner);
  if (!prefix) return;
  try {
    localStorage.removeItem(prefix + date);
  } catch {
    // nema storage-a
  }
}

/** Ključevi u localStorage-u koji počinju sa `prefix` (prazno bez storage-a). */
function keysWith(prefix: string): string[] {
  try {
    return Object.keys(localStorage).filter((k) => k.startsWith(prefix));
  } catch {
    return [];
  }
}

/** Datumi za koje prijavljen nalog ima lokalni draft. */
export function listNoteDraftDates(): string[] {
  const prefix = currentPrefix();
  if (!prefix) return [];
  return keysWith(prefix)
    .map((k) => k.slice(prefix.length))
    .filter((d) => DATE_RE.test(d))
    .sort();
}

/**
 * "Pošalji belešku odmah": otvorena kartica beleške šalje nesačuvan tekst bez čekanja debounce-a
 * (pre ponovnog učitavanja za novu verziju, lib/pwa.ts applyUpdate).
 */
export const NOTES_FLUSH_EVENT = 'ritam:flush-notes';

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

function removeKeys(keys: string[]) {
  try {
    for (const k of keys) localStorage.removeItem(k);
  } catch {
    // nema storage-a
  }
}

/**
 * Draftovi prijavljenog naloga: vraćanje rezervne kopije (stari draftovi više ne važe) i odjava
 * (lični tekst ne ostaje na uređaju).
 */
export function clearNoteDrafts(): void {
  const prefix = currentPrefix();
  if (prefix) removeKeys(keysWith(prefix));
}

/** Draftovi drugog naloga (na ovom uređaju se prijavio neko drugi). */
export function clearNoteDraftsOf(userId: number): void {
  removeKeys(keysWith(prefixOf(userId)));
}

/**
 * Draftovi iz verzije bez naloga (`ritam.note.<datum>`) pripadaju nalogu koji je na serveru preuzeo
 * podatke te verzije (`legacyOwner`, vidi lib/account.ts) — ne prvom nalogu prijavljenom na uređaju.
 * Postojeći draft naloga ima prednost.
 */
export function adoptLegacyNoteDrafts(userId: number): void {
  const target = prefixOf(userId);
  try {
    for (const k of keysWith(ROOT)) {
      const date = k.slice(ROOT.length);
      if (!DATE_RE.test(date)) continue;
      const raw = localStorage.getItem(k);
      if (raw && localStorage.getItem(target + date) == null) localStorage.setItem(target + date, raw);
      localStorage.removeItem(k);
    }
  } catch {
    // nema storage-a
  }
}
