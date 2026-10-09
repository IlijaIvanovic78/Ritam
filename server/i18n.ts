// Poruke servera za korisnika (greške API-ja) na engleskom i srpskom. Jezik zahteva: header
// `X-Ritam-Lang: en|sr` (klijent ga šalje uz svaki zahtev), inače Accept-Language, inače engleski.
// Kodovi grešaka (`code`) ne zavise od jezika. Log poruke (pokretanje, upozorenja) ostaju kakve jesu.
//
// Ključevi su grupisani po oblasti (auth.*, request.*, v.* — opšta validacija, param.*, day.*, block.*,
// task.*, category.*, template.*, settings.*, backup.*). {ime} se zamenjuje parametrom; "a|b" su oblici
// množine po parametru `n` (srpski "one|few|other"), vidi shared/i18n.ts.

import type { Context } from 'hono';
import { DEFAULT_LANG, formatMessage, isLang } from '../shared/i18n.ts';
import type { MessageParams } from '../shared/i18n.ts';
import type { Lang } from '../shared/types.ts';
import { PASSWORD_MAX, PASSWORD_MIN } from './auth.ts';

const en = {
  // ---- Nalozi i sesija ----
  'auth.notSignedIn': 'You’re not signed in.',
  'auth.badLogin': 'Wrong email or password.',
  'auth.clientOutdated': 'Ritam has been updated. Reload the page (or close and reopen the app), then sign in with your email.',
  'auth.rateLimited': 'Too many attempts. Try again in {n} minute.|Too many attempts. Try again in {n} minutes.',
  'auth.emailInvalid': 'Enter a valid email address.',
  'auth.passwordRequired': 'Enter your password.',
  'auth.passwordTooShort': `Password must be at least ${PASSWORD_MIN} characters.`,
  'auth.passwordTooLong': `Password can be at most ${PASSWORD_MAX} characters.`,
  'auth.signupClosed': 'Sign-up is closed.',
  'auth.badCode': 'Wrong sign-up code.',
  'auth.emailTaken': 'An account with that email address already exists.',
  'auth.currentPasswordRequired': 'Enter your current password.',
  'auth.currentPasswordWrong': 'Current password is incorrect.',
  'auth.newPasswordRequired': 'Enter a new password.',

  // ---- Zahtev ----
  'request.rejected': 'Request rejected.',
  'request.tooLarge': 'Request is too large.',
  'request.badJson': 'Invalid JSON in the request.',
  'request.failed': 'Request failed.',
  'request.notFound': 'Not found.',
  'request.serverError': 'Server error. Try again.',
  'request.devRoot':
    'Ritam API is running. The web build (dist/web) doesn’t exist — for development run "npm run dev" and open ' +
    'http://localhost:5173, or make a build with "npm run build".',

  // ---- Opšta validacija ({where} = " (polje)" ili prazno) ----
  'v.missing': 'Missing value{where}.',
  'v.wrongType': 'Wrong value type{where}.',
  'v.outOfRange': 'Value is out of the allowed range{where}.',
  'v.unknownField': 'Unknown field: {keys}.',
  'v.invalid': 'Invalid value{where}.',
  'v.invalidData': 'Invalid data.',

  // ---- Parametri putanje i upita ----
  'param.dateInvalid': 'Date is invalid.',
  'param.fromInvalid': 'Start date is invalid.',
  'param.toInvalid': 'End date is invalid.',
  'param.todayInvalid': 'Today’s date is invalid.',
  'param.fromAfterTo': 'Start date is after the end date.',
  'param.idInvalid': 'Invalid id.',
  'param.limitInvalid': 'Invalid limit.',
  'stats.rangeTooLong': 'The range can be at most {n} days.',

  // ---- Dan ----
  'day.planExists': 'A plan for this day already exists.',
  'day.noteConflict': 'The note was changed on another device in the meantime.',
  'day.noteTooLong': 'Note can be at most 20000 characters.',
  'day.ratingRange': 'Rating must be from 1 to 5.',
  'day.tooManyBlocks': 'A day can have at most 100 blocks.',
  'day.blocksChanged': 'The day was changed on another device in the meantime.',

  // ---- Blokovi ----
  'block.notFound': 'Block doesn’t exist.',
  'block.minuteInt': 'Time must be a whole number of minutes.',
  'block.titleRequired': 'Block title is required.',
  'block.titleTooLong': 'Block title can be at most 120 characters.',
  'block.timeInvalid': 'Invalid block time.',
  'block.statusInvalid': 'Invalid status.',
  'block.actualInt': 'Actual time must be a whole number of minutes.',
  'block.actualRange': 'Actual time must be between 0 and 1440 minutes.',
  'block.noteTooLong': 'Block note can be at most 5000 characters.',
  'block.splitTooShort': 'Both parts of the block must be at least 5 minutes.',
  'block.splitInvalid': 'Invalid split point.',
  'block.swapPick': 'Choose a block to swap with.',
  'block.swapSelf': 'A block can’t be swapped with itself.',
  'block.swapOtherDay': 'You can only swap blocks from the same day.',
  'block.duplicate': 'The same block is listed more than once.',
  'block.overlap': 'Blocks overlap: “{a}” and “{b}”.',
  'block.actualTooLong': 'Actual time can’t be longer than the block ({max} min).',

  // ---- Zadaci ----
  'task.notFound': 'Task doesn’t exist.',
  'task.titleRequired': 'Task title is required.',
  'task.titleTooLong': 'Task title can be at most 300 characters.',
  'task.doneInvalid': 'Invalid value for “done”.',

  // ---- Kategorije ----
  'category.notFound': 'Category doesn’t exist.',
  'category.invalid': 'Invalid category.',
  'category.nameRequired': 'Category name is required.',
  'category.nameTooLong': 'Category name can be at most 40 characters.',
  'category.nameTaken': 'A category with that name already exists.',
  'category.colorRequired': 'Color is required.',
  'category.colorFormat': 'Color must be in #rrggbb format.',

  // ---- Šabloni ----
  'template.notFound': 'Template doesn’t exist.',
  'template.invalid': 'Invalid template.',
  'template.nameRequired': 'Template name is required.',
  'template.nameTooLong': 'Template name can be at most 60 characters.',
  'template.nameTaken': 'A template with that name already exists.',
  'template.tooManyBlocks': 'A template can have at most 100 blocks.',
  'template.blocksChanged': 'The template was changed on another device in the meantime.',

  // ---- Podešavanja i raspored ----
  'settings.dayStartInt': 'Day start must be a whole number of minutes.',
  'settings.dayStartRange': 'The day can start between 00:00 and 06:00.',
  'settings.thresholdNumber': 'Threshold must be a number.',
  'settings.thresholdRange': 'Threshold must be between 10% and 100%.',
  'settings.langInvalid': 'Language must be "en" or "sr".',
  'settings.resetDayStartInvalid': 'Invalid value for day start.',

  // ---- Rezervna kopija ----
  'backup.invalid': 'The backup is invalid{where}.',
  'backup.mismatch': 'The backup is invalid: the data doesn’t match up.',
  'backup.duplicateId': 'The backup is invalid: the data doesn’t match up ({table}: duplicate id {id}).',
} as const;

