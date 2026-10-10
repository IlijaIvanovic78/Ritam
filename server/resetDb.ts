// Pražnjenje baze (alat iz komandne linije): briše sve redove — naloge, prijave i sve podatke — a šema ostaje,
// pa se server posle ponaša kao posle nove instalacije. Pre brisanja pravi kopiju baze pored nje (VACUUM INTO).
// Bez --yes samo pokazuje šta bi bilo obrisano. Radi i dok server radi (WAL). README, "Pražnjenje baze".
//   npm run db:reset -- --yes
//   docker compose exec ritam node --disable-warning=ExperimentalWarning server/resetDb.ts --yes

import { existsSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_VERSION, dataPaths, fileStamp, openDatabase, tx } from './db.ts';
import { DEFAULT_SETTINGS, initEmptyDatabase } from './defaults.ts';
import { parseSettings } from './repo.ts';

/** Sve tabele šeme (osim `meta`) sa opisom za ispis, redom prikaza. */
const LABELS = {
  users: 'nalozi',
  refresh_tokens: 'prijave na uređajima',
  categories: 'kategorije',
  templates: 'šabloni',
  template_blocks: 'blokovi šablona',
  weekday_templates: 'dani u nedelji',
  days: 'dani i beleške',
  blocks: 'blokovi dana',
  tasks: 'zadaci',
} as const;

export type Table = keyof typeof LABELS;
export type RowCounts = Record<Table, number>;

export const TABLES = Object.keys(LABELS) as Table[];

/**
 * Redosled brisanja: deca pre roditelja, pa nijedan DELETE ne okida ON DELETE akcije (kaskade, SET NULL)
 * nad redovima koji se ionako brišu. Mora da sadrži sve tabele iz LABELS (test): tabela koja je samo u LABELS
 * prošla bi proveru šeme, a ostala bi puna.
 */
export const DELETE_ORDER: Table[] = [
  'blocks',
  'template_blocks',
  'tasks',
  'days',
  'weekday_templates',
  'templates',
  'categories',
  'refresh_tokens',
  'users',
];

export interface ResetOptions {
  /**
   * Nalozi ostaju (email, lozinka, jezik interfejsa); brišu se svi njihovi podaci, a podešavanja se vraćaju na
   * podrazumevana — svaki nalog je kao tek napravljen.
   */
  keepAccounts?: boolean;
  /** Uz keepAccounts: brišu se i prijave, pa se svi uređaji odjavljuju. Bez keepAccounts prijave se ionako brišu. */
  logout?: boolean;
  /**
   * `PRAGMA data_version` uzet pre kopije: ako je server posle toga nešto upisao (kopija to nema), ništa se ne
   * briše — DatabaseChangedError, pa se pravi nova kopija.
   */
  unchangedSince?: number;
}

export interface ResetResult {
  /** Obrisani redovi po tabeli (dani u nedelji se posle brisanja prave ponovo, prazni). */
  deleted: RowCounts;
  /** Nalozi koji su ostali (samo uz keepAccounts). */
  keptAccounts: number;
}

/** Druga konekcija (server) je upisala nešto posle kopije: brisanje je odbijeno, ništa nije promenjeno. */
export class DatabaseChangedError extends Error {}

/** Brojač izmena drugih konekcija (menja se kad bilo ko drugi upiše nešto u bazu). */
export function dataVersion(db: DatabaseSync): number {
  return Number(db.prepare('PRAGMA data_version').get()?.data_version);
}

function existingTables(db: DatabaseSync): string[] {
  return db
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'`)
    .all()
    .map((r) => String(r.name));
}

const isTable = (name: string): name is Table => Object.hasOwn(LABELS, name);

/**
 * Nova migracija sa novom tabelom: pražnjenje bi je ostavilo punu (a tabela možda drži podatke naloga), pa
 * se odbija dok se tabela ne doda u LABELS i DELETE_ORDER.
 */
function assertKnownSchema(db: DatabaseSync): void {
  const unknown = existingTables(db).filter((t) => t !== 'meta' && !isTable(t));
  if (unknown.length) {
    throw new Error(`baza ima tabele koje resetDb.ts ne poznaje (${unknown.join(', ')}) — dopuni LABELS i DELETE_ORDER.`);
  }
}

/** Broj redova po tabeli (tabela koje nema — starija šema — ima 0). */
export function countRows(db: DatabaseSync): RowCounts {
  const present = new Set(existingTables(db));
  const counts = {} as RowCounts;
  for (const t of TABLES) {
    counts[t] = present.has(t) ? Number(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()?.n) : 0;
  }
  return counts;
}

