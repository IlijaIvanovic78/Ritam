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

// Registracija: SIGNUP = open (podrazumevano: nalog pravi svako, samo email + lozinka) | closed (bez novih
// naloga) | code (nalog pravi samo ko zna SIGNUP_CODE). Kod se koristi samo uz SIGNUP=code.
const signupRaw = (env.SIGNUP ?? '').trim().toLowerCase();
let signup: SignupPolicy;
if (signupRaw === '' || signupRaw === 'open') signup = 'open';
else if (signupRaw === 'code' || signupRaw === 'closed') signup = signupRaw;
else {
  console.error(`Ritam: neispravan SIGNUP "${env.SIGNUP}" (open, closed ili code).`);
  process.exit(1);
}
// Klijent šalje kod bez razmaka na krajevima, pa ih nema ni ovde.
const signupCode = (env.SIGNUP_CODE ?? '').trim();
if (signup === 'code' && !signupCode) {
  console.error(
    'Ritam: SIGNUP=code traži kod za registraciju — postavi SIGNUP_CODE, ili ukloni SIGNUP=code (registracija je ' +
      'tada otvorena: nalog se pravi samo email-om i lozinkom).',
  );
  process.exit(1);
}
if (signupCode && signup !== 'code') {
  console.warn(
    `Ritam: SIGNUP_CODE je postavljen, ali se ne koristi (SIGNUP=${signup}) — registracija ne traži kod. ` +
      'Za registraciju uz kod postavi i SIGNUP=code.',
  );
}
// APP_PASSWORD je bio lozinka aplikacije (pre naloga), pa kod za registraciju; sada se ne čita ni za šta.
if (env.APP_PASSWORD) {
  console.log(
    'Ritam: APP_PASSWORD se više ne koristi i ignoriše se — prijava je samo nalogom (email + lozinka), a ' +
      'registraciju bira SIGNUP: SIGNUP=closed je zatvara kad napraviš svoje naloge, a SIGNUP=code uz SIGNUP_CODE ' +
      'traži kod. APP_PASSWORD možeš da obrišeš iz okruženja (.env).',
  );
}
if (env.ALLOW_NO_AUTH) {
  console.warn(
    'Ritam: ALLOW_NO_AUTH se više ne koristi — prijava (nalozi) je uvek uključena; registraciju bira SIGNUP.',
  );
}
// Bez HOST server sluša samo na ovoj mašini (npm start / npm run dev). Docker slika postavlja HOST=0.0.0.0, a
// docker-compose.yml port na serveru vezuje samo za 127.0.0.1 (spolja se ide preko Nginx-a).
const host = env.HOST || '127.0.0.1';
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
// Podaci iz verzije bez naloga čekaju vlasnika: PRVI nalog koji se registruje ih preuzima (sekcija 3 u SPEC.md).
const unclaimed = userCount === 0 && accounts.hasUnclaimedData();
if (unclaimed) {
  console.log('Ritam: baza ima podatke iz verzije bez naloga — prvi nalog koji se registruje ih preuzima.');
  if (signup === 'open') {
    console.warn(
      'Ritam: PAŽNJA — registracija je otvorena, pa SVE te podatke dobija PRVI ko napravi nalog. Odmah otvori ' +
        'aplikaciju i napravi svoj nalog ("Create account" / "Napravi nalog": email + lozinka); posle po želji ' +
        'SIGNUP=closed.',
    );
  } else if (signup === 'closed') {
    console.warn(
      'Ritam: registracija je zatvorena (SIGNUP=closed), pa te podatke niko ne može da preuzme — privremeno ukloni ' +
        'SIGNUP=closed, napravi svoj nalog, pa je ponovo zatvori.',
    );
  }
} else if (signup === 'open') {
  console.log(
    'Ritam: registracija je otvorena — nalog (email + lozinka) može da napravi svako ko otvori aplikaciju, a svaki ' +
      'nalog ima svoje podatke. Kad napraviš svoje naloge, SIGNUP=closed zatvara registraciju.',
  );
}
// Ključ za potpis access tokena: SESSION_SECRET ili nasumičan ključ uz bazu (DATA_DIR/session.key).
const sessionKey = env.SESSION_SECRET || loadSessionKey(join(dataDir, 'session.key'));
const tokens = createAccessTokens(sessionKey, accessTtlSec);
// Heš za prijavu sa nepostojećim emailom se pravi unapred (ni prva takva prijava ne traje duže).
void dummyPasswordHash();
const app = createApp({
  db,
  repos,
  accounts,
  tokens,
  signup,
  signupCode: signup === 'code' ? signupCode : '',
  refreshTtlSec,
  staticDir,
  proxyHops,
});

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
