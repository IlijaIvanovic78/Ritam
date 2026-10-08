// Ulaz servera: čita env, otvara bazu, pokreće HTTP server i uredno ga gasi.
//   node --disable-warning=ExperimentalWarning server/index.ts

import { existsSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { Accounts } from './accounts.ts';
import { createAccessTokens, dummyPasswordHash, loadSessionKey } from './auth.ts';
import type { SignupPolicy } from './auth.ts';
import { openDatabase } from './db.ts';
import { repoFactory } from './repo.ts';

/** Koren projekta; relativne putanje iz env-a se računaju od njega. */
const ROOT = resolve(import.meta.dirname, '..');

const env = process.env;
const port = Number(env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`Ritam: neispravan PORT "${env.PORT}".`);
  process.exit(1);
}
/** Ceo broj iz env-a u opsegu; neispravna vrednost → poruka i izlaz 1. */
function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = (env[name] ?? '').trim();
  if (raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    console.error(`Ritam: neispravan ${name} "${raw}" (ceo broj od ${min} do ${max}).`);
    process.exit(1);
  }
  return n;
}

// Registracija: SIGNUP = open | code | closed. Kod je SIGNUP_CODE, a ako nije postavljen APP_PASSWORD
// (docker-compose.yml ga uvek prosleđuje — više nije lozinka za prijavu, nego kod za registraciju).
const signupCode = env.SIGNUP_CODE || env.APP_PASSWORD || '';
const signupRaw = (env.SIGNUP ?? '').trim().toLowerCase();
let signup: SignupPolicy;
if (signupRaw === '') signup = signupCode ? 'code' : 'open';
else if (signupRaw === 'open' || signupRaw === 'code' || signupRaw === 'closed') signup = signupRaw;
else {
  console.error(`Ritam: neispravan SIGNUP "${env.SIGNUP}" (open, code ili closed).`);
  process.exit(1);
}
if (signup === 'code' && !signupCode) {
  console.error('Ritam: SIGNUP=code, a kod nije postavljen — postavi SIGNUP_CODE (ili APP_PASSWORD).');
  process.exit(1);
}
if (env.ALLOW_NO_AUTH) {
  console.warn(
    'Ritam: ALLOW_NO_AUTH se više ne koristi — prijava (nalozi) je uvek uključena; registraciju bira SIGNUP.',
  );
}
// Bez koda (i bez izričitog SIGNUP=open) registracija je otvorena, pa server podrazumevano sluša samo na ovoj
// mašini: svako na mreži bi inače mogao da napravi nalog pre vlasnika, a PRVI nalog preuzima postojeće podatke.
// Sa kodom (Docker: APP_PASSWORD) ili izričitom politikom sluša na svim adresama.
const openByDefault = signupRaw === '' && signup === 'open';
const host = env.HOST || (openByDefault ? '127.0.0.1' : '0.0.0.0');
const isLoopbackHost = host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
if (openByDefault && !isLoopbackHost) {
  console.error(
    `Ritam: nema koda za registraciju (SIGNUP_CODE ili APP_PASSWORD), a server bi slušao na HOST=${host} — svako ` +
      'ko vidi server mogao bi da napravi nalog, a prvi nalog preuzima postojeće podatke. Postavi SIGNUP_CODE (ili ' +
      'APP_PASSWORD), ili SIGNUP=open ako je otvorena registracija baš namerna.',
  );
  process.exit(1);
}
// Ključ potpisa access tokena se izvodi samo iz SESSION_SECRET: svako ko ima nalog dobija potpisan token i može
// offline da pogađa kratak (ili rečnički) SECRET, pa da lažira token za bilo koji nalog.
if (env.SESSION_SECRET && env.SESSION_SECRET.length < 32) {
  console.warn(
    'Ritam: SESSION_SECRET je prekratak (manje od 32 znaka) — ko ima nalog može offline da pogađa ključ i lažira ' +
      'tokene za druge naloge. Generiši nov sa `openssl rand -hex 32` (promena nikog ne odjavljuje).',
  );
}
// Trajanje tokena (testovi ih skraćuju; vidi README, smoke test).
const accessTtlSec = intEnv('ACCESS_TOKEN_TTL_SEC', 15 * 60, 1, 24 * 60 * 60);
const refreshTtlSec = intEnv('REFRESH_TOKEN_TTL_SEC', 90 * 24 * 60 * 60, 60, 400 * 24 * 60 * 60);
const raceGraceSec = intEnv('REFRESH_RACE_GRACE_SEC', 30, 0, 300);
// Iza reverse proxy-ja (Caddy, Railway) adresa klijenta je u X-Forwarded-For: TRUST_PROXY = broj proxy-ja.
const trustRaw = (env.TRUST_PROXY ?? '').trim().toLowerCase();
const proxyHops = trustRaw === 'true' ? 1 : trustRaw === '' || trustRaw === 'false' ? 0 : Number(trustRaw);
if (!Number.isInteger(proxyHops) || proxyHops < 0 || proxyHops > 10) {
  console.error(`Ritam: neispravan TRUST_PROXY "${env.TRUST_PROXY}" (očekuje se broj proxy-ja, npr. 1).`);
  process.exit(1);
}
const dataDir = resolve(ROOT, env.DATA_DIR || 'data');
const dbFile = join(dataDir, 'ritam.db');
const staticCandidate = resolve(ROOT, env.STATIC_DIR || 'dist/web');
const staticDir = existsSync(join(staticCandidate, 'index.html')) ? staticCandidate : null;