/**
 * Prazni bazu u jednoj transakciji. Šema i `meta.schema_version` ostaju; ostali `meta` ključevi se brišu
 * (`legacy_owner`, podešavanja za prvi nalog), pa se upisuje početno stanje kao kod nove baze
 * (initEmptyDatabase: 7 dana u nedelji bez vlasnika, podrazumevana podešavanja) — prvi nalog posle toga
 * preuzima samo to i počinje prazan, bez poruke o podacima iz verzije bez naloga.
 *
 * Brojači AUTOINCREMENT-a (users, refresh_tokens, blocks, tasks) se namerno NE vraćaju na početak: access token
 * nosi id korisnika i važi još do 15 min, pa bi nov nalog sa id-jem obrisanog bio dostupan starom tokenu, a
 * klijent bi ga smatrao istim nalogom (zadržao bi keš i draftove obrisanog). Isto važi za zastareo zahtev nad
 * id-jem obrisanog bloka ili zadatka (db.ts, migracija 2).
 *
 * secure_delete: obrisani redovi se prepisuju nulama — bez toga emailovi, heševi lozinki i beleške ostaju u
 * slobodnim stranama fajla baze (vidljivi bilo kom alatu koji čita fajl) iako ih aplikacija više ne vidi.
 */
export function resetDatabase(db: DatabaseSync, opts: ResetOptions = {}): ResetResult {
  db.exec('PRAGMA secure_delete = ON');
  return tx(db, () => {
    if (opts.unchangedSince !== undefined && dataVersion(db) !== opts.unchangedSince) {
      throw new DatabaseChangedError('baza je izmenjena posle kopije');
    }
    assertKnownSchema(db);
    const keep = new Set<Table>(opts.keepAccounts ? (opts.logout ? ['users'] : ['users', 'refresh_tokens']) : []);
    const deleted = {} as RowCounts;
    for (const t of DELETE_ORDER) {
      deleted[t] = keep.has(t) ? 0 : Number(db.prepare(`DELETE FROM ${t}`).run().changes);
    }
    db.prepare(`DELETE FROM meta WHERE key <> 'schema_version'`).run();

    const users = db.prepare('SELECT id, settings FROM users ORDER BY id').all();
    if (users.length === 0) {
      initEmptyDatabase(db);
    } else {
      // Kao nova baza kojoj je prvi nalog već napravljen: meta 'settings' ostaje podrazumevano.
      db.prepare(`INSERT INTO meta (key, value) VALUES ('settings', ?)`).run(JSON.stringify(DEFAULT_SETTINGS));
      // Svaki nalog kao tek napravljen (accounts.ts createUser): 7 dana u nedelji bez šablona, podrazumevana
      // podešavanja; jezik interfejsa je izbor naloga, ne podatak, pa ostaje.
      const setSettings = db.prepare('UPDATE users SET settings = ? WHERE id = ?');
      const insWd = db.prepare('INSERT INTO weekday_templates (user_id, weekday, template_id) VALUES (?, ?, NULL)');
      for (const u of users) {
        const lang = parseSettings(typeof u.settings === 'string' ? u.settings : null).lang;
        setSettings.run(JSON.stringify({ ...DEFAULT_SETTINGS, lang }), u.id);
        for (let wd = 1; wd <= 7; wd++) insWd.run(u.id, wd);
      }
    }
    return { deleted, keptAccounts: users.length };
  });
}

/**
 * Kopija cele baze pored nje: `ritam.db.backup-20261010-143012` (lokalno vreme). VACUUM INTO je dosledan
 * snimak i dok server radi (WAL), a kopija je samostalna baza (bez -wal fajla). Postojeći fajl se ne prepisuje.
 */
export function backupDatabase(db: DatabaseSync, file: string, now = new Date()): string {
  const base = `${file}.backup-${fileStamp(now)}`;
  let target = base;
  for (let i = 2; existsSync(target); i++) target = `${base}-${i}`;
  db.prepare('VACUUM INTO ?').run(target);
  return target;
}

/**
 * Kopija pa brisanje. VACUUM INTO ne može u transakciji, pa server može da upiše nešto između kopije i
 * brisanja: tada se kopija baca i pravi nova (najviše 3 puta), da kopija sadrži tačno ono što je obrisano.
 * Kad brisanje ne uspe (ništa nije obrisano), kopija se briše: ne ostaje fajl sa svim nalozima koji niko ne očekuje.
 */
