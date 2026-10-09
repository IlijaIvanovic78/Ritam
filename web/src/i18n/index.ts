// Jezik interfejsa na klijentu: izabran jezik (store), prevod poruka (t / useT) i množina.
// Pravila za ključeve i tekst su na vrhu en.ts.
//
// Jezik: podrazumevano engleski. Na uređaju se pamti u localStorage 'ritam.lang' (izbor na ekranu prijave ili u
// Podešavanjima), a na nalogu u podešavanjima (`settings.lang`, PATCH /api/settings): posle prijave i obnove
// sesije jezik naloga ima prednost i upisuje se i na uređaj (`syncAccountLang`, poziva ga lib/store.ts kad stigne
// raspored). Promena jezika menja `<html lang>` ('en' / 'sr-Latn'), ostale tabove (događaj `storage`) i header
// `X-Ritam-Lang` uz svaki zahtev (api.ts) — server po njemu vraća poruke grešaka na tom jeziku.

import { useMemo, useSyncExternalStore } from 'react';
import { DEFAULT_LANG, LANGS, formatMessage, htmlLang, isLang, plural, pluralCategory } from '../../../shared/i18n.ts';
import type { PluralForms } from '../../../shared/i18n.ts';
import type { Lang } from '../../../shared/types.ts';
import { en } from './en.ts';
import type { MessageKey } from './en.ts';
import { sr } from './sr.ts';

export type { Lang, MessageKey, PluralForms };
export { DEFAULT_LANG, LANGS, isLang, plural, pluralCategory };

const CATALOGS: Record<Lang, Record<MessageKey, string>> = { en, sr };

// ---- Tipovi parametara (iz engleskog teksta poruke) ----

/** Imena {parametara} u tekstu poruke. */
type Placeholders<S extends string> = S extends `${string}{${infer P}}${infer Rest}` ? P | Placeholders<Rest> : never;
/** Poruka sa oblicima množine ("a|b") traži broj `n`. */
type PluralParam<S extends string> = S extends `${string}|${string}` ? 'n' : never;
type ParamNames<K extends MessageKey> = Placeholders<(typeof en)[K]> | PluralParam<(typeof en)[K]>;

/** Parametri poruke `K`: tačno njeni {parametri}; `n` (množina) je broj. */
export type MessageParams<K extends MessageKey> = {
  [P in ParamNames<K>]: P extends 'n' ? number : string | number;
};

/** Argumenti posle ključa: ništa za poruku bez parametara, inače objekat parametara. */
export type TArgs<K extends MessageKey> = [ParamNames<K>] extends [never] ? [] : [params: MessageParams<K>];

export type TFunction = <K extends MessageKey>(key: K, ...args: TArgs<K>) => string;

function translate(lang: Lang, key: MessageKey, params?: Record<string, string | number>): string {
  return formatMessage(lang, CATALOGS[lang][key] ?? en[key] ?? key, params);
}

// ---- Izabran jezik ----

const STORAGE_KEY = 'ritam.lang';

function readStored(): Lang | null {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return isLang(v) ? v : null;
  } catch {
    // privatni režim / blokiran storage — podrazumevani jezik
    return null;
  }
}

function writeStored(lang: Lang): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // izbor važi do zatvaranja stranice
  }
}

let current: Lang = readStored() ?? DEFAULT_LANG;
const listeners = new Set<() => void>();

function applyDocument(lang: Lang): void {
  document.documentElement.lang = htmlLang(lang);
}

function notify(): void {
  listeners.forEach((l) => l());
}

// Pre prvog rendera (modul se učitava sa api.ts): <html lang> odgovara jeziku sa uređaja.
applyDocument(current);

// Promena jezika u drugom tabu iste aplikacije.
window.addEventListener('storage', (e) => {
  if (e.key !== STORAGE_KEY && e.key !== null) return;
  const next = readStored() ?? DEFAULT_LANG;
  if (next === current) return;
  current = next;
  applyDocument(next);
  notify();
});

/** Trenutni jezik interfejsa. */
export function getLang(): Lang {
  return current;
}

/** Promeni jezik na ovom uređaju (i u ostalim tabovima). Nalog se menja posebno (api.patchSettings({ lang })). */
export function setLang(lang: Lang): void {
  if (!isLang(lang)) return;
  writeStored(lang);
  if (lang === current) return;
  current = lang;
  applyDocument(lang);
  notify();
}

export function subscribeLang(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** Jezik interfejsa; komponenta se ponovo renderuje kad se promeni. */
export function useLang(): Lang {
  return useSyncExternalStore(subscribeLang, getLang);
}

// ---- Jezik naloga ----

/** Poslednji jezik naloga koji je stigao sa servera u ovoj sesiji; null = još nijedan (prijava, obnova sesije). */
let accountLang: Lang | null = null;

/**
 * Jezik naloga iz podešavanja (raspored sa servera, `settings.lang`). Primenjuje se kad stigne prvi put posle
 * prijave ili obnove sesije (jezik naloga ima prednost nad izborom na uređaju) i kad se promeni na serveru
 * (drugi uređaj). Isti jezik naloga koji je već viđen se ne primenjuje ponovo: zakasneo odgovor poslat pre
 * promene jezika ovde ne vraća stari jezik. Kopija iz keša starije verzije servera nema `lang` — ignoriše se.
 */
export function syncAccountLang(lang: unknown): void {
  if (!isLang(lang) || lang === accountLang) return;
  accountLang = lang;
  setLang(lang);
}

/** Sesija je završena (odjava, odbijena sesija): sledeća prijava ponovo primenjuje jezik naloga. */
export function resetAccountLang(): void {
  accountLang = null;
}

// ---- Prevod ----

/**
 * Poruka na trenutnom jeziku — za kod van Reacta (lib, pomoćne funkcije). U komponenti koristi `useT()`, da se
 * tekst promeni sa jezikom.
 */
export function t<K extends MessageKey>(key: K, ...args: TArgs<K>): string {
  return translate(current, key, args[0] as Record<string, string | number> | undefined);
}

/** Poruka na zadatom jeziku (npr. poruka za drugi jezik od trenutnog). */
export function tIn<K extends MessageKey>(lang: Lang, key: K, ...args: TArgs<K>): string {
  return translate(lang, key, args[0] as Record<string, string | number> | undefined);
}

/**
 * Nabrajanje: ["a", "b", "c"] → en "a, b and c", sr "a, b i c" (dani u nedelji, datumi). Stavke ne smeju imati
 * zarez (za datume koristi fmtDateShort "Oct 8", ne fmtDateMedium "Thu, Oct 8").
 */
export function joinAnd(items: string[], lang: Lang): string {
  if (items.length <= 1) return items.join('');
  return tIn(lang, 'common.listAnd', { rest: items.slice(0, -1).join(', '), last: items[items.length - 1] });
}

/** `t` za komponentu: ponovo se renderuje kad se promeni jezik (nova funkcija za svaki jezik). */
export function useT(): TFunction {
  const lang = useLang();
  return useMemo<TFunction>(
    () =>
      (key, ...args) =>
        translate(lang, key, args[0] as Record<string, string | number> | undefined),
    [lang],
  );
}
