// Kriptografski temelj naloga: heš lozinke (scrypt), access token (JWT HS256), refresh token,
// email, kod za registraciju, ključ sesije i ograničenje pokušaja. Bez pristupa bazi (to je accounts.ts).

import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { ScryptOptions } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

// ---- Lozinke ----

export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 200;

/** scrypt N=2^15, r=8, p=1 (~32 MB memorije po hešu); maxmem mora biti veći od 128·N·r. */
const SCRYPT = { N: 32768, r: 8, p: 1 } as const;
const KEY_LEN = 64;
const SALT_LEN = 16;
const MAXMEM = 128 * 1024 * 1024;

function scryptAsync(password: string, salt: Buffer, keyLen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFC'), salt, keyLen, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** `scrypt$32768$8$1$<salt base64url>$<heš base64url>` */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const key = await scryptAsync(password, salt, KEY_LEN, { ...SCRYPT, maxmem: MAXMEM });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), key.toString('base64url')].join('$');
}

/** Poređenje u konstantnom vremenu. Neispravan zapis u bazi = pogrešna lozinka (ne izuzetak). */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const m = /^scrypt\$(\d{1,7})\$(\d{1,2})\$(\d{1,2})\$([A-Za-z0-9_-]{16,})\$([A-Za-z0-9_-]{16,})$/.exec(stored);
  if (!m) return false;
  const [N, r, p] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // Granice da pokvaren red u bazi ne bi tražio gigabajte memorije.
  if (N < 2 || N > 1 << 20 || (N & (N - 1)) !== 0 || r < 1 || r > 32 || p < 1 || p > 16) return false;
  const salt = Buffer.from(m[4], 'base64url');
  const expected = Buffer.from(m[5], 'base64url');
  if (expected.length < 16 || expected.length > 128) return false;
  let actual: Buffer;
  try {
    actual = await scryptAsync(password, salt, expected.length, { N, r, p, maxmem: Math.max(MAXMEM, 256 * N * r) });
  } catch {
    return false;
  }
  return timingSafeEqual(actual, expected);
}

let dummyHash: Promise<string> | null = null;
/**
 * Heš nasumične lozinke: prijava sa nepostojećim emailom ipak radi jednu scrypt proveru, pa se po vremenu
 * odgovora ne vidi da li nalog postoji.
 */
export function dummyPasswordHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(18).toString('base64url'));
  return dummyHash;
}

// ---- Email ----

export const EMAIL_MAX = 254;

/** trim + mala slova; null = nije ispravna adresa (nešto@nešto.tld, najviše 254 znaka). */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (email.length > EMAIL_MAX || !/^[^\s@]+@[^\s@]+\.[^\s@.]+$/.test(email)) return null;
  // Bez kontrolnih znakova (log, kolačić, prikaz).
  if (/[\u0000-\u001f\u007f]/.test(email)) return null;
  return email;
}

// ---- Ključ sesije ----

/**
 * Ključ za potpis access tokena kad SESSION_SECRET nije postavljen: 32 nasumična bajta u `file`
 * (pravi se pri prvom pokretanju, mode 600).
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

// ---- Access token (JWT HS256) ----

const JWT_HEADER = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');

export type AccessCheck = { ok: true; uid: number } | { ok: false; code: 'unauthorized' | 'token_expired' };

export interface AccessTokens {
  /** Sekunde važenja (expiresIn u odgovoru). */
  ttlSec: number;
  sign(uid: number, nowMs?: number): string;
  verify(token: string | undefined, nowMs?: number): AccessCheck;
}

/**
 * Ključ potpisa = HMAC-SHA256(sessionKey, 'ritam:access-v1'). Claims: { sub: "<id>", typ: "access", iat, exp }.
 * Promena SESSION_SECRET (ili brisanje session.key) poništava access tokene; refresh tokeni su u bazi,
 * pa klijent samo dobije nov access token.
 */