export function backupAndReset(
  db: DatabaseSync,
  file: string,
  opts: Omit<ResetOptions, 'unchangedSince'> & { backup?: boolean },
): ResetResult & { backupFile: string | null } {
  if (opts.backup === false) return { ...resetDatabase(db, opts), backupFile: null };
  for (let attempt = 1; ; attempt++) {
    const version = dataVersion(db);
    const backupFile = backupDatabase(db, file);
    try {
      return { ...resetDatabase(db, { ...opts, unchangedSince: version }), backupFile };
    } catch (err) {
      rmSync(backupFile, { force: true });
      if (!(err instanceof DatabaseChangedError) || attempt >= 3) throw err;
    }
  }
}

// ======================= Komandna linija =======================

const USAGE = `Pražnjenje baze Ritma (README, "Pražnjenje baze").

  npm run db:reset -- [opcije]
  docker compose exec ritam node --disable-warning=ExperimentalWarning server/resetDb.ts [opcije]

Bez --yes samo pokazuje šta bi bilo obrisano (izlaz 1). Baza: DATA_DIR/ritam.db (podrazumevano ./data, u Docker-u /data).

  --yes            zaista obriši: sve naloge, prijave i sve podatke (baza kao posle nove instalacije)
  --keep-accounts  nalozi ostaju (email, lozinka, jezik), a brišu se svi njihovi podaci i podešavanja;
                   uređaji ostaju prijavljeni
  --logout         uz --keep-accounts: odjavi i sve uređaje
  --no-backup      bez kopije baze pre brisanja (podrazumevano: ritam.db.backup-<datum-vreme> pored baze)
  --help           ovo uputstvo

Izlaz: 0 = obrisano, 1 = samo proba (bez --yes), 2 = greška (ništa nije obrisano).`;

export interface CliOptions {
  yes: boolean;
  keepAccounts: boolean;
  logout: boolean;
  backup: boolean;
  help: boolean;
}

export function parseArgs(argv: string[]): CliOptions {
  const o: CliOptions = { yes: false, keepAccounts: false, logout: false, backup: true, help: false };
  for (const a of argv) {
    if (a === '--yes') o.yes = true;
    else if (a === '--keep-accounts') o.keepAccounts = true;
    else if (a === '--logout') o.logout = true;
    else if (a === '--no-backup') o.backup = false;
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`nepoznata opcija "${a}" (--help za uputstvo).`);
  }
  return o;
}

/** Tabela "opis (tabela) … broj" sa zbirom; `kept` = tabele koje ostaju. */
function formatCounts(counts: RowCounts, kept: ReadonlySet<Table> = new Set()): string[] {
  const label = (t: Table) => `${LABELS[t]} (${t})`;
  const width = Math.max(...TABLES.map((t) => label(t).length), 'ukupno'.length);
  const numWidth = Math.max(...TABLES.map((t) => String(counts[t]).length), 3);
  const line = (l: string, n: number, note = '') => `  ${l.padEnd(width)}  ${String(n).padStart(numWidth)}${note}`;
  const total = TABLES.filter((t) => !kept.has(t)).reduce((s, t) => s + counts[t], 0);
  return [...TABLES.map((t) => line(label(t), counts[t], kept.has(t) ? '  ostaje' : '')), line('ukupno', total)];
}

/** Komanda koja ponavlja ovo pokretanje sa --yes (npm, Docker ili node). */
function yesCommand(o: CliOptions, env: NodeJS.ProcessEnv): string {
  const flags = ['--yes', o.keepAccounts && '--keep-accounts', o.logout && '--logout', !o.backup && '--no-backup']
    .filter(Boolean)
    .join(' ');
  if (env.npm_lifecycle_event === 'db:reset') return `npm run db:reset -- ${flags}`;
  const node = `node --disable-warning=ExperimentalWarning server/resetDb.ts ${flags}`;
  return existsSync('/.dockerenv') ? `docker compose exec ritam ${node}` : node;
}

export interface CliIO {
  log: (line: string) => void;
  error: (line: string) => void;
  env: NodeJS.ProcessEnv;
}

