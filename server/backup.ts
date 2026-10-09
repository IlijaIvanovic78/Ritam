// Rezervna kopija jednog korisnika: izvoz njegovih redova (bez user_id) i uvoz koji zamenjuje SAMO njegove
// podatke, u jednoj transakciji. Uvoz dodeljuje nove id-jeve svim redovima (kategorije, šabloni, blokovi
// šablona, dani u nedelji, dani, blokovi, zadaci) i prevodi sve veze među njima, pa kopija nikad ne može da
// se sudari sa tuđim redovima ni da ih dotakne, kakve god id-jeve sadržala.

import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { Settings } from '../shared/types.ts';
import { LANGS } from '../shared/i18n.ts';
import { isValidISODate, isValidRange } from '../shared/time.ts';
import { tx } from './db.ts';
import { parseSettings } from './repo.ts';
import { HttpError, badRequest, str } from './util.ts';

/** Oblik kopije (isti kao pre naloga, pa se stare kopije uvoze bez izmena). */
export const BACKUP_VERSION = 1;

/** Kolone po tabeli (redosled ključeva u izvozu). */
const COLUMNS = {
  categories: ['id', 'name', 'color', 'counts', 'sort', 'archived'],
  templates: ['id', 'name', 'sort'],
  template_blocks: ['id', 'template_id', 'start_min', 'end_min', 'title', 'category_id'],
  weekday_templates: ['weekday', 'template_id'],
  days: ['date', 'initialized', 'template_id', 'note', 'rating', 'updated_at'],
  blocks: ['id', 'date', 'start_min', 'end_min', 'title', 'category_id', 'status', 'actual_min', 'note'],
  tasks: ['id', 'date', 'title', 'done', 'done_at', 'category_id', 'sort', 'created_at'],
} as const;

const cols = (table: keyof typeof COLUMNS, alias = '') => COLUMNS[table].map((c) => alias + c).join(', ');

/** Svi podaci korisnika `uid`, sirovi redovi (snake_case), bez user_id. */
export function exportData(db: DatabaseSync, uid: number, settings: Settings) {
  // Redovi iz node:sqlite imaju null prototip — kopiramo ih u obične objekte.
  const all = (sql: string) =>
    db
      .prepare(sql)
      .all(uid)
      .map((r) => ({ ...r }));
  return {
    app: 'ritam',
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    settings,
    categories: all(`SELECT ${cols('categories')} FROM categories WHERE user_id = ? ORDER BY id`),
    templates: all(`SELECT ${cols('templates')} FROM templates WHERE user_id = ? ORDER BY id`),
    template_blocks: all(
      `SELECT ${cols('template_blocks', 'tb.')} FROM template_blocks tb
       JOIN templates t ON t.id = tb.template_id WHERE t.user_id = ? ORDER BY tb.id`,
    ),
    weekday_templates: all(`SELECT ${cols('weekday_templates')} FROM weekday_templates WHERE user_id = ? ORDER BY weekday`),
    days: all(`SELECT ${cols('days')} FROM days WHERE user_id = ? ORDER BY date`),
    blocks: all(`SELECT ${cols('blocks')} FROM blocks WHERE user_id = ? ORDER BY id`),
    tasks: all(`SELECT ${cols('tasks')} FROM tasks WHERE user_id = ? ORDER BY id`),
  };
}

// ---- Validacija uvoza ----

const int = z.int();
const id = z.int().positive();
const ref = id.nullable();
/** 0/1 (kako izvoz čuva) ili boolean → 0/1. */
const flag01 = z.union([z.boolean(), z.literal(0), z.literal(1)]).transform((v) => (v === true || v === 1 ? 1 : 0));
const isoDate = z.string().refine(isValidISODate);
/** Isto pravilo opsega kao za blokove iz API-ja (shared/time.ts isValidRange). */
const validRange = (r: { start_min: number; end_min: number }) => isValidRange(r.start_min, r.end_min);
/**
 * Ista ograničenja kao u API-ju (api.ts): uvezen red mora kasnije moći da se izmeni
 * (npr. predugačka beleška bi se posle mogla samo zameniti novim uvozom).
 */
