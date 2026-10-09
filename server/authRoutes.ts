// Auth rute (/api/auth/*) i Bearer middleware za sve ostale /api rute.
//   Prijava: email + lozinka → access token (JWT, 15 min, samo u memoriji klijenta) + refresh token
//   (HttpOnly kolačić `ritam_refresh`, Path=/api/auth, 90 dana, rotira se pri svakom osvežavanju).

import type { Context, Hono, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { getConnInfo } from '@hono/node-server/conninfo';
import { z } from 'zod';
import type { AuthConfig, AuthResponse, AuthUser } from '../shared/types.ts';
import type { Accounts } from './accounts.ts';
import {
  PASSWORD_MAX,
  PASSWORD_MIN,
  codeMatches,
  createAttemptLimiter,
  dummyPasswordHash,
  hashPassword,
  normalizeEmail,
  verifyPassword,
} from './auth.ts';
import type { AccessTokens, SignupPolicy } from './auth.ts';
import { tx } from './db.ts';
import { HttpError, badRequest, isHttps } from './util.ts';
import { body } from './validate.ts';

export const REFRESH_COOKIE = 'ritam_refresh';
const REFRESH_COOKIE_PATH = '/api/auth';
/** Kolačić prijave iz verzije pre naloga — briše se kad ga browser još šalje. */
const LEGACY_SESSION_COOKIE = 'ritam_session';

/** Hono okruženje API-ja: id prijavljenog korisnika (postavlja Bearer middleware). */
export type ApiEnv = { Variables: { uid: number } };

export interface AuthDeps {
  accounts: Accounts;
  tokens: AccessTokens;
  signup: SignupPolicy;
  /** Kod za registraciju (SIGNUP_CODE) kad je signup 'code'; inače ''. */
  signupCode: string;
  refreshTtlSec: number;
  /**
   * Broj reverse proxy-ja ispred aplikacije kojima se veruje (env TRUST_PROXY): adresa klijenta je
   * toliki unos od kraja X-Forwarded-For. 0 = X-Forwarded-For se gleda samo sa iste mašine.
   */
  proxyHops: number;
}

/** Rute bez access tokena (sve ostale /api rute traže `Authorization: Bearer …`). */
export const PUBLIC_PATHS = new Set([
  '/api/health',
  '/api/auth/config',
  '/api/auth/register',
  '/api/auth/login',
  '/api/auth/refresh',
  '/api/auth/logout',
]);

const NOT_SIGNED_IN = 'Nisi prijavljen.';
const BAD_LOGIN = 'Pogrešan email ili lozinka.';
const CLIENT_OUTDATED =
  'Ritam je ažuriran. Osveži stranicu (ili zatvori i ponovo otvori aplikaciju), pa se prijavi email-om.';
const LOGIN_FAILURES_MAX = 10;
const REGISTER_ATTEMPTS_MAX = 10;

// ---- Adresa klijenta ----

/** Adresa sa iste mašine (lokalni reverse proxy ili razvoj). */
function isLoopback(addr: string): boolean {
  const a = addr.replace(/^::ffff:/i, '');
  return a === '::1' || /^127\.\d+\.\d+\.\d+$/.test(a);
}

/**
 * Ključ klijenta za ograničenje: IPv4 adresa, a za IPv6 mreža /64 (jedan priključak obično
 * dobija ceo /64, pa bi menjanje adrese unutar njega zaobišlo ograničenje).
 */
function addressKey(addr: string): string {
  const a = addr
    .trim()
    .toLowerCase()
    .replace(/^\[([^\]]*)\](:\d+)?$/, '$1') // [v6]:port
    .replace(/%.*$/, '') // zona (fe80::1%eth0)
    .replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '')
    .replace(/^(\d+\.\d+\.\d+\.\d+):\d+$/, '$1'); // v4:port
  if (!a.includes(':')) return a;
  const [head, tail] = a.split('::', 2);
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const zeros = tail === undefined ? [] : Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0');
  const prefix = [...left, ...zeros, ...right].slice(0, 4).map((g) => g.replace(/^0+(?=.)/, ''));
  return `${prefix.join(':')}::/64`;
}

/**
 * Adresa klijenta za ograničenje pokušaja. X-Forwarded-For može da lažira svako ko direktno pristupa
 * serveru, pa se uzima u obzir samo iza proxy-ja kome verujemo (TRUST_PROXY=n: svaki proxy dopisuje adresu
 * od koje je primio zahtev, pa je klijent n-ti unos od kraja; Caddy = 1) ili sa iste mašine (poslednji
 * unos). Kraći lanac od očekivanog (zahtev je zaobišao proxy) → adresa konekcije.
 */
