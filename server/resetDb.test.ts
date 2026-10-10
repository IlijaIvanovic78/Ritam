// Testovi pražnjenja baze (server/resetDb.ts): proba ništa ne menja, --yes daje stanje nove instalacije (prvi
// nalog posle toga počinje prazan, bez preuzimanja ostataka), --keep-accounts čuva naloge bez podataka, kopija
// je ispravna baza sa starim podacima (a neuspelo brisanje je ne ostavlja), obrisano ne ostaje u fajlu baze, i
// alat iz komandne linije (poseban proces). Baze su u privremenom
// folderu, nikad u ./data. `npm test`.

import { describe, test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Lang } from '../shared/types.ts';
import { Accounts } from './accounts.ts';
import { SCHEMA_VERSION, openDatabase } from './db.ts';
import { DEFAULT_SETTINGS } from './defaults.ts';
import { repoFactory } from './repo.ts';
import {
  DELETE_ORDER,
  DatabaseChangedError,
  TABLES,
  backupAndReset,
  countRows,
  dataVersion,
  main,
  resetDatabase,
} from './resetDb.ts';

const ROOT = resolve(import.meta.dirname, '..');
const DATE = '2096-03-02';
const OPTS = { refreshTtlSec: 3600, raceGraceSec: 30 };

/** Nova baza u privremenom folderu (briše se posle testa). */
function tempDb(t: TestContext): { dir: string; file: string; db: DatabaseSync } {
  const dir = mkdtempSync(join(tmpdir(), 'ritam-reset-'));
  const file = join(dir, 'ritam.db');
  const db = openDatabase(file);
  t.after(() => {
    if (db.isOpen) db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, file, db };
}

/** Nalog sa svim vrstama podataka (kategorija, šablon sa blokom, dan u nedelji, dan sa beleškom i blokom, zadatak, prijava). */
function addUserWithData(db: DatabaseSync, email: string, lang: Lang = 'en'): { id: number; refresh: string } {
  const accounts = new Accounts(db, OPTS);
  const { user } = accounts.createUser(email, 'hash-' + email, lang);
  const r = repoFactory(db)(user.id);
  r.patchSettings({ dayStart: 60, streakThreshold: 0.5 });
  r.addCategory({ name: 'Work', color: '#2f6db5', counts: true });
  const cat = r.listCategories()[0].id;
  const tpl = r.addTemplate('Workday', null);
  r.putTemplateBlocks(tpl, [{ start: 480, end: 720, title: 'Work', categoryId: cat }]);
  r.putWeekdays({ 1: tpl, 2: tpl });
  r.initDay(DATE, tpl);
  r.addBlock(DATE, { start: 720, end: 780, title: 'Lunch', categoryId: null });
  r.patchDay(DATE, { note: 'beleška', rating: 4 });
  r.addTask(DATE, 'Zadatak', cat);
  return { id: user.id, refresh: accounts.issueRefresh(user.id) };
}

/** Svi redovi svih tabela (bez sqlite_sequence), kao obični objekti — za poređenje celog stanja. */
function dump(db: DatabaseSync): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name`)
    .all();
  for (const { name } of tables) {
    out[String(name)] = db
      .prepare(`SELECT * FROM ${String(name)} ORDER BY 1, 2`)
      .all()
      .map((r) => ({ ...r }));
  }
  return out;
}

const meta = (db: DatabaseSync) =>
  Object.fromEntries(db.prepare('SELECT key, value FROM meta ORDER BY key').all().map((r) => [String(r.key), r.value]));

/** CLI u istom procesu (DATA_DIR = privremeni folder). */
function runMain(dir: string, args: string[]): { code: number; out: string; err: string } {
  const out: string[] = [];
  const err: string[] = [];
  const code = main(args, { log: (l) => out.push(l), error: (l) => err.push(l), env: { DATA_DIR: dir } });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('pražnjenje baze (resetDb.ts)', () => {
  test('proba (bez --yes): ništa se ne menja, ispis ima broj redova po tabeli, izlaz 1', (t) => {
    const { dir, db } = tempDb(t);
    addUserWithData(db, 'a@example.test');
    addUserWithData(db, 'b@example.test');
    const before = dump(db);
    // Konekcija testa ostaje otvorena (kao server koji radi).
    const r = runMain(dir, []);
    assert.equal(r.code, 1, r.err);
    assert.deepEqual(dump(db), before);
    assert.match(r.out, /nalozi \(users\)\s+2/);
    assert.match(r.out, /zadaci \(tasks\)\s+2/);
    assert.match(r.out, /Proba: ništa nije obrisano/);
    assert.match(r.out, /server\/resetDb\.ts --yes/);
    assert.deepEqual(readdirSync(dir).filter((f) => f.includes('backup')), [], 'proba ne pravi kopiju');
    // I sa --keep-accounts: nalozi su označeni kao "ostaje".
    const k = runMain(dir, ['--keep-accounts']);
    assert.equal(k.code, 1);
    assert.match(k.out, /nalozi \(users\)\s+2\s+ostaje/);
    assert.match(k.out, /--yes --keep-accounts/);
    assert.deepEqual(dump(db), before);
  });

  test('--yes: baza je kao nova instalacija; prvi nalog posle toga počinje prazan i ne preuzima ništa', (t) => {
    const { db } = tempDb(t);
    const a = addUserWithData(db, 'a@example.test', 'sr');
    const b = addUserWithData(db, 'b@example.test');
    const before = countRows(db);

    const r = resetDatabase(db);
    assert.deepEqual(r.deleted, before);
    assert.equal(r.keptAccounts, 0);

    // Isto stanje kao baza tek napravljena (7 dana u nedelji bez vlasnika, podrazumevana podešavanja, verzija šeme).
    const fresh = openDatabase(':memory:');
    assert.deepEqual(dump(db), dump(fresh));
    fresh.close();
    assert.deepEqual(meta(db), { schema_version: String(SCHEMA_VERSION), settings: JSON.stringify(DEFAULT_SETTINGS) });

    const accounts = new Accounts(db, OPTS);
    assert.equal(accounts.exists(a.id), false);
    assert.equal(accounts.hasUnclaimedData(), false);
    // Prijava sa obrisanog naloga ne važi.
    assert.equal(accounts.rotateRefresh(a.refresh, null).ok, false);

    const { user, adopted } = accounts.createUser('a@example.test', 'novi', 'en');
    assert.equal(adopted, false);
    assert.equal(accounts.legacyOwnerId(), null);
    assert.equal(accounts.publicUser(user).legacyOwner, undefined);
    // Id-jevi se ne dodeljuju ponovo: stari access token (id obrisanog naloga) ne otvara nov nalog.
    assert.ok(user.id > Math.max(a.id, b.id));
    const repo = repoFactory(db)(user.id);
    assert.deepEqual(repo.getSettings(), { ...DEFAULT_SETTINGS, lang: 'en' });
    assert.deepEqual(repo.listCategories(), []);
    assert.deepEqual(repo.listTemplates(), []);
    assert.deepEqual(repo.weekdays(), { 1: null, 2: null, 3: null, 4: null, 5: null, 6: null, 7: null });
    const day = repo.dayPayload(DATE);
    assert.equal(day.initialized, false);
    assert.deepEqual(day.blocks, []);
    assert.deepEqual(day.tasks, []);
    assert.equal(day.note, '');
    // Nov blok ne dobija id obrisanog.
    repo.initDay(DATE, null);
    repo.addBlock(DATE, { start: 60, end: 120, title: 'X', categoryId: null });
    const oldMaxBlock = 2 * 2; // dva naloga × (blok iz šablona + ručni blok)
    assert.ok(repo.blocksForDate(DATE)[0].id > oldMaxBlock);
  });

  test('podaci iz verzije bez naloga (user_id 0) se brišu: niko ih posle ne preuzima', (t) => {
    const { db } = tempDb(t);
    db.prepare(`INSERT INTO categories (name, color, user_id) VALUES ('Old', '#000000', 0)`).run();
    db.prepare(`INSERT INTO days (user_id, date, note, updated_at) VALUES (0, ?, 'stara beleška', '2020-01-01T00:00:00Z')`).run(DATE);
    db.prepare(`INSERT INTO tasks (user_id, date, title, created_at) VALUES (0, ?, 'stari zadatak', '2020-01-01T00:00:00Z')`).run(DATE);
    db.prepare(`UPDATE meta SET value = ? WHERE key = 'settings'`).run(JSON.stringify({ dayStart: 120, streakThreshold: 0.5 }));
    const accounts = new Accounts(db, OPTS);
    assert.equal(accounts.hasUnclaimedData(), true);

    resetDatabase(db);
    assert.equal(accounts.hasUnclaimedData(), false);
    const { user, adopted } = accounts.createUser('a@example.test', 'x', 'sr');
    assert.equal(adopted, false);
    assert.equal(accounts.legacyOwnerId(), null);
    const repo = repoFactory(db)(user.id);
    assert.deepEqual(repo.getSettings(), { ...DEFAULT_SETTINGS, lang: 'sr' });
    assert.deepEqual(repo.allCategories(), []);
    assert.equal(repo.dayPayload(DATE).note, '');
  });

  test('meta legacy_owner (nalog koji je preuzeo stare podatke) se briše', (t) => {
    const { db } = tempDb(t);
    db.prepare(`INSERT INTO tasks (user_id, date, title, created_at) VALUES (0, ?, 'stari', '2020-01-01T00:00:00Z')`).run(DATE);
    const accounts = new Accounts(db, OPTS);
    const { user, adopted } = accounts.createUser('a@example.test', 'x', 'en');
    assert.equal(adopted, true);
    assert.equal(accounts.legacyOwnerId(), user.id);
    resetDatabase(db, { keepAccounts: true });
    assert.equal(accounts.legacyOwnerId(), null);
    assert.equal(accounts.publicUser(user).legacyOwner, undefined);
  });

  test('--keep-accounts: nalozi i prijave ostaju, podaci i podešavanja ne (jezik ostaje)', (t) => {
    const { db } = tempDb(t);
    const a = addUserWithData(db, 'a@example.test', 'sr');
    const b = addUserWithData(db, 'b@example.test');
    const usersBefore = dump(db).users as Record<string, unknown>[];
    const before = countRows(db);

    const r = resetDatabase(db, { keepAccounts: true });
    assert.equal(r.keptAccounts, 2);
    assert.equal(r.deleted.users, 0);
    assert.equal(r.deleted.refresh_tokens, 0);
    assert.equal(r.deleted.tasks, before.tasks);

    const after = countRows(db);
    assert.equal(after.users, 2);
    assert.equal(after.refresh_tokens, 2);
    for (const tbl of ['categories', 'templates', 'template_blocks', 'days', 'blocks', 'tasks'] as const) {
      assert.equal(after[tbl], 0, tbl);
    }
    // 7 dana u nedelji bez šablona po nalogu, kao nalog tek napravljen; nema redova bez vlasnika.
    assert.equal(after.weekday_templates, 14);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM weekday_templates WHERE user_id = 0 OR template_id IS NOT NULL').get()?.n, 0);
    assert.deepEqual(meta(db), { schema_version: String(SCHEMA_VERSION), settings: JSON.stringify(DEFAULT_SETTINGS) });

    // Email, lozinka i datum naloga su isti; podešavanja podrazumevana uz jezik naloga.
    const usersAfter = dump(db).users as Record<string, unknown>[];
    assert.deepEqual(
      usersAfter.map((u) => [u.id, u.email, u.password_hash, u.created_at]),
      usersBefore.map((u) => [u.id, u.email, u.password_hash, u.created_at]),
    );
    const repos = repoFactory(db);
    assert.deepEqual(repos(a.id).getSettings(), { ...DEFAULT_SETTINGS, lang: 'sr' });
    assert.deepEqual(repos(b.id).getSettings(), { ...DEFAULT_SETTINGS, lang: 'en' });
    assert.deepEqual(repos(a.id).weekdays(), { 1: null, 2: null, 3: null, 4: null, 5: null, 6: null, 7: null });
    assert.deepEqual(repos(a.id).dayPayload(DATE).blocks, []);

    // Prijava ostaje (uređaj ostaje prijavljen), a nalog normalno pravi nove podatke.
    const accounts = new Accounts(db, OPTS);
    assert.equal(accounts.rotateRefresh(a.refresh, null).ok, true);
    repos(a.id).addCategory({ name: 'Nova', color: '#123456', counts: true });
    assert.equal(repos(a.id).listCategories().length, 1);
    assert.equal(repos(b.id).listCategories().length, 0);
  });

  test('--keep-accounts --logout: brišu se i prijave', (t) => {
    const { db } = tempDb(t);
    const a = addUserWithData(db, 'a@example.test');
    const r = resetDatabase(db, { keepAccounts: true, logout: true });
    assert.equal(r.deleted.refresh_tokens, 1);
    assert.equal(countRows(db).users, 1);
    assert.equal(countRows(db).refresh_tokens, 0);
    assert.equal(new Accounts(db, OPTS).rotateRefresh(a.refresh, null).ok, false);
  });

  test('kopija pre brisanja je ispravna baza sa starim podacima', (t) => {
    const { dir, file, db } = tempDb(t);
    addUserWithData(db, 'a@example.test');
    const before = dump(db);

    const r = backupAndReset(db, file, {});
    assert.ok(r.backupFile);
    assert.equal(r.backupFile.startsWith(join(dir, 'ritam.db.backup-')), true);
    assert.match(r.backupFile, /ritam\.db\.backup-\d{8}-\d{6}$/);
    assert.equal(countRows(db).users, 0);

    const copy = new DatabaseSync(r.backupFile, { readOnly: true });
    try {
      assert.equal(copy.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
      assert.deepEqual(dump(copy), before);
    } finally {
      copy.close();
    }
    // Vraćena kopija se otvara kao obična baza (iste verzije šeme, bez migracije).
    const restored = openDatabase(r.backupFile);
    try {
      assert.equal(countRows(restored).users, 1);
    } finally {
      restored.close();
    }
    // Druga kopija u istoj sekundi ne prepisuje prvu.
    const r2 = backupAndReset(db, file, {});
    assert.notEqual(r2.backupFile, r.backupFile);
    // --no-backup: bez kopije.
    assert.equal(backupAndReset(db, file, { backup: false }).backupFile, null);
  });

  test('upis druge konekcije posle kopije: brisanje je odbijeno, ništa se ne menja', (t) => {
    const { file, db } = tempDb(t);
    addUserWithData(db, 'a@example.test');
    const server = openDatabase(file);
    try {
      const version = dataVersion(db);
      server
        .prepare(`INSERT INTO tasks (user_id, date, title, created_at) VALUES (1, ?, 'posle kopije', ?)`)
        .run(DATE, new Date().toISOString());
      const before = dump(db);
      assert.throws(() => resetDatabase(db, { unchangedSince: version }), DatabaseChangedError);
      assert.deepEqual(dump(db), before);
      assert.equal(db.isTransaction, false);
      // Bez upisa u međuvremenu prolazi.
      resetDatabase(db, { unchangedSince: dataVersion(db) });
      assert.equal(countRows(server).tasks, 0);
    } finally {
      server.close();
    }
  });

  test('tabela koju alat ne poznaje (nova migracija): ništa se ne briše', (t) => {
    const { db } = tempDb(t);
    addUserWithData(db, 'a@example.test');
    db.exec('CREATE TABLE something_new (id INTEGER PRIMARY KEY, user_id INTEGER)');
    const before = dump(db);
    assert.throws(() => resetDatabase(db), /something_new/);
    assert.deepEqual(dump(db), before);
  });

  test('svaka tabela šeme je poznata alatu i briše se (LABELS i DELETE_ORDER u resetDb.ts)', () => {
    const db = openDatabase(':memory:');
    const tables = Object.keys(dump(db)).filter((n) => n !== 'meta');
    assert.deepEqual([...tables].sort(), [...TABLES].sort());
    assert.deepEqual([...DELETE_ORDER].sort(), [...TABLES].sort());
    db.close();
  });

  test('obrisani podaci ne ostaju u fajlu baze (secure_delete), ni bez kopije', (t) => {
    const { dir, file, db } = tempDb(t);
    addUserWithData(db, 'secret-person@example.test');
    db.close();
    const r = runMain(dir, ['--yes', '--no-backup']);
    assert.equal(r.code, 0, r.err);
    // Server je zatvoren: posle zatvaranja poslednje konekcije sve je u fajlu baze (WAL je prenet i obrisan).
    const bytes = readFileSync(file).toString('latin1');
    assert.equal(existsSync(file + '-wal'), false);
    assert.equal(bytes.includes('secret-person@example.test'), false, 'email obrisanog naloga');
    assert.equal(bytes.includes('hash-secret-person'), false, 'heš lozinke obrisanog naloga');
  });

  test('neuspelo brisanje (npr. nepoznata tabela) ne ostavlja kopiju', (t) => {
    const { dir, file, db } = tempDb(t);
    addUserWithData(db, 'a@example.test');
    db.exec('CREATE TABLE something_new (id INTEGER PRIMARY KEY)');
    assert.throws(() => backupAndReset(db, file, {}), /something_new/);
    assert.deepEqual(readdirSync(dir).filter((f) => f.includes('backup')), []);
    assert.equal(countRows(db).users, 1);
  });

  test('komandna linija (poseban proces): proba, --yes, nepoznata opcija, baza ne postoji', (t) => {
    const { dir, file, db } = tempDb(t);
    addUserWithData(db, 'a@example.test');
    db.close();
    const run = (args: string[], dataDir = dir) =>
      spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/resetDb.ts', ...args], {
        cwd: ROOT,
        env: { ...process.env, DATA_DIR: dataDir, npm_lifecycle_event: '' },
        encoding: 'utf8',
      });

    const dry = run([]);
    assert.equal(dry.status, 1, dry.stderr);
    assert.match(dry.stdout, /Proba: ništa nije obrisano/);

    const yes = run(['--yes']);
    assert.equal(yes.status, 0, yes.stderr);
    assert.match(yes.stdout, /Kopija pre brisanja: .*ritam\.db\.backup-\d{8}-\d{6}/);
    assert.match(yes.stdout, /Gotovo: baza je prazna/);
    const check = openDatabase(file);
    const counts = countRows(check);
    check.close();
    assert.equal(counts.users, 0);
    assert.equal(counts.tasks, 0);
    assert.equal(counts.weekday_templates, 7);

    const bad = run(['--yse']);
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /nepoznata opcija "--yse"/);

    const missing = run(['--yes'], join(dir, 'nema'));
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /baza ne postoji/);
    assert.equal(existsSync(join(dir, 'nema')), false, 'alat ne pravi novu bazu');
  });
});