/** Ceo alat; vraća izlazni kod (0 obrisano, 1 proba, 2 greška). */
export function main(argv: string[], io: CliIO = { log: console.log, error: console.error, env: process.env }): number {
  let o: CliOptions;
  try {
    o = parseArgs(argv);
  } catch (err) {
    io.error(`Ritam: ${(err as Error).message}`);
    return 2;
  }
  if (o.help) {
    io.log(USAGE);
    return 0;
  }
  const { dbFile } = dataPaths(io.env);
  io.log('Ritam — pražnjenje baze');
  io.log(`Baza: ${dbFile}`);
  if (!existsSync(dbFile)) {
    io.error(`Ritam: baza ne postoji (${dbFile}) — nema šta da se obriše. Proveri DATA_DIR.`);
    return 2;
  }
  const keptTables = new Set<Table>(o.keepAccounts ? (o.logout ? ['users'] : ['users', 'refresh_tokens']) : []);

  if (!o.yes) {
    // Samo čitanje, bez migracija: proba ništa ne menja (ni šemu starije baze).
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(dbFile, { readOnly: true, timeout: 5000 });
      const version = Number(
        existingTables(db).includes('meta')
          ? db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get()?.value
          : 0,
      );
      if (version > SCHEMA_VERSION) {
        throw new Error(`baza ima noviju verziju šeme (${version}) od ove verzije aplikacije (${SCHEMA_VERSION}).`);
      }
      assertKnownSchema(db);
      const counts = countRows(db);
      io.log('');
      io.log(o.keepAccounts ? 'Biće obrisano (nalozi ostaju):' : 'Biće obrisano:');
      for (const l of formatCounts(counts, keptTables)) io.log(l);
      io.log('');
      if (version < SCHEMA_VERSION) {
        io.log(`Baza je šeme v${version}: pre brisanja se nadograđuje na v${SCHEMA_VERSION}, kao pri pokretanju servera.`);
      }
      io.log(
        o.keepAccounts
          ? 'Posle brisanja svaki nalog je kao tek napravljen: prazan, sa podrazumevanim podešavanjima (jezik ostaje).'
          : 'Posle brisanja baza je kao posle nove instalacije: nema naloga, prvi nalog koji se registruje počinje prazan.',
      );
      io.log(o.backup ? `Pre brisanja se pravi kopija: ${dbFile}.backup-<datum-vreme>` : 'Kopija se ne pravi (--no-backup).');
      io.log('');
      io.log('Proba: ništa nije obrisano. Za brisanje pokreni:');
      io.log(`  ${yesCommand(o, io.env)}`);
      return 1;
    } catch (err) {
      io.error(`Ritam: provera baze nije uspela: ${(err as Error).message}`);
      return 2;
    } finally {
      db?.close();
    }
  }

  let db: DatabaseSync | undefined;
  try {
    db = openDatabase(dbFile);
    const r = backupAndReset(db, dbFile, { keepAccounts: o.keepAccounts, logout: o.logout, backup: o.backup });
    io.log(r.backupFile ? `Kopija pre brisanja: ${r.backupFile}` : 'Kopija nije napravljena (--no-backup).');
    io.log('');
    io.log('Obrisano:');
    // Za tabele koje ostaju prikazuje se koliko redova je ostalo.
    const remaining = countRows(db);
    const shown = { ...r.deleted };
    for (const t of keptTables) shown[t] = remaining[t];
    for (const l of formatCounts(shown, keptTables)) io.log(l);
    io.log('');
    if (o.keepAccounts && r.keptAccounts > 0) {
      io.log(
        `Gotovo: nalozi su ostali (${r.keptAccounts}) sa istim email-om i lozinkom, a svaki je prazan, sa ` +
          'podrazumevanim podešavanjima (jezik je ostao).',
      );
      io.log(
        o.logout
          ? 'Svi uređaji su odjavljeni: aplikacija traži prijavu najkasnije za 15 minuta (čim istekne access token).'
          : 'Uređaji su ostali prijavljeni: otvorenu aplikaciju (tab, PWA) osveži da ne prikazuje stare podatke.',
      );
    } else {
      io.log('Gotovo: baza je prazna, kao posle nove instalacije. Prvi nalog koji se registruje počinje prazan.');
      io.log('Svi nalozi su obrisani, pa su i svi uređaji odjavljeni (aplikacija pri sledećem zahtevu traži prijavu).');
    }
    io.log('Server ne treba restartovati: sve čita iz baze, ništa od obrisanog ne drži u memoriji.');
    if (r.backupFile) io.log('Vraćanje iz kopije: README, "Pražnjenje baze".');
    return 0;
  } catch (err) {
    io.error(`Ritam: pražnjenje baze nije uspelo, ništa nije obrisano: ${(err as Error).message}`);
    return 2;
  } finally {
    if (db?.isOpen) db.close();
  }
}

// import.meta.main postoji tek od Node 24.2 (engines dozvoljava 24.0): bez rezerve bi alat na 24.0/24.1 ništa
// ne uradio i izašao sa 0, kao da je baza obrisana.
if (import.meta.main ?? process.argv[1] === import.meta.filename) process.exitCode = main(process.argv.slice(2));
