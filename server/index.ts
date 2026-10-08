// Ulaz servera: čita env, otvara bazu, pokreće HTTP server i uredno ga gasi.
//   node --disable-warning=ExperimentalWarning server/index.ts

import { existsSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { createAuth, loadSessionKey } from './auth.ts';
import { openDatabase } from './db.ts';
import { Repo } from './repo.ts';

/** Koren projekta; relativne putanje iz env-a se računaju od njega. */
const ROOT = resolve(import.meta.dirname, '..');

const env = process.env;
const port = Number(env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`Ritam: neispravan PORT "${env.PORT}".`);
  process.exit(1);
}
const password = env.APP_PASSWORD ?? '';
// Bez lozinke nema prijave, pa server podrazumevano sluša samo na ovoj mašini (ne na celoj mreži).
const host = env.HOST || (password ? '0.0.0.0' : '127.0.0.1');
const isLoopbackHost = host === 'localhost' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
// Bez lozinke i otvoren mreži (Docker postavlja HOST=0.0.0.0) = svako ko vidi server vidi i sve beleške.
// Zato se server ne pokreće — npr. kad APP_PASSWORD nedostaje ili je pogrešno napisan na Railway-u.
if (!password && !isLoopbackHost && env.ALLOW_NO_AUTH !== '1') {
  console.error(
    `Ritam: APP_PASSWORD nije postavljen, a server bi slušao na HOST=${host} — bez prijave bi svako ko vidi ` +
      'server video sve tvoje podatke. Postavi APP_PASSWORD (ili ALLOW_NO_AUTH=1 ako je to baš namerno).',
  );
  process.exit(1);
}
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
const repo = new Repo(db);
// Blok šablona ceo van logičkog dana (npr. sačuvan ranijom verzijom klijenta) bio bi skriven na traci i u
// danu: prelazi na drugi kraj dana, isto kao pri promeni dayStart. Ponovljeno pokretanje ništa ne menja.
const movedTemplateBlocks = repo.normalizeTemplateBlocks();
if (movedTemplateBlocks > 0) {
  console.log(`Ritam: blokovi šablona van logičkog dana premešteni na drugi kraj dana (${movedTemplateBlocks}).`);
}
// Bez SESSION_SECRET ključ sesije je nasumičan i čuva se uz bazu (DATA_DIR/session.key).
const auth = createAuth(password, password ? env.SESSION_SECRET || loadSessionKey(join(dataDir, 'session.key')) : '');
const app = createApp({ db, repo, auth, staticDir, proxyHops });

if (!auth.required) {
  console.warn(
    isLoopbackHost
      ? `Ritam: APP_PASSWORD nije postavljen — prijava je isključena, server sluša samo na ${host}.`
      : `Ritam: APP_PASSWORD nije postavljen — prijava je isključena (ALLOW_NO_AUTH=1), aplikaciji može pristupiti svako ko vidi server (HOST=${host}).`,
  );
}

/** Kraći prikaz putanje u logu (relativno na trenutni folder kad je moguće). */
function displayPath(p: string): string {
  const rel = relative(process.cwd(), p);
  return (rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : p).replace(/\\/g, '/');
}

const server = serve({ fetch: app.fetch, port, hostname: host }, (info) => {
  const shownHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
  const extra = staticDir ? '' : ', bez web build-a — za razvoj koristi Vite na :5173';
  console.log(
    `Ritam: http://${shownHost}:${info.port} (baza: ${displayPath(dbFile)}, prijava: ${auth.required ? 'uključena' : 'isključena'}${extra})`,
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
