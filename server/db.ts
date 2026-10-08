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

function migrate(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const current = readSchemaVersion(db);
  if (current > SCHEMA_VERSION) {
    throw new Error(
      `Baza ima noviju verziju šeme (${current}) od ove verzije aplikacije (${SCHEMA_VERSION}). Ažuriraj aplikaciju.`,
    );
  }
  if (current === SCHEMA_VERSION) return;

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
  migrate(db);
  return db;
}
