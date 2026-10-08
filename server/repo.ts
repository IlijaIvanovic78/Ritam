// Pristup podacima: dani, blokovi, zadaci, raspored, statistika i dnevnik.
// Svaka mutacija sa više upita ide kroz `tx`. Payload-i (DayPayload,
// SchedulePayload, StatsPayload) se grade ovde da bi rute ostale tanke.

import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type {
  Block,
  BlockInput,
  BlockPatch,
  BlockStatus,
  BlockSummary,
  Category,
  CategoryInput,
  DayPatch,
  DayPayload,
  JournalEntry,
  SchedulePayload,
  ScheduleResetInput,
  Settings,
  StatsDay,
  StatsPayload,
  Task,
  TaskPatch,
  Template,
  TemplateBlock,
  Weekday,
  WeekdayMap,
} from '../shared/types.ts';
import { DAY_MIN, eachDay, isoWeekday, isValidRange } from '../shared/time.ts';
import { computeStreak, mergeCategoryTimes, sortBlocks, summarizeBlocks } from '../shared/summary.ts';
import { statementCache, tx } from './db.ts';
import { DEFAULT_SETTINGS } from './defaults.ts';
import {
  HttpError,
  badRequest,
  flag,
  foldText,
  nameKey,
  notFound,
  nowISO,
  num,
  numOrNull,
  str,
  strOrNull,
} from './util.ts';
import type { Row } from './util.ts';

// ---- Mapiranje redova (snake_case, null prototip) u tipove ----

function mapCategory(r: Row): Category {
  return { id: num(r.id), name: str(r.name), color: str(r.color), counts: num(r.counts) === 1, sort: num(r.sort) };
}

function mapBlock(r: Row): Block {
  return {
    id: num(r.id),
    date: str(r.date),
    start: num(r.start_min),
    end: num(r.end_min),
    title: str(r.title),
    categoryId: numOrNull(r.category_id),
    status: str(r.status) as BlockStatus,
    actualMin: numOrNull(r.actual_min),
    note: str(r.note),
  };
}

function mapTemplateBlock(r: Row): TemplateBlock {
  return {
    id: num(r.id),
    templateId: num(r.template_id),
    start: num(r.start_min),
    end: num(r.end_min),
    title: str(r.title),
    categoryId: numOrNull(r.category_id),
  };
}

function mapTask(r: Row): Task {
  return {
    id: num(r.id),
    date: str(r.date),
    title: str(r.title),
    done: num(r.done) === 1,
    doneAt: strOrNull(r.done_at),
    categoryId: numOrNull(r.category_id),
    sort: num(r.sort),
    createdAt: str(r.created_at),
  };
}

interface DayRow {
  date: string;
  initialized: boolean;
  templateId: number | null;
  note: string;
  rating: number | null;
}

function mapDayRow(r: Row): DayRow {
  return {
    date: str(r.date),
    initialized: num(r.initialized) === 1,
    templateId: numOrNull(r.template_id),
    note: str(r.note),
    rating: numOrNull(r.rating),
  };
}

/** Proverava i normalizuje sačuvana podešavanja (npr. posle ručne izmene baze). */
export function sanitizeSettings(raw: unknown): Settings {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof Settings, unknown>>;
  const dayStart =
    typeof s.dayStart === 'number' && Number.isInteger(s.dayStart) && s.dayStart >= 0 && s.dayStart <= 360
      ? s.dayStart
      : DEFAULT_SETTINGS.dayStart;
  const streakThreshold =
    typeof s.streakThreshold === 'number' && s.streakThreshold >= 0.1 && s.streakThreshold <= 1
      ? s.streakThreshold
      : DEFAULT_SETTINGS.streakThreshold;
  return { dayStart, streakThreshold };
}

/**
 * Blok šablona mora da se preklapa sa logičkim danom `[dayStart, dayStart + 24h)` — inače ga traka
 * šablona i dan ne prikazuju. Blok koji je ceo van dana prelazi na drugi kraj dana (zidno vreme ostaje
 * isto): `start >= dayStart + 1440` dobija −1440, `end <= dayStart` dobija +1440. Rezultat je i dalje
 * validan opseg (isto pravilo kao pri promeni dayStart).
 */
export function intoLogicalDay(start: number, end: number, dayStart: number): { start: number; end: number } {
  const shift = start >= dayStart + DAY_MIN ? -DAY_MIN : end <= dayStart ? DAY_MIN : 0;
  return { start: start + shift, end: end + shift };
}

