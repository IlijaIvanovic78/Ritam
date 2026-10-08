// Sitni pomoćnici koje dele moduli servera.

import type { SQLOutputValue } from 'node:sqlite';
import type { Context } from 'hono';
import { isValidISODate } from '../shared/time.ts';

/** HTTP statusi koje API namerno vraća. */
export type ErrorStatus = 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500;

/** Greška koju error handler pretvara u `{ error }` odgovor sa datim statusom. */
export class HttpError extends Error {
  status: ErrorStatus;
  constructor(status: ErrorStatus, message: string) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

export const badRequest = (message: string) => new HttpError(400, message);
export const notFound = (message: string) => new HttpError(404, message);

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

/** Parametar datuma iz putanje/upita; neispravan → 400. */
export function parseDateParam(value: string | undefined, label = 'Datum'): string {
  if (!value || !isValidISODate(value)) throw badRequest(`${label} nije ispravan.`);
  return value;
}

/** Pozitivan celobrojni id iz putanje; neispravan → 400. */
export function parseIdParam(value: string | undefined): number {
  if (!value || !/^[1-9]\d{0,14}$/.test(value)) throw badRequest('Neispravan id.');
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