export type MsgKey = keyof typeof en;

const sr = {
  'auth.notSignedIn': 'Nisi prijavljen.',
  'auth.badLogin': 'Pogrešan email ili lozinka.',
  'auth.clientOutdated': 'Ritam je ažuriran. Osveži stranicu (ili zatvori i ponovo otvori aplikaciju), pa se prijavi email-om.',
  'auth.rateLimited':
    'Previše pokušaja. Pokušaj ponovo za {n} minut.|Previše pokušaja. Pokušaj ponovo za {n} minuta.|' +
    'Previše pokušaja. Pokušaj ponovo za {n} minuta.',
  'auth.emailInvalid': 'Unesi ispravnu email adresu.',
  'auth.passwordRequired': 'Unesi lozinku.',
  'auth.passwordTooShort': `Lozinka mora imati bar ${PASSWORD_MIN} znakova.`,
  'auth.passwordTooLong': `Lozinka može imati najviše ${PASSWORD_MAX} znakova.`,
  'auth.signupClosed': 'Registracija nije otvorena.',
  'auth.badCode': 'Pogrešan kod za registraciju.',
  'auth.emailTaken': 'Nalog sa tom email adresom već postoji.',
  'auth.currentPasswordRequired': 'Unesi trenutnu lozinku.',
  'auth.currentPasswordWrong': 'Trenutna lozinka nije tačna.',
  'auth.newPasswordRequired': 'Unesi novu lozinku.',

  'request.rejected': 'Zahtev je odbijen.',
  'request.tooLarge': 'Zahtev je prevelik.',
  'request.badJson': 'Neispravan JSON u zahtevu.',
  'request.failed': 'Zahtev nije uspeo.',
  'request.notFound': 'Ne postoji.',
  'request.serverError': 'Greška na serveru. Pokušaj ponovo.',
  'request.devRoot':
    'Ritam API radi. Web build (dist/web) ne postoji — za razvoj pokreni "npm run dev" i otvori http://localhost:5173, ' +
    'ili napravi build sa "npm run build".',

  'v.missing': 'Nedostaje vrednost{where}.',
  'v.wrongType': 'Pogrešan tip vrednosti{where}.',
  'v.outOfRange': 'Vrednost je van dozvoljenog opsega{where}.',
  'v.unknownField': 'Nepoznato polje: {keys}.',
  'v.invalid': 'Neispravna vrednost{where}.',
  'v.invalidData': 'Neispravni podaci.',

  'param.dateInvalid': 'Datum nije ispravan.',
  'param.fromInvalid': 'Početni datum nije ispravan.',
  'param.toInvalid': 'Krajnji datum nije ispravan.',
  'param.todayInvalid': 'Današnji datum nije ispravan.',
  'param.fromAfterTo': 'Početni datum je posle krajnjeg.',
  'param.idInvalid': 'Neispravan id.',
  'param.limitInvalid': 'Neispravan limit.',
  'stats.rangeTooLong': 'Opseg može imati najviše {n} dana.',

  'day.planExists': 'Plan za ovaj dan već postoji.',
  'day.noteConflict': 'Beleška je u međuvremenu promenjena na drugom uređaju.',
  'day.noteTooLong': 'Beleška može imati najviše 20000 znakova.',
  'day.ratingRange': 'Ocena mora biti od 1 do 5.',
  'day.tooManyBlocks': 'Dan može imati najviše 100 blokova.',
  'day.blocksChanged': 'Dan je u međuvremenu promenjen na drugom uređaju.',

  'block.notFound': 'Blok ne postoji.',
  'block.minuteInt': 'Vreme mora biti ceo broj minuta.',
  'block.titleRequired': 'Naslov bloka je obavezan.',
  'block.titleTooLong': 'Naslov bloka može imati najviše 120 znakova.',
  'block.timeInvalid': 'Neispravno vreme bloka.',
  'block.statusInvalid': 'Neispravan status.',
  'block.actualInt': 'Stvarno vreme mora biti ceo broj minuta.',
  'block.actualRange': 'Stvarno vreme mora biti između 0 i 1440 minuta.',
  'block.noteTooLong': 'Beleška bloka može imati najviše 5000 znakova.',
  'block.splitTooShort': 'Oba dela bloka moraju imati bar 5 minuta.',
  'block.splitInvalid': 'Neispravno mesto deljenja.',
  'block.swapPick': 'Izaberi blok za zamenu.',
  'block.swapSelf': 'Blok ne može da se zameni sam sa sobom.',
  'block.swapOtherDay': 'Možeš da zameniš samo blokove istog dana.',
  'block.duplicate': 'Isti blok je naveden više puta.',
  'block.overlap': 'Blokovi se preklapaju: „{a}“ i „{b}“.',
  'block.actualTooLong': 'Stvarno vreme ne može biti duže od bloka ({max} min).',

  'task.notFound': 'Zadatak ne postoji.',
  'task.titleRequired': 'Naziv zadatka je obavezan.',
  'task.titleTooLong': 'Naziv zadatka može imati najviše 300 znakova.',
  'task.doneInvalid': 'Neispravna vrednost za "urađeno".',

  'category.notFound': 'Kategorija ne postoji.',
  'category.invalid': 'Neispravna kategorija.',
  'category.nameRequired': 'Naziv kategorije je obavezan.',
  'category.nameTooLong': 'Naziv kategorije može imati najviše 40 znakova.',
  'category.nameTaken': 'Kategorija sa tim nazivom već postoji.',
  'category.colorRequired': 'Boja je obavezna.',
  'category.colorFormat': 'Boja mora biti u obliku #rrggbb.',

  'template.notFound': 'Šablon ne postoji.',
  'template.invalid': 'Neispravan šablon.',
  'template.nameRequired': 'Naziv šablona je obavezan.',
  'template.nameTooLong': 'Naziv šablona može imati najviše 60 znakova.',
  'template.nameTaken': 'Šablon sa tim nazivom već postoji.',
  'template.tooManyBlocks': 'Šablon može imati najviše 100 blokova.',
  'template.blocksChanged': 'Šablon je u međuvremenu promenjen na drugom uređaju.',

  'settings.dayStartInt': 'Početak dana mora biti ceo broj minuta.',
  'settings.dayStartRange': 'Dan može da počne između 00:00 i 06:00.',
  'settings.thresholdNumber': 'Prag mora biti broj.',
  'settings.thresholdRange': 'Prag mora biti između 10% i 100%.',
  'settings.langInvalid': 'Jezik mora biti "en" ili "sr".',
  'settings.resetDayStartInvalid': 'Neispravna vrednost za početak dana.',

  'backup.invalid': 'Kopija nije ispravna{where}.',
  'backup.mismatch': 'Kopija nije ispravna: podaci se međusobno ne slažu.',
  'backup.duplicateId': 'Kopija nije ispravna: podaci se međusobno ne slažu ({table}: dupli id {id}).',
} satisfies Record<MsgKey, string>;