export function createAccessTokens(sessionKey: string | Uint8Array, ttlSec: number): AccessTokens {
  const key = createHmac('sha256', sessionKey).update('ritam:access-v1', 'utf8').digest();
  const sig = (data: string) => createHmac('sha256', key).update(data, 'ascii').digest();

  return {
    ttlSec,

    sign(uid, nowMs = Date.now()) {
      const iat = Math.floor(nowMs / 1000);
      const payload = Buffer.from(JSON.stringify({ sub: String(uid), typ: 'access', iat, exp: iat + ttlSec })).toString(
        'base64url',
      );
      const data = `${JWT_HEADER}.${payload}`;
      return `${data}.${sig(data).toString('base64url')}`;
    },

    verify(token, nowMs = Date.now()) {
      const bad = { ok: false, code: 'unauthorized' } as const;
      if (!token || token.length > 2048) return bad;
      const parts = token.split('.');
      // Samo naš header (alg HS256): "alg: none" i drugi algoritmi ne prolaze.
      if (parts.length !== 3 || parts[0] !== JWT_HEADER || !/^[A-Za-z0-9_-]+$/.test(parts[1] + parts[2])) return bad;
      const expected = sig(`${parts[0]}.${parts[1]}`);
      const actual = Buffer.from(parts[2], 'base64url');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return bad;
      let claims: { sub?: unknown; typ?: unknown; exp?: unknown };
      try {
        claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      } catch {
        return bad;
      }
      if (claims?.typ !== 'access' || typeof claims.sub !== 'string' || !/^[1-9]\d{0,14}$/.test(claims.sub)) return bad;
      if (typeof claims.exp !== 'number') return bad;
      if (claims.exp <= Math.floor(nowMs / 1000)) return { ok: false, code: 'token_expired' };
      return { ok: true, uid: Number(claims.sub) };
    },
  };
}

// ---- Refresh token ----

/** 32 nasumična bajta (base64url) — šalje se samo u kolačiću, u bazi je samo heš. */
export function newRefreshToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('base64url');
}

export function newFamilyId(): string {
  return randomBytes(16).toString('base64url');
}

// ---- Registracija ----

export type SignupPolicy = 'open' | 'code' | 'closed';

/** Kod za registraciju u konstantnom vremenu (poređenje heševa jednake dužine). */
export function codeMatches(candidate: unknown, code: string): boolean {
  if (!code || typeof candidate !== 'string') return false;
  const h = (s: string) => createHash('sha256').update(s, 'utf8').digest();
  return timingSafeEqual(h(candidate), h(code));
}

// ---- Ograničenje pokušaja ----

const WINDOW_MS = 15 * 60 * 1000;
/** Globalna granica (svi ključevi zajedno) — štiti i kad se adresa klijenta lažira. */
const MAX_GLOBAL = 300;
const MAX_TRACKED_KEYS = 5000;

export interface AttemptLimiter {
  /**
   * Koliko ms još treba da se čeka ako je bilo koji od ključeva (ili server ukupno) iscrpeo pokušaje u
   * prozoru od 15 min; 0 = dozvoljeno.
   */
  retryAfter(keys: string[], now?: number): number;
  /**
   * Beleži jedan neuspeh za svaki ključ (globalno se broji jednom) i vraća njegovo vreme — pokušaj se beleži
   * pre provere lozinke, pa se uspeo pokušaj posle poništi sa `forgive`.
   */
  fail(keys: string[], now?: number): number;
  /** Poništava JEDAN pokušaj zabeležen sa `fail` (vreme `ts`) za date ključeve i globalno; raniji neuspesi ostaju. */
  forgive(keys: string[], ts: number): void;
  reset(key: string): void;
}

/** `max` neuspeha po ključu u 15 min (ključevi npr. `ip:…`, `email:…`, `reg:…`). */
export function createAttemptLimiter(max: number): AttemptLimiter {
  const failures = new Map<string, number[]>();
  let global: number[] = [];

  const recent = (list: number[] | undefined, now: number) => (list ?? []).filter((t) => now - t < WINDOW_MS);
  /** Lista je rastuća po vremenu: blokada traje dok ne istekne dovoljno najstarijih neuspeha. */
  const waitFor = (list: number[], limit: number, now: number) =>
    list.length >= limit ? list[list.length - limit] + WINDOW_MS - now : 0;

  return {
    retryAfter(keys, now = Date.now()) {
      global = recent(global, now);
      let wait = waitFor(global, MAX_GLOBAL, now);
      for (const k of keys) wait = Math.max(wait, waitFor(recent(failures.get(k), now), max, now));
      return Math.max(0, wait);
    },

    fail(keys, now = Date.now()) {
      // Povremeno čišćenje da mapa ne raste bez granice.
      if (failures.size >= MAX_TRACKED_KEYS) {
        for (const [k, list] of failures) {
          const r = recent(list, now);
          if (r.length) failures.set(k, r);
          else failures.delete(k);
        }
        if (failures.size >= MAX_TRACKED_KEYS) failures.clear();
      }
      for (const k of keys) failures.set(k, [...recent(failures.get(k), now), now]);
      global.push(now);
      return now;
    },

    forgive(keys, ts) {
      /** Uklanja jedno pojavljivanje `ts` (isti milisekund može imati više pokušaja). */
      const drop = (list: number[]) => {
        const i = list.indexOf(ts);
        if (i !== -1) list.splice(i, 1);
      };
      for (const k of keys) {
        const list = failures.get(k);
        if (!list) continue;
        drop(list);
        if (list.length === 0) failures.delete(k);
      }
      drop(global);
    },

    reset(key) {
      failures.delete(key);
    },
  };
}