const text = (max: number) => z.string().trim().min(1).max(max);
const blockTitle = text(120);
const note = (max: number) => z.string().max(max);

const backupSchema = z.object({
  app: z.literal('ritam'),
  version: z.literal(BACKUP_VERSION),
  settings: z.object({
    dayStart: z.int().min(0).max(360),
    streakThreshold: z.number().min(0.1).max(1),
    // Jezik interfejsa (kopija iz verzije pre jezika ga nema; nepoznat jezik se ne uvozi) — bez njega nalog
    // zadržava svoj jezik.
    lang: z.enum(LANGS).optional().catch(undefined),
  }),
  categories: z.array(
    z.object({
      id,
      name: text(40),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      counts: flag01,
      sort: int,
      // Kopije pre arhiviranja kategorija nemaju ovu kolonu.
      archived: flag01.default(0),
    }),
  ),
  templates: z.array(z.object({ id, name: text(60), sort: int })),
  template_blocks: z.array(
    z
      .object({ id, template_id: id, start_min: int, end_min: int, title: blockTitle, category_id: ref })
      .refine(validRange),
  ),
  weekday_templates: z.array(z.object({ weekday: z.int().min(1).max(7), template_id: ref })),
  days: z.array(
    z.object({
      date: isoDate,
      initialized: flag01,
      template_id: ref,
      note: note(20000),
      rating: z.int().min(1).max(5).nullable(),
      updated_at: z.string(),
    }),
  ),
  blocks: z.array(
    z
      .object({
        id,
        date: isoDate,
        start_min: int,
        end_min: int,
        title: blockTitle,
        category_id: ref,
        status: z.enum(['pending', 'done', 'partial', 'skipped']),
        actual_min: z.int().min(0).max(1440).nullable(),
        note: note(5000),
      })
      .refine(validRange),
  ),
  tasks: z.array(
    z.object({
      id,
      date: isoDate,
      title: text(300),
      done: flag01,
      done_at: z.string().nullable(),
      category_id: ref,
      sort: int,
      created_at: z.string(),
    }),
  ),
});

type Backup = z.output<typeof backupSchema>;


function isSqliteError(err: unknown): boolean {
  return err instanceof Error && (err as { code?: string }).code === 'ERR_SQLITE_ERROR';
}

/** Redovi po rastućem id-ju: novi id-jevi zadržavaju redosled (sortiranje po id-ju kao drugi ključ). */
const byId = <T extends { id: number }>(rows: T[]): T[] => [...rows].sort((a, b) => a.id - b.id);

/** Prevod id-ja iz kopije u nov id; veza ka redu kog nema u kopiji → 400 (kao strani ključ). */
function mapper(name: string) {
  const map = new Map<number, number>();
  return {
    add(oldId: number, newId: number) {
      if (map.has(oldId)) throw badRequest('backup.duplicateId', { table: name, id: oldId });
      map.set(oldId, newId);
    },
    ref(oldId: number | null): number | null {
      if (oldId == null) return null;
      const v = map.get(oldId);
      if (v === undefined) throw badRequest('backup.mismatch');
      return v;
    },
  };
}

/**
 * Briše SVE podatke korisnika `uid` i upisuje redove iz kopije pod novim id-jevima. Sve ili ništa;
 * drugi korisnici se ne diraju. Podešavanja iz kopije postaju podešavanja korisnika.
 */