function clientAddress(c: Context, proxyHops: number): string {
  let peer = 'unknown';
  try {
    peer = getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    // Nema Node socket-a (npr. app.request u testu).
  }
  const hops = proxyHops > 0 ? proxyHops : isLoopback(peer) ? 1 : 0;
  if (hops > 0) {
    const chain = (c.req.header('x-forwarded-for') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const addr = chain[chain.length - hops];
    if (addr) return addr;
  }
  return peer;
}

/** Adresa za log (bez kontrolnih znakova iz X-Forwarded-For). */
const logAddress = (addr: string) => addr.slice(0, 64).replace(/[^\w.:%[\]-]/g, '?');

/** "15 minuta", "1 minut" */
function minutesLabel(n: number): string {
  return `${n} ${n % 10 === 1 && n % 100 !== 11 ? 'minut' : 'minuta'}`;
}

function tooManyAttempts(waitMs: number): HttpError {
  const minutes = Math.max(1, Math.ceil(waitMs / 60_000));
  return new HttpError(429, `Previše pokušaja. Pokušaj ponovo za ${minutesLabel(minutes)}.`, 'rate_limited', {
    'Retry-After': String(Math.ceil(waitMs / 1000)),
  });
}

// ---- Validacija ----

const emailField = z
  .string({ error: 'Unesi ispravnu email adresu.' })
  .max(1000, { error: 'Unesi ispravnu email adresu.' });
const loginInput = z.object({
  // Bez emaila = klijent iz verzije pre naloga (slao je samo lozinku) → 400 `client_outdated` (vidi /auth/login).
  email: emailField.optional(),
  password: z.string({ error: 'Unesi lozinku.' }).max(1000, { error: BAD_LOGIN }),
});
const registerInput = z.object({
  email: emailField,
  password: z
    .string({ error: `Lozinka mora imati bar ${PASSWORD_MIN} znakova.` })
    .max(1000, { error: `Lozinka može imati najviše ${PASSWORD_MAX} znakova.` }),
  code: z.string({ error: 'Pogrešan kod za registraciju.' }).max(1000).optional(),
});
const passwordInput = z.object({
  currentPassword: z.string({ error: 'Unesi trenutnu lozinku.' }).max(1000, { error: 'Trenutna lozinka nije tačna.' }),
  newPassword: z
    .string({ error: 'Unesi novu lozinku.' })
    .max(1000, { error: `Lozinka može imati najviše ${PASSWORD_MAX} znakova.` }),
});

/** Pravila za novu lozinku (registracija, promena lozinke). */
function assertNewPassword(pw: string): void {
  if (pw.length < PASSWORD_MIN) throw badRequest(`Lozinka mora imati bar ${PASSWORD_MIN} znakova.`);
  if (pw.length > PASSWORD_MAX) throw badRequest(`Lozinka može imati najviše ${PASSWORD_MAX} znakova.`);
}

// ---- Bearer ----

/**
 * Svaka /api ruta osim PUBLIC_PATHS traži važeći access token (`Authorization: Bearer …`) → inače 401
 * `{ error: 'Nisi prijavljen.', code: 'unauthorized' | 'token_expired' }`. Postavlja `uid` u kontekst.
 */
export function bearerAuth(accounts: Accounts, tokens: AccessTokens): MiddlewareHandler<ApiEnv> {
  return async (c, next) => {
    if (PUBLIC_PATHS.has(c.req.path)) return next();
    const m = /^Bearer[ ]+([A-Za-z0-9._-]+)$/i.exec((c.req.header('authorization') ?? '').trim());
    const r = tokens.verify(m?.[1]);
    if (!r.ok) throw new HttpError(401, NOT_SIGNED_IN, r.code);
    // Token potpisan pre nego što je baza zamenjena (isti ključ) ne sme da piše redove nepostojećeg korisnika.
    if (!accounts.exists(r.uid)) throw new HttpError(401, NOT_SIGNED_IN, 'unauthorized');
    c.set('uid', r.uid);
    await next();
  };
}

// ---- Rute ----

export function registerAuthRoutes(api: Hono<ApiEnv>, deps: AuthDeps): void {
  const { accounts, tokens, signup, signupCode, refreshTtlSec, proxyHops } = deps;
  /**
   * Neuspele prijave: ključevi `ip:…` i `email:…`, po 10 u 15 min (uspela prijava se ne računa). Provere
   * trenutne lozinke: `pw:<id>` (i `email:…`).
   */
  const loginLimiter = createAttemptLimiter(LOGIN_FAILURES_MAX);
  /** Pokušaji registracije po adresi (svaki, i uspeo): 10 u 15 min — ograničava i pogađanje koda. */
  const registerLimiter = createAttemptLimiter(REGISTER_ATTEMPTS_MAX);

  const userAgent = (c: Context) => c.req.header('user-agent')?.slice(0, 300) ?? null;

  const cookieOpts = (c: Context) =>
    ({ httpOnly: true, sameSite: 'Strict', path: REFRESH_COOKIE_PATH, secure: isHttps(c) }) as const;
  const setRefreshCookie = (c: Context, token: string) =>
    setCookie(c, REFRESH_COOKIE, token, { ...cookieOpts(c), maxAge: refreshTtlSec });
  const clearRefreshCookie = (c: Context) => deleteCookie(c, REFRESH_COOKIE, cookieOpts(c));
  const clearLegacyCookie = (c: Context) => {
    if (getCookie(c, LEGACY_SESSION_COOKIE) !== undefined) {
      deleteCookie(c, LEGACY_SESSION_COOKIE, { path: '/', httpOnly: true, sameSite: 'Lax', secure: isHttps(c) });
    }
  };

  const authResponse = (user: AuthUser): AuthResponse => ({
    accessToken: tokens.sign(user.id),
    expiresIn: tokens.ttlSec,
    user: accounts.publicUser(user),
  });

  /** Nova prijava na ovom uređaju: nova familija refresh tokena + access token. */
  const startSession = (c: Context, user: AuthUser, status: 200 | 201) => {
    accounts.cleanup();
    setRefreshCookie(c, accounts.issueRefresh(user.id, undefined, userAgent(c)));
    clearLegacyCookie(c);
    return c.json(authResponse(user), status);
  };

  const unauthorized = (c: Context, code: string, clearCookie: boolean) => {
    if (clearCookie) clearRefreshCookie(c);
    return c.json({ error: NOT_SIGNED_IN, code }, 401);
  };

  api.get('/auth/config', (c) => c.json<AuthConfig>({ signup }));

  api.post('/auth/register', async (c) => {
    if (signup === 'closed') throw new HttpError(403, 'Registracija nije otvorena.', 'signup_closed');
    const input = await body(c, registerInput);
    const email = normalizeEmail(input.email);
    if (!email) throw badRequest('Unesi ispravnu email adresu.');
    assertNewPassword(input.password);

    const address = clientAddress(c, proxyHops);
    const regKey = `reg:${addressKey(address)}`;
    const wait = registerLimiter.retryAfter([regKey]);
    if (wait > 0) throw tooManyAttempts(wait);
    // Broji se pre provere (i uspeo pokušaj): istovremeni zahtevi ne zaobilaze ograničenje.
    registerLimiter.fail([regKey]);

    // Kod se proverava i za prvi nalog: nov javni server ne sme da preuzme bilo ko.
    if (signup === 'code' && !codeMatches((input.code ?? '').trim(), signupCode)) {
      console.warn(`Ritam: pogrešan kod za registraciju (adresa ${logAddress(address)}).`);
      throw new HttpError(403, 'Pogrešan kod za registraciju.', 'bad_code');
    }
    // Pre heširanja (scrypt je skup); createUser proverava ponovo u transakciji.
    if (accounts.findByEmail(email)) throw new HttpError(409, 'Nalog sa tom email adresom već postoji.');
    const passwordHash = await hashPassword(input.password);
    const { user, adopted } = accounts.createUser(email, passwordHash);
    console.log(`Ritam: nov nalog (id ${user.id})${adopted ? ' — preuzeo je postojeće podatke' : ''}.`);
    return startSession(c, user, 201);
  });

  api.post('/auth/login', async (c) => {
    const input = await body(c, loginInput);
    // Tab koji je ostao otvoren iz verzije pre naloga šalje samo lozinku aplikacije: umesto zbunjujućeg
    // "Unesi ispravnu email adresu." ispod polja Lozinka, poruka kaže da osveži stranicu.
    if (input.email === undefined) throw new HttpError(400, CLIENT_OUTDATED, 'client_outdated');
    const email = normalizeEmail(input.email);
    const address = clientAddress(c, proxyHops);
    const keys = [`ip:${addressKey(address)}`, `email:${email ?? input.email.trim().toLowerCase().slice(0, 300)}`];
    const wait = loginLimiter.retryAfter(keys);
    if (wait > 0) throw tooManyAttempts(wait);
    // Broji se pre provere (scrypt je asinhron): paralelni pokušaji ne zaobilaze ograničenje.
    const attempt = loginLimiter.fail(keys);

    const user = email ? accounts.findByEmail(email) : undefined;
    // Nepostojeći email ipak radi jednu scrypt proveru (bez razlike u vremenu odgovora).
    const ok = await verifyPassword(input.password, user?.passwordHash ?? (await dummyPasswordHash()));
    if (!user || !ok) {
      // Adresa u logu: provera da li se iza proxy-ja vidi prava adresa klijenta (README, TRUST_PROXY).
      console.warn(`Ritam: neuspela prijava (adresa ${logAddress(address)}).`);
      throw new HttpError(401, BAD_LOGIN);
    }
    // Uspela prijava nije neuspeh: poništava se samo ovaj pokušaj (adresa i globalno), pa ni više uređaja ni
    // cela kuća iza jedne adrese ne dolaze do blokade. Raniji neuspesi sa adrese ostaju (inače bi sopstveni
    // nalog služio za poništavanje ograničenja pri pogađanju tuđih). Vlasnik je dokazao lozinku: njegov email
    // više nije blokiran.
    loginLimiter.forgive([keys[0]], attempt);
    loginLimiter.reset(keys[1]);
    return startSession(c, { id: user.id, email: user.email }, 200);
  });

  api.post('/auth/refresh', (c) => {
    const token = getCookie(c, REFRESH_COOKIE);
    if (!token) return unauthorized(c, 'no_session', false);
    if (!/^[A-Za-z0-9_-]{20,200}$/.test(token)) return unauthorized(c, 'invalid_refresh', true);
    accounts.cleanup();
    const r = accounts.rotateRefresh(token, userAgent(c));
    if (!r.ok) return unauthorized(c, r.code, r.clearCookie);
    setRefreshCookie(c, r.token);
    clearLegacyCookie(c);
    return c.json(authResponse(r.user));
  });

  // Radi i bez važećeg kolačića (uvek briše kolačić na ovom uređaju).
  api.post('/auth/logout', (c) => {
    const token = getCookie(c, REFRESH_COOKIE);
    if (token) accounts.revokeByToken(token);
    clearRefreshCookie(c);
    clearLegacyCookie(c);
    return c.json({ ok: true as const });
  });

  api.get('/auth/me', (c) => {
    const user = accounts.getUser(c.get('uid'));
    if (!user) throw new HttpError(401, NOT_SIGNED_IN, 'unauthorized');
    return c.json({ user: accounts.publicUser(user) });
  });

  // Promena lozinke: odjavljuje sve uređaje (sve familije), a ovaj dobija nov par tokena.
  api.post('/auth/password', async (c) => {
    const input = await body(c, passwordInput);
    assertNewPassword(input.newPassword);
    const stored = accounts.findById(c.get('uid'));
    if (!stored) throw new HttpError(401, NOT_SIGNED_IN, 'unauthorized');
    // Ograničenje po nalogu (`pw:<id>`), ne po javnom `email:` ključu: tuđe neuspele prijave tim email-om ne
    // smeju da blokiraju promenu lozinke prijavljenom vlasniku. Neuspeh se ipak upisuje i pod `email:`, pa
    // ukradena sesija ne dobija dodatne pokušaje pogađanja pored prijave.
    const pwKey = `pw:${stored.id}`;
    const emailKey = `email:${stored.email}`;
    const wait = loginLimiter.retryAfter([pwKey]);
    if (wait > 0) throw tooManyAttempts(wait);
    const attempt = loginLimiter.fail([pwKey, emailKey]);
    if (!(await verifyPassword(input.currentPassword, stored.passwordHash))) {
      throw new HttpError(401, 'Trenutna lozinka nije tačna.', 'bad_password');
    }
    loginLimiter.forgive([], attempt);
    loginLimiter.reset(pwKey);
    loginLimiter.reset(emailKey);
    const passwordHash = await hashPassword(input.newPassword);
    const user: AuthUser = { id: stored.id, email: stored.email };
    const refresh = tx(accounts.db, () => {
      accounts.setPasswordHash(user.id, passwordHash);
      accounts.revokeAllForUser(user.id);
      return accounts.issueRefresh(user.id, undefined, userAgent(c));
    });
    setRefreshCookie(c, refresh);
    console.log(`Ritam: promenjena lozinka (nalog ${user.id}) — ostali uređaji su odjavljeni.`);
    return c.json(authResponse(user));
  });
}
