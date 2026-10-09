// Sitni pomoćnici koje dele moduli servera.

import type { SQLOutputValue } from 'node:sqlite';
import type { Context } from 'hono';
import { isValidISODate } from '../shared/time.ts';
import { msg } from './i18n.ts';
import type { MsgKey, MsgParams } from './i18n.ts';

/** HTTP statusi koje API namerno vraća. */
export type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500;

/**
 * Greška koju error handler (app.ts) pretvara u `{ error, code? }` odgovor sa datim statusom. Poruka je ključ
 * iz kataloga (server/i18n.ts) i prevodi se na jezik zahteva tek u odgovoru; `message` je engleski tekst (log).
 */
export class HttpError extends Error {
  status: ErrorStatus;
  /** Ključ poruke za korisnika (server/i18n.ts). */
  key: MsgKey;
  /** Parametri poruke ({n}, {where}…). */
  params: MsgParams | undefined;
  /** Mašinski čitljiv razlog (npr. 'token_expired'); klijent prikazuje `error`. */
  code: string | undefined;
  /** Dodatni headeri odgovora (npr. Retry-After). */
  headers: Record<string, string> | undefined;
  constructor(status: ErrorStatus, key: MsgKey, code?: string, headers?: Record<string, string>, params?: MsgParams) {
    super(msg('en', key, params));
    this.name = 'HttpError';
    this.status = status;
    this.key = key;
    this.params = params;
    this.code = code;
    this.headers = headers;
  }
}

export const badRequest = (key: MsgKey, params?: MsgParams) => new HttpError(400, key, undefined, undefined, params);
export const notFound = (key: MsgKey) => new HttpError(404, key);

export function nowISO(): string {
  return new Date().toISOString();
}

/** Red iz node:sqlite (null prototip). */
export type Row = Record<string, SQLOutputValue>;

// Čitanje kolona iz reda uz konverziju tipova (bigint → number).
export function num(v: SQLOutputValue | undefined): number {
  return typeof v === 'bigint' ? Number(v) : Number(v ?? 0);
}

export function numOrNull(v: SQLOutputValue | undefined): number | null {
  return v == null ? null : num(v);
}

export function str(v: SQLOutputValue | undefined): string {
  return v == null ? '' : String(v);
}

export function strOrNull(v: SQLOutputValue | undefined): string | null {
  return v == null ? null : String(v);
}

/** Boolean za bind u SQLite (node:sqlite ne prima boolean). */
export function flag(b: boolean): number {
  return b ? 1 : 0;
}

/** Parametar datuma iz putanje/upita; neispravan → 400 (`key` = poruka, npr. 'param.fromInvalid'). */
export function parseDateParam(
  value: string | undefined,
  key: 'param.dateInvalid' | 'param.fromInvalid' | 'param.toInvalid' | 'param.todayInvalid' = 'param.dateInvalid',
): string {
  if (!value || !isValidISODate(value)) throw badRequest(key);
  return value;
}

/** Pozitivan celobrojni id iz putanje; neispravan → 400. */
export function parseIdParam(value: string | undefined): number {
  if (!value || !/^[1-9]\d{0,14}$/.test(value)) throw badRequest('param.idInvalid');
  return Number(value);
}

/** Zahtev je stigao preko HTTPS-a (direktno ili preko proxy-ja koji postavlja X-Forwarded-Proto). */
export function isHttps(c: Context): boolean {
  const proto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim();
  return proto === 'https' || new URL(c.req.url).protocol === 'https:';
}

/** Ključ za poređenje naziva (kategorija, šablon): "Čitanje" i " čitanje" su isti naziv. */
export function nameKey(s: string): string {
  return s.normalize('NFC').trim().toLocaleLowerCase('sr');
}

/** Uklanja dijakritike i mala slova — za pretragu ("Čaj" nalazi i "caj"). */
export function foldText(s: string): string {
  return s
    .toLocaleLowerCase('sr')
    .replace(/đ/g, 'dj')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}