export function importData(db: DatabaseSync, uid: number, input: unknown): void {
  const parsed = backupSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? ` (${issue.path.join('.')})` : '';
    throw badRequest('backup.invalid', { where });
  }
  const data: Backup = parsed.data;

  try {
    tx(db, () => {
      // Deca pre roditelja; samo redovi ovog korisnika (blokovi šablona preko šablona).
      db.prepare('DELETE FROM blocks WHERE user_id = ?').run(uid);
      db.prepare('DELETE FROM tasks WHERE user_id = ?').run(uid);
      db.prepare('DELETE FROM days WHERE user_id = ?').run(uid);
      db.prepare('DELETE FROM weekday_templates WHERE user_id = ?').run(uid);
      db.prepare('DELETE FROM template_blocks WHERE template_id IN (SELECT id FROM templates WHERE user_id = ?)').run(uid);
      db.prepare('DELETE FROM templates WHERE user_id = ?').run(uid);
      db.prepare('DELETE FROM categories WHERE user_id = ?').run(uid);

      const insert = (sql: string, ...values: (string | number | null)[]) => Number(db.prepare(sql).run(...values).lastInsertRowid);

      const cat = mapper('categories');
      for (const r of byId(data.categories)) {
        cat.add(
          r.id,
          insert(
            'INSERT INTO categories (user_id, name, color, counts, sort, archived) VALUES (?, ?, ?, ?, ?, ?)',
            uid,
            r.name,
            r.color,
            r.counts,
            r.sort,
            r.archived,
          ),
        );
      }

      const tpl = mapper('templates');
      for (const r of byId(data.templates)) {
        tpl.add(r.id, insert('INSERT INTO templates (user_id, name, sort) VALUES (?, ?, ?)', uid, r.name, r.sort));
      }

      const tb = mapper('template_blocks');
      for (const r of byId(data.template_blocks)) {
        tb.add(
          r.id,
          insert(
            'INSERT INTO template_blocks (template_id, start_min, end_min, title, category_id) VALUES (?, ?, ?, ?, ?)',
            tpl.ref(r.template_id),
            r.start_min,
            r.end_min,
            r.title,
            cat.ref(r.category_id),
          ),
        );
      }

      // Dupli dan u nedelji ili datum → PRIMARY KEY (user_id, …) → 400 ispod.
      for (const r of data.weekday_templates) {
        insert(
          'INSERT INTO weekday_templates (user_id, weekday, template_id) VALUES (?, ?, ?)',
          uid,
          r.weekday,
          tpl.ref(r.template_id),
        );
      }

      for (const r of data.days) {
        insert(
          `INSERT INTO days (user_id, date, initialized, template_id, note, rating, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          uid,
          r.date,
          r.initialized,
          tpl.ref(r.template_id),
          r.note,
          r.rating,
          r.updated_at,
        );
      }

      // Blok čiji dan nije u kopiji → strani ključ (user_id, date) → 400 ispod.
      const blk = mapper('blocks');
      for (const r of byId(data.blocks)) {
        blk.add(
          r.id,
          insert(
            `INSERT INTO blocks (user_id, date, start_min, end_min, title, category_id, status, actual_min, note)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            uid,
            r.date,
            r.start_min,
            r.end_min,
            r.title,
            cat.ref(r.category_id),
            r.status,
            r.actual_min,
            r.note,
          ),
        );
      }

      const tsk = mapper('tasks');
      for (const r of byId(data.tasks)) {
        tsk.add(
          r.id,
          insert(
            `INSERT INTO tasks (user_id, date, title, done, done_at, category_id, sort, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            uid,
            r.date,
            r.title,
            r.done,
            r.done_at,
            cat.ref(r.category_id),
            r.sort,
            r.created_at,
          ),
        );
      }

      // Šabloni ne koriste obrisane kategorije (kao posle brisanja kroz API).
      db.prepare(
        `UPDATE template_blocks SET category_id = NULL
         WHERE category_id IN (SELECT id FROM categories WHERE user_id = ? AND archived = 1)`,
      ).run(uid);
      const row = db.prepare('SELECT settings FROM users WHERE id = ?').get(uid);
      const lang = data.settings.lang ?? parseSettings(row ? str(row.settings) : null).lang;
      const settings = { ...data.settings, lang };
      db.prepare('UPDATE users SET settings = ? WHERE id = ?').run(JSON.stringify(settings), uid);
    });
  } catch (err) {
    if (err instanceof HttpError) throw err;
    // Duplirani dani ili veze ka nepostojećim redovima.
    if (isSqliteError(err)) throw badRequest('backup.mismatch');
    throw err;
  }
}
