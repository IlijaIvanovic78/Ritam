// Prijava jednom lozinkom (APP_PASSWORD), potpisan kolačić sesije i
// ograničenje neuspelih pokušaja.

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

export const SESSION_COOKIE = 'ritam_session';
/** Sesija važi 400 dana (i to je najveći Max-Age koji browseri prihvataju). */
export const SESSION_MAX_AGE_S = 400 * 24 * 60 * 60;
const SESSION_MAX_AGE_MS = SESSION_MAX_AGE_S * 1000;
/** Sesija starija od ovoga se obnavlja pri sledećem zahtevu (uređaj koji se koristi ostaje prijavljen). */
export const SESSION_RENEW_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest();

export interface Auth {
  /** false = APP_PASSWORD nije postavljen, svi zahtevi su dozvoljeni. */
  required: boolean;
  checkPassword(password: string): boolean;
  /** Nova vrednost kolačića: `v1.<issuedAtMs>.<base64url HMAC>`. */
  issueSession(now?: number): string;
  /** Vreme izdavanja (ms) ako je kolačić važeća sesija, inače null. */
  sessionIssuedAt(value: string | undefined, now?: number): number | null;
}

/**
 * `sessionKey`: SESSION_SECRET ili nasumičan ključ iz DATA_DIR/session.key (vidi `loadSessionKey`).
 * Lozinka je i dalje deo ključa, pa promena APP_PASSWORD (ili ključa) odjavljuje sve uređaje.
 */
export function createAuth(password: string, sessionKey: string | Uint8Array): Auth {
  const required = password.length > 0;
  const passwordHash = sha256(password);
  const secret = createHmac('sha256', sessionKey.length ? sessionKey : 'ritam').update(`ritam:${password}`, 'utf8').digest();

  const sign = (payload: string) => createHmac('sha256', secret).update(payload, 'utf8').digest('base64url');

  return {
    required,

    checkPassword(candidate) {
      if (!required) return true;
      // Poređenje heševa jednake dužine u konstantnom vremenu.
      return timingSafeEqual(sha256(candidate), passwordHash);
    },

    issueSession(now = Date.now()) {
      const payload = `v1.${now}`;
      return `${payload}.${sign(payload)}`;
    },

    sessionIssuedAt(value, now = Date.now()) {
      if (!value) return null;
      const m = /^v1\.(\d{1,16})\.([A-Za-z0-9_-]{1,100})$/.exec(value);
      if (!m) return null;
      const issuedAt = Number(m[1]);
      // Dozvoljen mali pomak sata unapred; posle 400 dana sesija ističe.
      if (issuedAt > now + 60_000 || now - issuedAt > SESSION_MAX_AGE_MS) return null;
      const expected = Buffer.from(sign(`v1.${m[1]}`), 'utf8');
      const actual = Buffer.from(m[2], 'utf8');
      return actual.length === expected.length && timingSafeEqual(actual, expected) ? issuedAt : null;
    },
  };
}

/**
 * Ključ za potpis sesije kad SESSION_SECRET nije postavljen: 32 nasumična bajta u `file`
 * (pravi se pri prvom pokretanju). Bez njega bi ključ zavisio samo od lozinke, pa bi ukraden
 * kolačić omogućio pogađanje lozinke van servera, bez ograničenja pokušaja.
 */
export function loadSessionKey(file: string): Buffer {
  try {
    const key = readFileSync(file);
    if (key.length >= 32) return key;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const key = randomBytes(32);
  writeFileSync(file, key, { mode: 0o600 });
  return key;
}

// ---- Ograničenje pokušaja prijave ----

const WINDOW_MS = 15 * 60 * 1000;
const MAX_PER_CLIENT = 10;
/** Globalna granica (svi klijenti zajedno) — štiti i kad se adresa klijenta lažira. */
const MAX_GLOBAL = 300;
const MAX_TRACKED_CLIENTS = 5000;

export interface LoginLimiter {
  /**
   * Koliko ms još treba da se čeka ako je klijent (ili server ukupno) iscrpeo pokušaje
   * u prozoru od 15 min; 0 = prijava je dozvoljena.
   */
  retryAfter(client: string, now?: number): number;
  fail(client: string, now?: number): void;
  reset(client: string): void;
}

export function createLoginLimiter(): LoginLimiter {
  const failures = new Map<string, number[]>();
  let global: number[] = [];

  const recent = (list: number[] | undefined, now: number) => (list ?? []).filter((t) => now - t < WINDOW_MS);
  /** Lista je rastuća po vremenu: blokada traje dok ne istekne dovoljno najstarijih neuspeha. */
  const waitFor = (list: number[], max: number, now: number) =>
    list.length >= max ? list[list.length - max] + WINDOW_MS - now : 0;

  return {
    retryAfter(client, now = Date.now()) {
      global = recent(global, now);
      return Math.max(0, waitFor(recent(failures.get(client), now), MAX_PER_CLIENT, now), waitFor(global, MAX_GLOBAL, now));
    },

    fail(client, now = Date.now()) {
      // Povremeno čišćenje da mapa ne raste bez granice.
      if (failures.size >= MAX_TRACKED_CLIENTS) {
        for (const [k, list] of failures) {
          const r = recent(list, now);
          if (r.length) failures.set(k, r);
          else failures.delete(k);
        }
        if (failures.size >= MAX_TRACKED_CLIENTS) failures.clear();
      }
      failures.set(client, [...recent(failures.get(client), now), now]);
      global.push(now);
    },

    reset(client) {
      failures.delete(client);
    },
  };
}
