// Rezervna kopija: izvoz svih tabela kao sirovih redova i uvoz (zamena svega)
// u jednoj transakciji.

import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { Settings } from '../shared/types.ts';
import { isValidISODate, isValidRange } from '../shared/time.ts';
import { tx } from './db.ts';
import { HttpError, badRequest } from './util.ts';

/** Tabele redom kojim se upisuju (roditelji pre dece zbog stranih ključeva). */
const TABLES = [
  { name: 'categories', order: 'id', columns: ['id', 'name', 'color', 'counts', 'sort', 'archived'] },
  { name: 'templates', order: 'id', columns: ['id', 'name', 'sort'] },
  {
    name: 'template_blocks',
    order: 'id',
    columns: ['id', 'template_id', 'start_min', 'end_min', 'title', 'category_id'],
  },
  { name: 'weekday_templates', order: 'weekday', columns: ['weekday', 'template_id'] },
  { name: 'days', order: 'date', columns: ['date', 'initialized', 'template_id', 'note', 'rating', 'updated_at'] },
  {
    name: 'blocks',
    order: 'id',
    columns: ['id', 'date', 'start_min', 'end_min', 'title', 'category_id', 'status', 'actual_min', 'note'],
  },
  {
    name: 'tasks',
    order: 'id',
    columns: ['id', 'date', 'title', 'done', 'done_at', 'category_id', 'sort', 'created_at'],
  },
] as const;

type TableName = (typeof TABLES)[number]['name'];

export function exportData(db: DatabaseSync, settings: Settings) {
  const out: Record<string, unknown> = {
    app: 'ritam',
    version: 1,
    exportedAt: new Date().toISOString(),
    settings,
  };
  for (const t of TABLES) {
    // Redovi iz node:sqlite imaju null prototip — kopiramo ih u obične objekte.
    out[t.name] = db
      .prepare(`SELECT ${t.columns.join(', ')} FROM ${t.name} ORDER BY ${t.order}`)
      .all()
      .map((r) => ({ ...r }));
  }
  return out;
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
  version: z.literal(1),
  settings: z.object({
    dayStart: z.int().min(0).max(360),
    streakThreshold: z.number().min(0.1).max(1),
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

/** Briše sve podatke i upisuje redove iz kopije. Sve ili ništa. */
export function importData(db: DatabaseSync, input: unknown): void {
  const parsed = backupSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? ` (${issue.path.join('.')})` : '';
    throw badRequest(`Kopija nije ispravna${where}.`);
  }
  const data: Backup = parsed.data;

  try {
    tx(db, () => {
      // Deca pre roditelja.
      for (const t of [...TABLES].reverse()) db.exec(`DELETE FROM ${t.name}`);
      for (const t of TABLES) {
        const cols = t.columns as readonly string[];
        const ins = db.prepare(
          `INSERT INTO ${t.name} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`,
        );
        const rows = data[t.name as TableName] as Record<string, string | number | null>[];
        for (const row of rows) ins.run(...cols.map((c) => row[c] ?? null));
      }
      // Šabloni ne koriste obrisane kategorije (kao posle brisanja kroz API).
      db.exec(
        'UPDATE template_blocks SET category_id = NULL WHERE category_id IN (SELECT id FROM categories WHERE archived = 1)',
      );
      db.prepare(
        `INSERT INTO meta (key, value) VALUES ('settings', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ).run(JSON.stringify(data.settings));
    });
  } catch (err) {
    if (err instanceof HttpError) throw err;
    // Duplirani id-jevi ili veze ka nepostojećim redovima.
    if (isSqliteError(err)) throw badRequest('Kopija nije ispravna: podaci se međusobno ne slažu.');
    throw err;
  }
}