/** Katalog po jeziku (i za proveru u scripts/smoke.mjs: isti ključevi i parametri u oba jezika). */
export const MESSAGES: Readonly<Record<Lang, Readonly<Record<MsgKey, string>>>> = { en, sr };

export type MsgParams = MessageParams;

/** Poruka na datom jeziku. */
export function msg(lang: Lang, key: MsgKey, params?: MsgParams): string {
  return formatMessage(lang, MESSAGES[lang][key] ?? MESSAGES.en[key] ?? key, params);
}

/** Tekst je ključ poruke (npr. poruka iz zod šeme, vidi validate.ts). */
export function isMsgKey(s: unknown): s is MsgKey {
  return typeof s === 'string' && Object.hasOwn(en, s);
}

/**
 * Najbolji podržan jezik iz Accept-Language ("sr-Latn-RS,sr;q=0.9,en;q=0.8" → 'sr'): po opadajućem q,
 * prvi čija je primarna oznaka 'en' ili 'sr'. null = nijedan.
 */
export function langFromAcceptLanguage(header: string | undefined): Lang | null {
  if (!header) return null;
  const ranked = header
    .slice(0, 500)
    .split(',')
    .map((part, i) => {
      const [tag, ...rest] = part.trim().split(';');
      const qParam = rest.map((p) => p.trim()).find((p) => p.startsWith('q='));
      const q = qParam ? Number(qParam.slice(2)) : 1;
      return { primary: tag.trim().toLowerCase().split('-')[0], q: Number.isFinite(q) ? q : 0, i };
    })
    .filter((x) => x.q > 0)
    .sort((a, b) => b.q - a.q || a.i - b.i);
  return ranked.map((x) => x.primary).find(isLang) ?? null;
}

/** Jezik zahteva: X-Ritam-Lang (en|sr), pa Accept-Language, pa engleski. */
export function requestLang(c: Context): Lang {
  const h = c.req.header('x-ritam-lang')?.trim().toLowerCase();
  if (isLang(h)) return h;
  return langFromAcceptLanguage(c.req.header('accept-language')) ?? DEFAULT_LANG;
}