const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/**
 * Dan je "praćen" tek kad bar jedan blok ima status. Samo otvoren dan (blokovi kopirani
 * iz šablona, svi 'pending') ne ulazi u statistiku kao dan sa 0%.
 */
const isRated = (blocks: Block[]): boolean => blocks.some((b) => b.status !== 'pending');

export class Repo {
  db: DatabaseSync;
  q: (sql: string) => StatementSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.q = statementCache(db);
  }

  // ======================= Podešavanja =======================

  getSettings(): Settings {
    const row = this.q(`SELECT value FROM meta WHERE key = 'settings'`).get();
    if (!row) return { ...DEFAULT_SETTINGS };
    try {
      return sanitizeSettings(JSON.parse(str(row.value)));
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  saveSettings(s: Settings): void {
    this.q(
      `INSERT INTO meta (key, value) VALUES ('settings', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(JSON.stringify(s));
  }

  /** Menja podešavanja; promena dayStart premešta blokove šablona koji ispadnu iz novog dana. */
  patchSettings(p: Partial<Settings>): void {
    tx(this.db, () => {
      const cur = this.getSettings();
      const next: Settings = {
        dayStart: p.dayStart ?? cur.dayStart,
        streakThreshold: p.streakThreshold ?? cur.streakThreshold,
      };
      this.saveSettings(next);
      // Zidno vreme ostaje isto. Blok koji se i dalje preklapa sa novim logičkim danom
      // [dayStart, dayStart + 24h) ostaje gde je (npr. blok 01:00–09:00 ostaje na početku
      // dana i kad dan počinje u 02:00); samo blok koji je ceo ispao prelazi na drugi kraj dana.
      if (next.dayStart !== cur.dayStart) this.normalizeTemplateBlocks(next.dayStart);
    });
  }

  /**
   * Premešta blokove šablona koji su ceo van logičkog dana (`intoLogicalDay`) — posle promene dayStart,
   * pri pokretanju i posle uvoza (npr. blok koji je ranija verzija klijenta sačuvala van dana). Vraća broj
   * premeštenih blokova; ponovljen poziv ništa ne menja.
   */
  normalizeTemplateBlocks(dayStart: number = this.getSettings().dayStart): number {
    return tx(this.db, () => {
      let moved = 0;
      const upd = this.q('UPDATE template_blocks SET start_min = ?, end_min = ? WHERE id = ?');
      for (const r of this.q('SELECT id, start_min, end_min FROM template_blocks').all()) {
        const start = num(r.start_min);
        const end = num(r.end_min);
        const next = intoLogicalDay(start, end, dayStart);
        if (next.start !== start) {
          upd.run(next.start, next.end, num(r.id));
          moved += 1;
        }
      }
      return moved;
    });
  }

  // ======================= Kategorije =======================

  /** Kategorije koje se nude za izbor (bez obrisanih). */
  listCategories(): Category[] {
    return this.q('SELECT * FROM categories WHERE archived = 0 ORDER BY sort, id').all().map(mapCategory);
  }

  /** Obrisane kategorije koje sačuvani blokovi i zadaci još koriste za prikaz i računanje. */
  archivedCategories(): Category[] {
    return this.q('SELECT * FROM categories WHERE archived = 1 ORDER BY sort, id').all().map(mapCategory);
  }

  /** Sve kategorije, i obrisane — za računanje ispunjenosti ranijih dana. */
  allCategories(): Category[] {
    return this.q('SELECT * FROM categories ORDER BY sort, id').all().map(mapCategory);
  }

  /** Kategorija koja nije obrisana. */
  categoryOr404(id: number): Category {
    const r = this.q('SELECT * FROM categories WHERE id = ? AND archived = 0').get(id);
    if (!r) throw notFound('Kategorija ne postoji.');
    return mapCategory(r);
  }

  /** Kategorija iz tela zahteva (null = bez kategorije); obrisana se ne može izabrati. */
  assertCategoryRef(id: number | null | undefined): void {
    if (id == null) return;
    if (!this.q('SELECT 1 FROM categories WHERE id = ? AND archived = 0').get(id)) {
      throw badRequest('Kategorija ne postoji.');
    }
  }

  /** Dve kategorije (ili dva šablona) sa istim nazivom bi u izborima izgledale isto. */
  private assertUniqueName(table: 'categories' | 'templates', name: string, exceptId: number | null): void {
    const where = table === 'categories' ? 'archived = 0 AND id <> ?' : 'id <> ?';
    const key = nameKey(name);
    const taken = this.q(`SELECT name FROM ${table} WHERE ${where}`)
      .all(exceptId ?? 0)
      .some((r) => nameKey(str(r.name)) === key);
    if (taken) {
      throw new HttpError(
        409,
        table === 'categories' ? 'Kategorija sa tim nazivom već postoji.' : 'Šablon sa tim nazivom već postoji.',
      );
    }
  }

  addCategory(input: CategoryInput): void {
    tx(this.db, () => {
      this.assertUniqueName('categories', input.name, null);
      const sort = num(this.q('SELECT COALESCE(MAX(sort), -1) + 1 AS s FROM categories').get()?.s);
      this.q('INSERT INTO categories (name, color, counts, sort) VALUES (?, ?, ?, ?)').run(
        input.name,
        input.color,
        flag(input.counts),
        sort,
      );
    });
  }

  patchCategory(id: number, p: Partial<CategoryInput> & { sort?: number }): void {
    tx(this.db, () => {
      const cur = this.categoryOr404(id);
      // Samo kad se naziv stvarno menja (klijent uvek šalje naziv; i stari duplikati ostaju izmenjivi).
      if (p.name !== undefined && nameKey(p.name) !== nameKey(cur.name)) this.assertUniqueName('categories', p.name, id);
      this.q('UPDATE categories SET name = ?, color = ?, counts = ?, sort = ? WHERE id = ?').run(
        p.name ?? cur.name,
        p.color ?? cur.color,
        flag(p.counts ?? cur.counts),
        p.sort ?? cur.sort,
        id,
      );
    });
  }

  /**
   * Brisanje = arhiviranje: kategorija nestaje iz izbora i iz šablona (budući dani je ne dobijaju),
   * a sačuvani blokovi i zadaci je zadržavaju. Tako se ranije ispunjenosti i niz ne menjaju (blok
   * bez kategorije bi se računao, pa bi brisanje kategorije koja se ne računa spustilo stare dane).
   */
  deleteCategory(id: number): void {
    tx(this.db, () => {
      this.categoryOr404(id);
      this.q('UPDATE template_blocks SET category_id = NULL WHERE category_id = ?').run(id);
      this.q('UPDATE categories SET archived = 1 WHERE id = ?').run(id);
    });
  }

  // ======================= Šabloni =======================

  templateBlocks(templateId: number): TemplateBlock[] {
    return this.q('SELECT * FROM template_blocks WHERE template_id = ? ORDER BY start_min, end_min, id')
      .all(templateId)
      .map(mapTemplateBlock);
  }

  listTemplates(): Template[] {
    const byTemplate = new Map<number, TemplateBlock[]>();
    for (const r of this.q('SELECT * FROM template_blocks ORDER BY template_id, start_min, end_min, id').all()) {
      const tb = mapTemplateBlock(r);
      const list = byTemplate.get(tb.templateId);
      if (list) list.push(tb);
      else byTemplate.set(tb.templateId, [tb]);
    }
    return this.q('SELECT * FROM templates ORDER BY sort, id')
      .all()
      .map((r) => {
        const id = num(r.id);
        return { id, name: str(r.name), sort: num(r.sort), blocks: byTemplate.get(id) ?? [] };
      });
  }

  templateName(id: number | null): string | null {
    if (id == null) return null;
    const r = this.q('SELECT name FROM templates WHERE id = ?').get(id);
    return r ? str(r.name) : null;
  }

  templateOr404(id: number): { id: number; name: string; sort: number } {
    const r = this.q('SELECT * FROM templates WHERE id = ?').get(id);
    if (!r) throw notFound('Šablon ne postoji.');
    return { id: num(r.id), name: str(r.name), sort: num(r.sort) };
  }

  /** Šablon iz tela zahteva. */
  assertTemplateRef(id: number): void {
    if (!this.q('SELECT 1 FROM templates WHERE id = ?').get(id)) throw badRequest('Šablon ne postoji.');
  }

  addTemplate(name: string, copyFrom: number | null | undefined): number {
    return tx(this.db, () => {
      if (copyFrom != null) this.assertTemplateRef(copyFrom);
      this.assertUniqueName('templates', name, null);
      const sort = num(this.q('SELECT COALESCE(MAX(sort), -1) + 1 AS s FROM templates').get()?.s);
      const id = Number(this.q('INSERT INTO templates (name, sort) VALUES (?, ?)').run(name, sort).lastInsertRowid);
      if (copyFrom != null) {
        this.q(
          `INSERT INTO template_blocks (template_id, start_min, end_min, title, category_id)
           SELECT ?, start_min, end_min, title, category_id FROM template_blocks
           WHERE template_id = ? ORDER BY start_min, end_min, id`,
        ).run(id, copyFrom);
      }
      return id;
    });
  }

  patchTemplate(id: number, p: { name?: string; sort?: number }): void {
    tx(this.db, () => {
      const cur = this.templateOr404(id);
      if (p.name !== undefined && nameKey(p.name) !== nameKey(cur.name)) this.assertUniqueName('templates', p.name, id);
      this.q('UPDATE templates SET name = ?, sort = ? WHERE id = ?').run(p.name ?? cur.name, p.sort ?? cur.sort, id);
    });
  }

  /** Blokovi šablona se brišu (CASCADE); dani u nedelji i dani dobijaju template_id = NULL. */
  deleteTemplate(id: number): void {
    tx(this.db, () => {
      this.templateOr404(id);
      this.q('DELETE FROM templates WHERE id = ?').run(id);
    });
  }

  /**
   * Zamenjuje sve blokove šablona. Ulaz je već validiran (opseg, naslov). Blok koji je ceo van logičkog
   * dana prelazi na drugi kraj dana (`intoLogicalDay`), da ne bi bio skriven na traci i u danu.
   */
  putTemplateBlocks(id: number, blocks: BlockInput[]): void {
    tx(this.db, () => {
      this.templateOr404(id);
      for (const b of blocks) this.assertCategoryRef(b.categoryId);
      const { dayStart } = this.getSettings();
      this.q('DELETE FROM template_blocks WHERE template_id = ?').run(id);
      const ins = this.q(
        'INSERT INTO template_blocks (template_id, start_min, end_min, title, category_id) VALUES (?, ?, ?, ?, ?)',
      );
      // Redosled unosa prati vreme (pa redosled slanja), pa su id-jevi rastući kroz dan.
      const sorted = sortBlocks(blocks.map((b, i) => ({ ...b, ...intoLogicalDay(b.start, b.end, dayStart), id: i })));
      for (const b of sorted) ins.run(id, b.start, b.end, b.title, b.categoryId ?? null);
    });
  }

  weekdays(): WeekdayMap {
    const map: WeekdayMap = { 1: null, 2: null, 3: null, 4: null, 5: null, 6: null, 7: null };
    for (const r of this.q('SELECT weekday, template_id FROM weekday_templates').all()) {
      const wd = num(r.weekday);
      if (wd >= 1 && wd <= 7) map[wd as Weekday] = numOrNull(r.template_id);
    }
    return map;
  }

  /** Delimična mapa je dozvoljena: menjaju se samo poslati dani. */
  putWeekdays(map: Partial<Record<Weekday, number | null>>): void {
    tx(this.db, () => {
      const up = this.q(
        `INSERT INTO weekday_templates (weekday, template_id) VALUES (?, ?)
         ON CONFLICT(weekday) DO UPDATE SET template_id = excluded.template_id`,
      );
      for (const [key, tplId] of Object.entries(map)) {
        if (tplId === undefined) continue;
        if (tplId !== null) this.assertTemplateRef(tplId);
        up.run(Number(key), tplId);
      }
    });
  }

  /**
   * "Raspored ispočetka" (npr. raspored koji je ranija verzija upisivala u novu bazu): brišu se svi šabloni
   * (blokovi šablona kaskadno; dani u nedelji i sačuvani dani dobijaju template_id = NULL preko stranih
   * ključeva) i sve kategorije. Kategorije se arhiviraju kao kod pojedinačnog brisanja, pa sačuvani blokovi
   * i zadaci zadržavaju kategoriju i ispunjenost ranijih dana se ne menja. Dani, blokovi, zadaci, beleške i
   * ocene ostaju. `dayStart` = i dan ponovo počinje u 00:00 (nema blokova šablona koje bi trebalo premestiti).
   */
  resetSchedule(opts: ScheduleResetInput): void {
    tx(this.db, () => {
      this.q('DELETE FROM templates').run();
      this.q('UPDATE categories SET archived = 1 WHERE archived = 0').run();
      if (opts.dayStart) this.saveSettings({ ...this.getSettings(), dayStart: DEFAULT_SETTINGS.dayStart });
    });
  }

  schedule(): SchedulePayload {
    return {
      categories: this.listCategories(),
      archivedCategories: this.archivedCategories(),
      templates: this.listTemplates(),
      weekdays: this.weekdays(),
      settings: this.getSettings(),
    };
  }

  // ======================= Dani =======================

  dayRow(date: string): DayRow | undefined {
    const r = this.q('SELECT * FROM days WHERE date = ?').get(date);
    return r ? mapDayRow(r) : undefined;
  }

  /** Šablon dodeljen danu u nedelji za dati datum (ili null). */
  weekdayTemplateId(date: string): number | null {
    const r = this.q('SELECT template_id FROM weekday_templates WHERE weekday = ?').get(isoWeekday(date));
    return r ? numOrNull(r.template_id) : null;
  }

  /** Kopira blokove iz šablona (null = prazan dan) i označava dan kao inicijalizovan. Briše postojeće blokove. */
  initDay(date: string, templateId: number | null): void {
    tx(this.db, () => {
      this.q(
        `INSERT INTO days (date, initialized, template_id, updated_at) VALUES (?, 1, ?, ?)
         ON CONFLICT(date) DO UPDATE SET initialized = 1, template_id = excluded.template_id,
           updated_at = excluded.updated_at`,
      ).run(date, templateId, nowISO());
      this.q('DELETE FROM blocks WHERE date = ?').run(date);
      if (templateId != null) {
        this.q(
          `INSERT INTO blocks (date, start_min, end_min, title, category_id)
           SELECT ?, start_min, end_min, title, category_id FROM template_blocks
           WHERE template_id = ? ORDER BY start_min, end_min, id`,
        ).run(date, templateId);
      }
    });
  }

  /** Inicijalizuje dan iz šablona dana u nedelji ako to već nije urađeno. */
  ensureDay(date: string): void {
    if (this.dayRow(date)?.initialized) return;
    this.initDay(date, this.weekdayTemplateId(date));
  }

  /** POST /days/:date/init — templateId undefined = šablon dana u nedelji, null = prazan dan. */
  initDayRequest(date: string, opts: { reset?: boolean; templateId?: number | null }): void {
    tx(this.db, () => {
      if (this.dayRow(date)?.initialized && !opts.reset) {
        throw new HttpError(409, 'Plan za ovaj dan već postoji.');
      }
      const tplId = opts.templateId === undefined ? this.weekdayTemplateId(date) : opts.templateId;
      if (tplId != null) this.assertTemplateRef(tplId);
      this.initDay(date, tplId);
    });
  }

  touchDay(date: string): void {
    this.q('UPDATE days SET updated_at = ? WHERE date = ?').run(nowISO(), date);
  }

  /**
   * Beleška/ocena: upsert reda u `days` bez inicijalizacije blokova.
   * Uz `baseNote` beleška se upisuje samo ako je na serveru i dalje `baseNote` (ili već isti tekst,
   * pa je ponovljeno slanje bezbedno); inače 409, da zastareo draft sa drugog uređaja ne prepiše novu belešku.
   */
  patchDay(date: string, p: DayPatch): void {
    tx(this.db, () => {
      if (p.note !== undefined && p.baseNote !== undefined) {
        const stored = this.dayRow(date)?.note ?? '';
        if (stored !== p.baseNote && stored !== p.note) {
          throw new HttpError(409, 'Beleška je u međuvremenu promenjena na drugom uređaju.');
        }
      }
      this.q(
        `INSERT INTO days (date, updated_at) VALUES (?, ?)
         ON CONFLICT(date) DO UPDATE SET updated_at = excluded.updated_at`,
      ).run(date, nowISO());
      if (p.note !== undefined) this.q('UPDATE days SET note = ? WHERE date = ?').run(p.note, date);
      if (p.rating !== undefined) this.q('UPDATE days SET rating = ? WHERE date = ?').run(p.rating, date);
    });
  }

  blocksForDate(date: string): Block[] {
    return this.q('SELECT * FROM blocks WHERE date = ? ORDER BY start_min, end_min, id').all(date).map(mapBlock);
  }

  tasksForDate(date: string): Task[] {
    // Nezavršeni po sort, id; zatim završeni po done_at, id.
    return this.q(
      `SELECT * FROM tasks WHERE date = ?
       ORDER BY done, CASE WHEN done = 0 THEN sort END, done_at, id`,
    )
      .all(date)
      .map(mapTask);
  }

  /** Pregled iz šablona za neinicijalizovan dan: negativni id-jevi, sve 'pending'. */
  previewBlocks(date: string, templateId: number | null): Block[] {
    if (templateId == null) return [];
    return this.templateBlocks(templateId).map((tb, i) => ({
      id: -(i + 1),
      date,
      start: tb.start,
      end: tb.end,
      title: tb.title,
      categoryId: tb.categoryId,
      status: 'pending',
      actualMin: null,
      note: '',
    }));
  }

  dayPayload(date: string, ensure = false): DayPayload {
    if (ensure) this.ensureDay(date);
    const row = this.dayRow(date);
    const initialized = row?.initialized ?? false;
    const templateId = initialized ? (row?.templateId ?? null) : this.weekdayTemplateId(date);
    const blocks = initialized ? this.blocksForDate(date) : this.previewBlocks(date, templateId);
    const openBefore = num(this.q('SELECT COUNT(*) AS n FROM tasks WHERE done = 0 AND date < ?').get(date)?.n);
    return {
      date,
      initialized,
      templateId,
      templateName: this.templateName(templateId),
      note: row?.note ?? '',
      rating: row?.rating ?? null,
      blocks,
      tasks: this.tasksForDate(date),
      openBefore,
    };
  }

  // ======================= Blokovi =======================

  blockOr404(id: number): Block {
    const r = this.q('SELECT * FROM blocks WHERE id = ?').get(id);
    if (!r) throw notFound('Blok ne postoji.');
    return mapBlock(r);
  }

  addBlock(date: string, input: BlockInput): void {
    tx(this.db, () => {
      this.assertCategoryRef(input.categoryId);
      this.ensureDay(date);
      this.q('INSERT INTO blocks (date, start_min, end_min, title, category_id) VALUES (?, ?, ?, ?, ?)').run(
        date,
        input.start,
        input.end,
        input.title,
        input.categoryId ?? null,
      );
      this.touchDay(date);
    });
  }

  /** Vraća datum bloka. */
  patchBlock(id: number, p: BlockPatch): string {
    return tx(this.db, () => {
      const cur = this.blockOr404(id);
      const start = p.start ?? cur.start;
      const end = p.end ?? cur.end;
      // Proverava se samo kad se vreme menja — status/beleška moraju raditi i na starom redu.
      if ((p.start !== undefined || p.end !== undefined) && !isValidRange(start, end)) {
        throw badRequest('Neispravno vreme bloka.');
      }
      // Ista (i obrisana) kategorija koju blok već ima je u redu.
      if (p.categoryId !== undefined && p.categoryId !== cur.categoryId) this.assertCategoryRef(p.categoryId);
      const status = p.status ?? cur.status;
      let actualMin = p.actualMin !== undefined ? p.actualMin : cur.actualMin;
      // Kad status pređe u nešto što nema odrađeno vreme, briše se i stvarno vreme
      // (osim ako ga klijent eksplicitno šalje).
      if (p.status !== undefined && p.actualMin === undefined && status !== 'done' && status !== 'partial') {
        actualMin = null;
      }
      this.q(
        `UPDATE blocks SET start_min = ?, end_min = ?, title = ?, category_id = ?, status = ?,
           actual_min = ?, note = ? WHERE id = ?`,
      ).run(
        start,
        end,
        p.title ?? cur.title,
        p.categoryId !== undefined ? p.categoryId : cur.categoryId,
        status,
        actualMin,
        p.note ?? cur.note,
        id,
      );
      this.touchDay(cur.date);
      return cur.date;
    });
  }

  /** Vraća datum obrisanog bloka. */
  deleteBlock(id: number): string {
    return tx(this.db, () => {
      const cur = this.blockOr404(id);
      this.q('DELETE FROM blocks WHERE id = ?').run(id);
      this.touchDay(cur.date);
      return cur.date;
    });
  }

  /** Deli blok u `at`; prvi deo zadržava id/status/belešku, drugi je novi 'pending' blok. */
  splitBlock(id: number, at: number): string {
    return tx(this.db, () => {
      const cur = this.blockOr404(id);
      if (at - cur.start < 5 || cur.end - at < 5) {
        throw badRequest('Oba dela bloka moraju imati bar 5 minuta.');
      }
      // Npr. drugi deo bi počeo posle 2880 (blok od skoro 24h koji počinje posle ponoći).
      if (!isValidRange(cur.start, at) || !isValidRange(at, cur.end)) {
        throw badRequest('Neispravno mesto deljenja.');
      }
      const firstDur = at - cur.start;
      const actual = cur.actualMin != null && cur.actualMin > firstDur ? null : cur.actualMin;
      this.q('UPDATE blocks SET end_min = ?, actual_min = ? WHERE id = ?').run(at, actual, id);
      this.q('INSERT INTO blocks (date, start_min, end_min, title, category_id) VALUES (?, ?, ?, ?, ?)').run(
        cur.date,
        at,
        cur.end,
        cur.title,
        cur.categoryId,
      );
      this.touchDay(cur.date);
      return cur.date;
    });
  }

  /**
   * Zamenjuje naslov i kategoriju dva bloka istog dana (npr. dve aktivnosti menjaju termine). Vreme, status,
   * stvarno vreme i beleška ostaju u svom terminu. Vraća datum.
   */
  swapBlocks(id: number, withId: number): string {
    return tx(this.db, () => {
      if (id === withId) throw badRequest('Blok ne može da se zameni sam sa sobom.');
      const a = this.blockOr404(id);
      const b = this.blockOr404(withId);
      if (a.date !== b.date) throw badRequest('Možeš da zameniš samo blokove istog dana.');
      const set = this.q('UPDATE blocks SET title = ?, category_id = ? WHERE id = ?');
      set.run(b.title, b.categoryId, a.id);
      set.run(a.title, a.categoryId, b.id);
      this.touchDay(a.date);
      return a.date;
    });
  }

  // ======================= Zadaci =======================

  taskOr404(id: number): Task {
    const r = this.q('SELECT * FROM tasks WHERE id = ?').get(id);
    if (!r) throw notFound('Zadatak ne postoji.');
    return mapTask(r);
  }

  nextTaskSort(date: string): number {
    return num(this.q('SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM tasks WHERE date = ?').get(date)?.s);
  }

  addTask(date: string, title: string, categoryId: number | null): void {
    tx(this.db, () => {
      this.assertCategoryRef(categoryId);
      this.q(
        `INSERT INTO tasks (date, title, done, done_at, category_id, sort, created_at)
         VALUES (?, ?, 0, NULL, ?, ?, ?)`,
      ).run(date, title, categoryId, this.nextTaskSort(date), nowISO());
    });
  }

  /** Vraća STARI datum zadatka (klijent osvežava dan na kome je zadatak bio). */
  patchTask(id: number, p: TaskPatch): string {
    return tx(this.db, () => {
      const cur = this.taskOr404(id);
      if (p.categoryId !== undefined && p.categoryId !== cur.categoryId) this.assertCategoryRef(p.categoryId);
      let done = cur.done;
      let doneAt = cur.doneAt;
      if (p.done !== undefined) {
        done = p.done;
        if (!p.done) doneAt = null;
        else if (!cur.done) doneAt = nowISO(); // ponovno "done" ne pomera vreme završetka
      }
      const date = p.date ?? cur.date;
      // Premeštanje na drugi dan stavlja zadatak na kraj liste ciljnog dana.
      const sort = p.sort !== undefined ? p.sort : date !== cur.date ? this.nextTaskSort(date) : cur.sort;
      this.q(
        'UPDATE tasks SET title = ?, done = ?, done_at = ?, category_id = ?, date = ?, sort = ? WHERE id = ?',
      ).run(
        p.title ?? cur.title,
        flag(done),
        doneAt,
        p.categoryId !== undefined ? p.categoryId : cur.categoryId,
        date,
        sort,
        id,
      );
      return cur.date;
    });
  }

  /** Vraća datum obrisanog zadatka. */
  deleteTask(id: number): string {
    return tx(this.db, () => {
      const cur = this.taskOr404(id);
      this.q('DELETE FROM tasks WHERE id = ?').run(id);
      return cur.date;
    });
  }

  /** Svi nezavršeni zadaci pre `to` prelaze na `to`, na kraj liste, zadržavajući redosled. */
  carryTasks(to: string): number {
    return tx(this.db, () => {
      const ids = this.q('SELECT id FROM tasks WHERE done = 0 AND date < ? ORDER BY date, sort, id')
        .all(to)
        .map((r) => num(r.id));
      let sort = this.nextTaskSort(to);
      const upd = this.q('UPDATE tasks SET date = ?, sort = ? WHERE id = ?');
      for (const id of ids) upd.run(to, sort++, id);
      return ids.length;
    });
  }

  doneTasks(from: string, to: string): Task[] {
    return this.q(
      `SELECT * FROM tasks WHERE done = 1 AND date >= ? AND date <= ?
       ORDER BY date DESC, done_at DESC, id DESC`,
    )
      .all(from, to)
      .map(mapTask);
  }

  // ======================= Statistika =======================

  /** Sažeci svih praćenih dana (inicijalizovan + bar jedan blok sa statusom) do `to` (uključivo), po datumu. */
  private summariesUpTo(to: string, categories: Category[]): Map<string, BlockSummary> {
    const blocksByDate = new Map<string, Block[]>();
    const rows = this.q(
      `SELECT b.* FROM blocks b JOIN days d ON d.date = b.date
       WHERE d.initialized = 1 AND b.date <= ?
       ORDER BY b.date, b.start_min, b.end_min, b.id`,
    ).all(to);
    for (const r of rows) {
      const b = mapBlock(r);
      const list = blocksByDate.get(b.date);
      if (list) list.push(b);
      else blocksByDate.set(b.date, [b]);
    }
    const out = new Map<string, BlockSummary>();
    for (const [date, blocks] of blocksByDate) {
      if (isRated(blocks)) out.set(date, summarizeBlocks(blocks, categories));
    }
    return out;
  }

  private taskCounts(from: string, to: string): Map<string, { total: number; done: number }> {
    const out = new Map<string, { total: number; done: number }>();
    const rows = this.q(
      `SELECT date, COUNT(*) AS total, COALESCE(SUM(done), 0) AS done FROM tasks
       WHERE date >= ? AND date <= ? GROUP BY date`,
    ).all(from, to);
    for (const r of rows) out.set(str(r.date), { total: num(r.total), done: num(r.done) });
    return out;
  }

  /**
   * `today` (logičko danas klijenta, opciono): kad je `to` pre njega, period je završen
   * i dan `to` prekida niz kao svaki drugi. Bez `today` se `to` smatra danom koji još traje.
   */
  stats(from: string, to: string, today?: string): StatsPayload {
    const categories = this.allCategories();
    const settings = this.getSettings();
    const summaries = this.summariesUpTo(to, categories);
    const tasks = this.taskCounts(from, to);
    const dayRows = new Map<string, DayRow>();
    for (const r of this.q('SELECT * FROM days WHERE date >= ? AND date <= ?').all(from, to)) {
      const d = mapDayRow(r);
      dayRows.set(d.date, d);
    }

    const days: StatsDay[] = eachDay(from, to).map((date) => {
      const row = dayRows.get(date);
      const initialized = row?.initialized ?? false;
      const t = tasks.get(date);
      return {
        date,
        initialized,
        // Samo praćeni dani imaju sažetak (summariesUpTo preskače dane bez ocenjenih blokova).
        summary: initialized ? (summaries.get(date) ?? null) : null,
        tasksTotal: t?.total ?? 0,
        tasksDone: t?.done ?? 0,
        rating: row?.rating ?? null,
        hasNote: (row?.note ?? '').trim() !== '',
      };
    });

    const tracked = days.flatMap((d) => (d.summary ? [d.summary] : []));
    const scores = new Map<string, number | null>();
    for (const [date, s] of summaries) scores.set(date, s.score);

    return {
      from,
      to,
      days,
      totals: {
        categories: mergeCategoryTimes(tracked.map((s) => s.categories)),
        tasksTotal: days.reduce((a, d) => a + d.tasksTotal, 0),
        tasksDone: days.reduce((a, d) => a + d.tasksDone, 0),
        avgScore: mean(tracked.map((s) => s.score).filter((s): s is number => s != null)),
        avgRating: mean(days.map((d) => d.rating).filter((r): r is number => r != null)),
        daysTracked: tracked.length,
      },
      streak: computeStreak(scores, to, settings.streakThreshold, today == null || to >= today),
    };
  }

  // ======================= Dnevnik =======================

  journal(opts: { before?: string; q?: string; limit: number }): JournalEntry[] {
    const where = [`trim(note, ' ' || char(9) || char(10) || char(13)) <> ''`];
    const params: (string | number)[] = [];
    if (opts.before) {
      where.push('date < ?');
      params.push(opts.before);
    }
    const sql = `SELECT * FROM days WHERE ${where.join(' AND ')} ORDER BY date DESC`;
    const needle = opts.q ? foldText(opts.q) : '';

    const rows: DayRow[] = [];
    if (!needle) {
      for (const r of this.q(`${sql} LIMIT ?`).all(...params, opts.limit)) rows.push(mapDayRow(r));
    } else {
      // Pretraga u JS-u: SQLite LOWER/LIKE ne razume č ć š ž đ.
      for (const r of this.q(sql).iterate(...params)) {
        const d = mapDayRow(r);
        if (foldText(d.note).includes(needle)) rows.push(d);
        if (rows.length >= opts.limit) break;
      }
    }

    const categories = rows.some((d) => d.initialized) ? this.allCategories() : [];
    return rows.map((d) => {
      const t = this.q('SELECT COUNT(*) AS total, COALESCE(SUM(done), 0) AS done FROM tasks WHERE date = ?').get(d.date);
      const blocks = d.initialized ? this.blocksForDate(d.date) : [];
      return {
        date: d.date,
        note: d.note,
        rating: d.rating,
        // Kao u statistici: dan bez ijednog ocenjenog bloka nema ispunjenost (ne 0%).
        score: isRated(blocks) ? summarizeBlocks(blocks, categories).score : null,
        tasksDone: num(t?.done),
        tasksTotal: num(t?.total),
      };
    });
  }
}