const db = openDatabase(dbFile);
const repos = repoFactory(db);
const accounts = new Accounts(db, { refreshTtlSec, raceGraceSec });
// Blok šablona ceo van logičkog dana (npr. sačuvan ranijom verzijom klijenta) bio bi skriven na traci i u
// danu: prelazi na drugi kraj dana, isto kao pri promeni dayStart (za svakog korisnika, po njegovom dayStart).
// Ponovljeno pokretanje ništa ne menja.
const movedTemplateBlocks = accounts.userIds().reduce((n, uid) => n + repos(uid).normalizeTemplateBlocks(), 0);
if (movedTemplateBlocks > 0) {
  console.log(`Ritam: blokovi šablona van logičkog dana premešteni na drugi kraj dana (${movedTemplateBlocks}).`);
}
const userCount = accounts.userIds().length;
const unclaimed = userCount === 0 && accounts.hasUnclaimedData();
if (unclaimed) {
  console.log('Ritam: baza ima podatke iz verzije bez naloga — prvi nalog koji se registruje ih preuzima.');
}
if (signup === 'open' && !isLoopbackHost) {
  // Ovde je SIGNUP=open izričit (podrazumevano otvorena registracija na mreži se ne pokreće, vidi gore).
  console.warn(
    `Ritam: registracija je otvorena svima (SIGNUP=open, HOST=${host}) — bilo ko ko vidi server može da napravi ` +
      'nalog. Postavi SIGNUP_CODE (ili APP_PASSWORD) da registracija traži kod, ili SIGNUP=closed kad napraviš svoje naloge.' +
      (unclaimed ? ' PAŽNJA: prvi ko napravi nalog preuzima SVE postojeće podatke — odmah napravi svoj nalog.' : ''),
  );
} else if (openByDefault) {
  console.log(
    `Ritam: nema koda za registraciju — registracija je otvorena, pa server sluša samo na ${host}. Za pristup sa ` +
      'telefona ili druge mašine postavi SIGNUP_CODE (kod za registraciju).',
  );
}
// Ključ za potpis access tokena: SESSION_SECRET ili nasumičan ključ uz bazu (DATA_DIR/session.key).
const sessionKey = env.SESSION_SECRET || loadSessionKey(join(dataDir, 'session.key'));
const tokens = createAccessTokens(sessionKey, accessTtlSec);
// Heš za prijavu sa nepostojećim emailom se pravi unapred (ni prva takva prijava ne traje duže).
void dummyPasswordHash();
const app = createApp({ db, repos, accounts, tokens, signup, signupCode, refreshTtlSec, staticDir, proxyHops });

const SIGNUP_LABEL: Record<SignupPolicy, string> = { open: 'otvorena', code: 'uz kod', closed: 'zatvorena' };

/** Kraći prikaz putanje u logu (relativno na trenutni folder kad je moguće). */
function displayPath(p: string): string {
  const rel = relative(process.cwd(), p);
  return (rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : p).replace(/\\/g, '/');
}

const server = serve({ fetch: app.fetch, port, hostname: host }, (info) => {
  const shownHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
  const extra = staticDir ? '' : ', bez web build-a — za razvoj koristi Vite na :5173';
  console.log(
    `Ritam: http://${shownHost}:${info.port} (baza: ${displayPath(dbFile)}, registracija: ${SIGNUP_LABEL[signup]}, nalozi: ${userCount}${extra})`,
  );
});

server.on('error', (err: NodeJS.ErrnoException) => {
  console.error(
    err.code === 'EADDRINUSE' ? `Ritam: port ${port} je zauzet.` : 'Ritam: server ne može da se pokrene.',
    err.code === 'EADDRINUSE' ? '' : err,
  );
  try {
    db.close();
  } catch {
    // baza je možda već zatvorena
  }
  process.exit(1);
});

// Uredno gašenje: prestani da primaš zahteve, sačekaj aktivne, zatvori bazu.
let closing = false;
function shutdown(signal: string): void {
  if (closing) return;
  closing = true;
  console.log(`Ritam: gašenje (${signal}).`);
  const closeDb = () => {
    try {
      if (db.isOpen) db.close();
    } catch (err) {
      console.error('Ritam: greška pri zatvaranju baze', err);
    }
  };
  // Ako neka konekcija visi, ne čekaj večno.
  const force = setTimeout(() => {
    closeDb();
    process.exit(1);
  }, 5000);
  force.unref();
  server.close(() => {
    clearTimeout(force);
    closeDb();
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
