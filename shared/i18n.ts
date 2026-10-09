// Jezik interfejsa: pravila koja dele server (poruke grešaka, server/i18n.ts) i web klijent (web/src/i18n).
// Podrazumevano je engleski ('en'); srpski ('sr', latinica, obraćanje na "ti") je dodatni jezik.
//
// Poruka u katalogu je običan tekst sa {imenom} za zamenu. Poruka sa oblicima množine ima oblike razdvojene
// znakom "|" i bira se po broju `n` iz parametara: engleski "one|other" ("{n} block|{n} blocks"), srpski
// "one|few|other" ("{n} blok|{n} bloka|{n} blokova"; few = 2–4 osim 12–14).

import type { Lang } from './types.ts';

export const LANGS = ['en', 'sr'] as const satisfies readonly Lang[];
export const DEFAULT_LANG: Lang = 'en';

export function isLang(v: unknown): v is Lang {
  return v === 'en' || v === 'sr';
}

/** Vrednost za `<html lang>`: srpski je uvek latinica. */
export function htmlLang(lang: Lang): string {
  return lang === 'sr' ? 'sr-Latn' : 'en';
}

export type PluralCategory = 'one' | 'few' | 'other';

/**
 * Kategorija množine: engleski one (1) / other; srpski one (n % 10 = 1, osim 11), few (n % 10 = 2..4, osim
 * 12..14), other. Za srpski se gleda ceo deo broja (2,5 → few, kao "2,5 bloka").
 */
export function pluralCategory(lang: Lang, n: number): PluralCategory {
  if (lang === 'en') return Math.abs(n) === 1 ? 'one' : 'other';
  const a = Math.abs(Math.trunc(n));
  const d = a % 10;
  const dd = a % 100;
  if (d === 1 && dd !== 11) return 'one';
  if (d >= 2 && d <= 4 && (dd < 12 || dd > 14)) return 'few';
  return 'other';
}

/** Oblici množine; bez `few` (engleski) se za few koristi `other`. */
export interface PluralForms {
  one: string;
  few?: string;
  other: string;
}

/** "a|b" → { one: a, other: b }; "a|b|c" → { one: a, few: b, other: c }. */
function splitForms(s: string): PluralForms {
  const parts = s.split('|');
  if (parts.length >= 3) return { one: parts[0], few: parts[1], other: parts[2] };
  if (parts.length === 2) return { one: parts[0], other: parts[1] };
  return { one: s, other: s };
}

/**
 * Oblik za broj `n`: `plural('sr', 3, { one: 'blok', few: 'bloka', other: 'blokova' })` → "bloka".
 * `forms` može biti i tekst sa oblicima razdvojenim sa "|" (kao u katalogu).
 */
export function plural(lang: Lang, n: number, forms: PluralForms | string): string {
  const f = typeof forms === 'string' ? splitForms(forms) : forms;
  const cat = pluralCategory(lang, n);
  if (cat === 'one') return f.one;
  if (cat === 'few') return f.few ?? f.other;
  return f.other;
}

export type MessageParams = Record<string, string | number>;

/**
 * Poruka iz kataloga sa parametrima: oblik množine po `params.n` (ako poruka ima "|"), pa {ime} → vrednost.
 * Nepoznat {ime} ostaje kakav jeste (lakše se primeti greška).
 */
export function formatMessage(lang: Lang, template: string, params?: MessageParams): string {
  const text = template.includes('|') ? plural(lang, Number(params?.n ?? 0), template) : template;
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (m, name: string) => (Object.hasOwn(params, name) ? String(params[name]) : m));
}
