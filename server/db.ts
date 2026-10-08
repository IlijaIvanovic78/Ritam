// Otvaranje SQLite baze (node:sqlite), migracije i pomoćnik za transakcije.

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { StatementSync } from 'node:sqlite';
import { initEmptyDatabase } from './defaults.ts';

export type { DatabaseSync };

/**
 * Migracije redom; indeks + 1 = verzija šeme posle primene.
 * Tabela `meta` se pravi pre migracija jer u njoj čuvamo verziju.
 */
const MIGRATIONS: string[] = [
  // 1 — početna šema
  `
  CREATE TABLE categories (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    color TEXT NOT NULL,
    counts INTEGER NOT NULL DEFAULT 1,
    sort INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE templates (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    sort INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE template_blocks (
    id INTEGER PRIMARY KEY,
    template_id INTEGER NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
    start_min INTEGER NOT NULL,
    end_min INTEGER NOT NULL,
    title TEXT NOT NULL,
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL
  );
  CREATE INDEX template_blocks_template ON template_blocks(template_id);

  CREATE TABLE weekday_templates (
    weekday INTEGER PRIMARY KEY CHECK (weekday BETWEEN 1 AND 7),
    template_id INTEGER REFERENCES templates(id) ON DELETE SET NULL
  );

  CREATE TABLE days (
    date TEXT PRIMARY KEY,
    initialized INTEGER NOT NULL DEFAULT 0,
    template_id INTEGER REFERENCES templates(id) ON DELETE SET NULL,
    note TEXT NOT NULL DEFAULT '',
    rating INTEGER CHECK (rating BETWEEN 1 AND 5),
    updated_at TEXT NOT NULL
  );

  CREATE TABLE blocks (
    id INTEGER PRIMARY KEY,
    date TEXT NOT NULL REFERENCES days(date) ON DELETE CASCADE,
    start_min INTEGER NOT NULL,
    end_min INTEGER NOT NULL,
    title TEXT NOT NULL,
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','partial','skipped')),
    actual_min INTEGER,
    note TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX blocks_date ON blocks(date);

  CREATE TABLE tasks (
    id INTEGER PRIMARY KEY,
    date TEXT NOT NULL,
    title TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    done_at TEXT,
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    sort INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX tasks_date ON tasks(date);
  CREATE INDEX tasks_open ON tasks(done, date);
  `,

  // 2 — blokovi i zadaci sa AUTOINCREMENT: id obrisanog reda se nikad ne dodeljuje ponovo, pa
  // zastareo zahtev sa drugog uređaja (npr. čekiranje obrisanog zadatka) ne menja tuđi red.
  // Samo ove dve tabele: nijedna tabela ih ne referencira, pa DROP TABLE ne okida
  // ON DELETE akcije (za categories/templates bi obrisao ili poništio veze).
  `
  CREATE TABLE blocks_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL REFERENCES days(date) ON DELETE CASCADE,
    start_min INTEGER NOT NULL,
    end_min INTEGER NOT NULL,
    title TEXT NOT NULL,
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','partial','skipped')),
    actual_min INTEGER,
    note TEXT NOT NULL DEFAULT ''
  );
  INSERT INTO blocks_new (id, date, start_min, end_min, title, category_id, status, actual_min, note)
    SELECT id, date, start_min, end_min, title, category_id, status, actual_min, note FROM blocks;
  DROP TABLE blocks;
  ALTER TABLE blocks_new RENAME TO blocks;
  CREATE INDEX blocks_date ON blocks(date);

  CREATE TABLE tasks_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    title TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    done_at TEXT,
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    sort INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  INSERT INTO tasks_new (id, date, title, done, done_at, category_id, sort, created_at)
    SELECT id, date, title, done, done_at, category_id, sort, created_at FROM tasks;
  DROP TABLE tasks;
  ALTER TABLE tasks_new RENAME TO tasks;
  CREATE INDEX tasks_date ON tasks(date);
  CREATE INDEX tasks_open ON tasks(done, date);
  `,

  // 3 — obrisana kategorija ostaje kao arhivirana: sačuvani blokovi i zadaci je zadržavaju, pa se
  // raniji dani (ispunjenost, niz) ne preračunavaju, a njen id se ne dodeljuje novoj kategoriji.
  `
  ALTER TABLE categories ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
  `,

  // 4 — nalozi: svaki red podataka pripada korisniku (user_id). Postojeći redovi dobijaju user_id = 0
  // ("bez vlasnika"); prvi napravljeni nalog ih preuzima (accounts.ts). user_id nema strani ključ ka
  // users (0 nije korisnik) — vlasništvo proverava kod. Blokovi šablona pripadaju korisniku preko šablona.
  //
  // Strani ključevi kao u migraciji 2: DROP TABLE se radi samo nad tabelom koju u tom trenutku niko ne
  // referencira (DROP sa uključenim stranim ključevima radi implicitni DELETE i okinuo bi ON DELETE akcije).
  // Zato se `blocks` pravi ponovo PRE brisanja stare `days`: nova tabela blokova referencira `days_new`, a
  // RENAME `days_new` → `days` prepravlja i tu referencu. Brojač AUTOINCREMENT-a za blokove se prenosi
  // (id obrisanog bloka se ni posle ove migracije ne dodeljuje ponovo).
  `
  ALTER TABLE categories ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE templates ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE tasks ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX categories_user ON categories(user_id);
  CREATE INDEX templates_user ON templates(user_id);
  DROP INDEX tasks_date;
  DROP INDEX tasks_open;
  CREATE INDEX tasks_user_date ON tasks(user_id, date);
  CREATE INDEX tasks_user_open ON tasks(user_id, done, date);

  CREATE TABLE weekday_templates_new (
    user_id INTEGER NOT NULL DEFAULT 0,
    weekday INTEGER NOT NULL CHECK (weekday BETWEEN 1 AND 7),
    template_id INTEGER REFERENCES templates(id) ON DELETE SET NULL,
    PRIMARY KEY (user_id, weekday)
  );
  INSERT INTO weekday_templates_new (user_id, weekday, template_id)
    SELECT 0, weekday, template_id FROM weekday_templates;
  DROP TABLE weekday_templates;
  ALTER TABLE weekday_templates_new RENAME TO weekday_templates;

  CREATE TABLE days_new (
    user_id INTEGER NOT NULL DEFAULT 0,
    date TEXT NOT NULL,
    initialized INTEGER NOT NULL DEFAULT 0,
    template_id INTEGER REFERENCES templates(id) ON DELETE SET NULL,
    note TEXT NOT NULL DEFAULT '',
    rating INTEGER CHECK (rating BETWEEN 1 AND 5),
    updated_at TEXT NOT NULL,
    PRIMARY KEY (user_id, date)
  );
  INSERT INTO days_new (user_id, date, initialized, template_id, note, rating, updated_at)
    SELECT 0, date, initialized, template_id, note, rating, updated_at FROM days;
  -- Samo odbrana: blok bez reda dana (ne bi trebalo da postoji) ne sme da obori migraciju ni da nestane.
  INSERT OR IGNORE INTO days_new (user_id, date, initialized, updated_at)
    SELECT DISTINCT 0, date, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM blocks;

  -- ON UPDATE CASCADE: preuzimanje podataka (user_id 0 → prvi nalog) menja ključ dana zajedno sa blokovima.
  CREATE TABLE blocks_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL DEFAULT 0,
    date TEXT NOT NULL,
    start_min INTEGER NOT NULL,
    end_min INTEGER NOT NULL,
    title TEXT NOT NULL,
    category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','partial','skipped')),
    actual_min INTEGER,
    note TEXT NOT NULL DEFAULT '',
    FOREIGN KEY (user_id, date) REFERENCES days_new(user_id, date) ON DELETE CASCADE ON UPDATE CASCADE
  );
  INSERT INTO blocks_new (id, user_id, date, start_min, end_min, title, category_id, status, actual_min, note)
    SELECT id, 0, date, start_min, end_min, title, category_id, status, actual_min, note FROM blocks;
  UPDATE sqlite_sequence SET seq = (SELECT seq FROM sqlite_sequence WHERE name = 'blocks')
    WHERE name = 'blocks_new' AND seq < (SELECT seq FROM sqlite_sequence WHERE name = 'blocks');
  INSERT INTO sqlite_sequence (name, seq)
    SELECT 'blocks_new', seq FROM sqlite_sequence
    WHERE name = 'blocks' AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'blocks_new');
  DROP TABLE blocks;
  DROP TABLE days;
  ALTER TABLE days_new RENAME TO days;
  ALTER TABLE blocks_new RENAME TO blocks;
  CREATE INDEX blocks_user_date ON blocks(user_id, date);

  -- AUTOINCREMENT: id nikad ne pripada ranijem korisniku (access token nosi id korisnika).
  CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    settings TEXT NOT NULL DEFAULT '{"dayStart":0,"streakThreshold":0.7}',
    created_at TEXT NOT NULL
  );

  -- Refresh token se čuva samo kao SHA-256 heš. family = jedna prijava na jednom uređaju (rotacija je u istoj familiji).
  CREATE TABLE refresh_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    family TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    user_agent TEXT
  );
  CREATE INDEX refresh_tokens_user ON refresh_tokens(user_id);
  CREATE INDEX refresh_tokens_family ON refresh_tokens(family);
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/**
 * Pokreće `fn` u transakciji (BEGIN IMMEDIATE … COMMIT, ROLLBACK na grešku).
 * `fn` mora biti sinhrona — node:sqlite je sinhron, pa nema preplitanja zahteva.
 * Ugnežđeni poziv samo izvrši `fn` u već otvorenoj transakciji.
 */
export function tx<T>(db: DatabaseSync, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw err;
  }
}

/** Keš pripremljenih upita po SQL tekstu (jedna konekcija, jedan proces). */
export function statementCache(db: DatabaseSync): (sql: string) => StatementSync {
  const cache = new Map<string, StatementSync>();
  return (sql) => {
    let st = cache.get(sql);
    if (!st) {
      st = db.prepare(sql);
      cache.set(sql, st);
    }
    return st;
  };
}

function readSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get();
  return row ? Number(row.value) || 0 : 0;
}

/** `20261008-153012` (lokalno vreme) za ime kopije baze. */
function fileStamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * Kopija postojeće baze pre migracije (`<baza>.pre-v<N>-<vreme>.bak`, VACUUM INTO = dosledan snimak, i sa WAL-om):
 * prethodna verzija aplikacije ne otvara bazu novije šeme, pa je ovo put nazad posle nadogradnje (README
 * "Nadogradnja"). Neuspeh (npr. pun disk) samo upozorava — migracija je ionako u transakciji.
 */
function backupBeforeMigration(db: DatabaseSync, file: string, version: number): void {
  const target = `${file}.pre-v${version}-${fileStamp()}.bak`;
  try {
    db.prepare('VACUUM INTO ?').run(target);
    console.log(`Ritam: kopija baze pre nadogradnje šeme (v${version} → v${SCHEMA_VERSION}): ${target}`);
  } catch (err) {
    console.warn(`Ritam: kopija baze pre nadogradnje šeme nije napravljena (${target}):`, (err as Error).message);
  }
}

function migrate(db: DatabaseSync, file: string): void {
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const current = readSchemaVersion(db);
  if (current > SCHEMA_VERSION) {
    throw new Error(
      `Baza ima noviju verziju šeme (${current}) od ove verzije aplikacije (${SCHEMA_VERSION}). Ažuriraj aplikaciju.`,
    );
  }
  if (current === SCHEMA_VERSION) return;
  if (current > 0) backupBeforeMigration(db, file, current);

  tx(db, () => {
    for (let v = current; v < SCHEMA_VERSION; v++) db.exec(MIGRATIONS[v]);
    db.prepare(
      `INSERT INTO meta (key, value) VALUES ('schema_version', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(String(SCHEMA_VERSION));
    // Nova baza počinje prazna (bez kategorija i šablona; korisnik sve pravi sam).
    // Postojeća baza (current > 0) dobija samo nove migracije — njeni podaci se ne diraju.
    if (current === 0) initEmptyDatabase(db);
  });
}

/** Otvara (i po potrebi pravi) bazu, postavlja pragme i primenjuje migracije. */
export function openDatabase(file: string): DatabaseSync {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file, { timeout: 5000, enableForeignKeyConstraints: true });
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db, file);
  return db;
}
