// Rute `/api/*`: CSRF, veličina tela i Bearer middleware, auth rute (authRoutes.ts), validacija ulaza (zod) i
// pozivi repozitorijuma prijavljenog korisnika. Svaka mutacija dana vraća ceo DayPayload, svaka mutacija
// rasporeda ceo SchedulePayload. Svi podaci su podaci korisnika iz access tokena (`Repo` vezan za `uid`).

import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { HealthPayload } from '../shared/types.ts';
import { diffDays, isValidISODate, isValidRange, localISODate } from '../shared/time.ts';
import type { Accounts } from './accounts.ts';
import type { AccessTokens, SignupPolicy } from './auth.ts';
import { bearerAuth, registerAuthRoutes } from './authRoutes.ts';
import type { ApiEnv } from './authRoutes.ts';
import { exportData, importData } from './backup.ts';
import { tx } from './db.ts';
import type { Repo } from './repo.ts';
import { HttpError, badRequest, parseDateParam, parseIdParam } from './util.ts';
import { body, readJson } from './validate.ts';

export interface ApiDeps {
  db: DatabaseSync;
  /** Repozitorijum vezan za korisnika (deljen keš upita). */
  repos: (uid: number) => Repo;
  accounts: Accounts;
  tokens: AccessTokens;
  signup: SignupPolicy;
  /** Kod za registraciju (SIGNUP_CODE, inače APP_PASSWORD); '' = nema koda. */
  signupCode: string;
  refreshTtlSec: number;
  /**
   * Broj reverse proxy-ja ispred aplikacije kojima se veruje (env TRUST_PROXY): adresa klijenta je
   * toliki unos od kraja X-Forwarded-For. 0 = X-Forwarded-For se gleda samo sa iste mašine.
   */
  proxyHops: number;
  /** Glavni JS fajl web build-a koji se servira (za /api/health); undefined = nema build-a. */
  build?: string;
}

const MB = 1024 * 1024;
const MAX_STATS_DAYS = 400;

// ---- Validacija ----

const isoDate = z.string({ error: 'Datum nije ispravan.' }).refine(isValidISODate, { error: 'Datum nije ispravan.' });
const categoryRef = z.int({ error: 'Neispravna kategorija.' }).positive({ error: 'Neispravna kategorija.' }).nullable();
const templateRef = z.int({ error: 'Neispravan šablon.' }).positive({ error: 'Neispravan šablon.' }).nullable();
const minute = z.int({ error: 'Vreme mora biti ceo broj minuta.' });

const blockTitle = z
  .string({ error: 'Naslov bloka je obavezan.' })
  .trim()
  .min(1, { error: 'Naslov bloka je obavezan.' })
  .max(120, { error: 'Naslov bloka može imati najviše 120 znakova.' });

const blockInput = z
  .object({
    start: minute,
    end: minute,
    title: blockTitle,
    categoryId: categoryRef.optional().transform((v) => v ?? null),
  })
  .refine((b) => isValidRange(b.start, b.end), { error: 'Neispravno vreme bloka.' });

const blockPatch = z.object({
  start: minute.optional(),
  end: minute.optional(),
  title: blockTitle.optional(),
  categoryId: categoryRef.optional(),
  status: z.enum(['pending', 'done', 'partial', 'skipped'], { error: 'Neispravan status.' }).optional(),
  actualMin: z
    .int({ error: 'Stvarno vreme mora biti ceo broj minuta.' })
    .min(0, { error: 'Stvarno vreme mora biti između 0 i 1440 minuta.' })
    .max(1440, { error: 'Stvarno vreme mora biti između 0 i 1440 minuta.' })
    .nullable()
    .optional(),
  note: z.string().max(5000, { error: 'Beleška bloka može imati najviše 5000 znakova.' }).optional(),
});

const dayPatch = z.object({
  note: z.string().max(20000, { error: 'Beleška može imati najviše 20000 znakova.' }).optional(),
  // Beleška na koju se izmena oslanja; ako je na serveru u međuvremenu drugačija → 409.
  // Samo se poredi (bez ograničenja dužine, telo je ionako do 1 MB): i duža beleška iz uvezene
  // kopije mora moći da se izmeni.
  baseNote: z.string().optional(),
  rating: z
    .int({ error: 'Ocena mora biti od 1 do 5.' })
    .min(1, { error: 'Ocena mora biti od 1 do 5.' })
    .max(5, { error: 'Ocena mora biti od 1 do 5.' })
    .nullable()
    .optional(),
});

const dayInit = z.object({
  reset: z.boolean().optional(),
  templateId: templateRef.optional(),
});

const splitInput = z.object({ at: minute });

const swapInput = z.object({
  with: z.int({ error: 'Izaberi blok za zamenu.' }).positive({ error: 'Izaberi blok za zamenu.' }),
});

const taskTitle = z
  .string({ error: 'Naziv zadatka je obavezan.' })
  .trim()
  .min(1, { error: 'Naziv zadatka je obavezan.' })
  .max(300, { error: 'Naziv zadatka može imati najviše 300 znakova.' });

const taskInput = z.object({
  date: isoDate,
  title: taskTitle,
  categoryId: categoryRef.optional().transform((v) => v ?? null),
});

const taskPatch = z.object({
  title: taskTitle.optional(),
  done: z.boolean({ error: 'Neispravna vrednost za "urađeno".' }).optional(),
  categoryId: categoryRef.optional(),
  date: isoDate.optional(),
  sort: z.int().optional(),
});

const carryInput = z.object({ to: isoDate });

const categoryName = z
  .string({ error: 'Naziv kategorije je obavezan.' })
  .trim()
  .min(1, { error: 'Naziv kategorije je obavezan.' })
  .max(40, { error: 'Naziv kategorije može imati najviše 40 znakova.' });
const categoryColor = z
  .string({ error: 'Boja je obavezna.' })
  .regex(/^#[0-9a-fA-F]{6}$/, { error: 'Boja mora biti u obliku #rrggbb.' })
  .transform((s) => s.toLowerCase());

const categoryInput = z.object({
  name: categoryName,
  color: categoryColor,
  counts: z.boolean().optional().default(true),
});

const categoryPatch = z.object({
  name: categoryName.optional(),
  color: categoryColor.optional(),
  counts: z.boolean().optional(),
  sort: z.int().optional(),
});

const templateName = z
  .string({ error: 'Naziv šablona je obavezan.' })
  .trim()
  .min(1, { error: 'Naziv šablona je obavezan.' })
  .max(60, { error: 'Naziv šablona može imati najviše 60 znakova.' });

const templateInput = z.object({ name: templateName, copyFrom: templateRef.optional() });
const templatePatch = z.object({ name: templateName.optional(), sort: z.int().optional() });
const templateBlocks = z.object({
  blocks: z.array(blockInput).max(100, { error: 'Šablon može imati najviše 100 blokova.' }),
});

const weekdayMap = z.strictObject({
  '1': templateRef.optional(),
  '2': templateRef.optional(),
  '3': templateRef.optional(),
  '4': templateRef.optional(),
  '5': templateRef.optional(),
  '6': templateRef.optional(),
  '7': templateRef.optional(),
});

const settingsPatch = z.object({
  dayStart: z
    .int({ error: 'Početak dana mora biti ceo broj minuta.' })
    .min(0, { error: 'Dan može da počne između 00:00 i 06:00.' })
    .max(360, { error: 'Dan može da počne između 00:00 i 06:00.' })
    .optional(),
  streakThreshold: z
    .number({ error: 'Prag mora biti broj.' })
    .min(0.1, { error: 'Prag mora biti između 10% i 100%.' })
    .max(1, { error: 'Prag mora biti između 10% i 100%.' })
    .optional(),
});

const scheduleReset = z.object({
  dayStart: z.boolean({ error: 'Neispravna vrednost za početak dana.' }).optional(),
});

// ---- Pomoćnici ----

function sizeLimit(maxSize: number): MiddlewareHandler {
  return bodyLimit({
    maxSize,
    // Nepročitano telo ostaje na konekciji — zatvori je da klijent ne bi ponovo koristio isti socket.
    onError: (c) => c.json({ error: 'Zahtev je prevelik.' }, 413, { Connection: 'close' }),
  });
}

// ---- Rute ----

export function createApi(deps: ApiDeps): Hono<ApiEnv> {
  const { db, repos, accounts, tokens, build } = deps;
  const api = new Hono<ApiEnv>();
  const smallBody = sizeLimit(1 * MB);
  const largeBody = sizeLimit(20 * MB);

  // CSRF: svaka izmena mora imati X-Ritam: 1 (browser ga ne šalje sa tuđeg sajta bez CORS-a).
  api.use('*', async (c, next) => {
    const m = c.req.method;
    if (m !== 'GET' && m !== 'HEAD' && c.req.header('x-ritam') !== '1') {
      throw new HttpError(403, 'Zahtev je odbijen.');
    }
    await next();
  });

  // Veličina tela: 1 MB, uvoz kopije do 20 MB.
  api.use('*', (c, next) => (c.req.path === '/api/import' ? largeBody(c, next) : smallBody(c, next)));

  // Sve osim /api/health i javnih auth ruta traži važeći access token (Authorization: Bearer …).
  api.use('*', bearerAuth(accounts, tokens));

  // ---- Zdravlje i nalozi ----

  const health: HealthPayload = build ? { ok: true, build } : { ok: true };
  api.get('/health', (c) => c.json(health));

  registerAuthRoutes(api, deps);

  // ---- Dan ----

  /** Podaci prijavljenog korisnika (uid iz access tokena). */
  const repoOf = (c: Context<ApiEnv>) => repos(c.get('uid'));
  const day = (c: Context<ApiEnv>, date: string, ensure = false) => c.json(repoOf(c).dayPayload(date, ensure));
  const dateParam = (c: Context<ApiEnv>) => parseDateParam(c.req.param('date'));
  const idParam = (c: Context<ApiEnv>) => parseIdParam(c.req.param('id'));

  api.get('/days/:date', (c) => {
    const ensure = ['1', 'true'].includes(c.req.query('ensure') ?? '');
    return day(c, dateParam(c), ensure);
  });

  api.post('/days/:date/init', async (c) => {
    const date = dateParam(c);
    repoOf(c).initDayRequest(date, await body(c, dayInit));
    return day(c, date);
  });

  api.patch('/days/:date', async (c) => {
    const date = dateParam(c);
    repoOf(c).patchDay(date, await body(c, dayPatch));
    return day(c, date);
  });

  api.post('/days/:date/blocks', async (c) => {
    const date = dateParam(c);
    repoOf(c).addBlock(date, await body(c, blockInput));
    return day(c, date);
  });

  // ---- Blokovi ----

  api.patch('/blocks/:id', async (c) => {
    const id = idParam(c);
    const date = repoOf(c).patchBlock(id, await body(c, blockPatch));
    return day(c, date);
  });

  api.delete('/blocks/:id', (c) => day(c, repoOf(c).deleteBlock(idParam(c))));

  api.post('/blocks/:id/split', async (c) => {
    const id = idParam(c);
    const { at } = await body(c, splitInput);
    return day(c, repoOf(c).splitBlock(id, at));
  });

  // Zamena naslova i kategorije dva bloka istog dana; termini ostaju.
  api.post('/blocks/:id/swap', async (c) => {
    const id = idParam(c);
    const { with: withId } = await body(c, swapInput);
    return day(c, repoOf(c).swapBlocks(id, withId));
  });

  // ---- Zadaci ----

  api.post('/tasks', async (c) => {
    const { date, title, categoryId } = await body(c, taskInput);
    repoOf(c).addTask(date, title, categoryId);
    return day(c, date);
  });

  api.post('/tasks/carry', async (c) => {
    const { to } = await body(c, carryInput);
    repoOf(c).carryTasks(to);
    return day(c, to);
  });

  api.get('/tasks/done', (c) => {
    const from = parseDateParam(c.req.query('from'), 'Početni datum');
    const to = parseDateParam(c.req.query('to'), 'Krajnji datum');
    if (from > to) throw badRequest('Početni datum je posle krajnjeg.');
    return c.json(repoOf(c).doneTasks(from, to));
  });

  api.patch('/tasks/:id', async (c) => {
    const id = idParam(c);
    const oldDate = repoOf(c).patchTask(id, await body(c, taskPatch));
    return day(c, oldDate);
  });

  api.delete('/tasks/:id', (c) => day(c, repoOf(c).deleteTask(idParam(c))));

  // ---- Statistika i dnevnik ----

  api.get('/stats', (c) => {
    const from = parseDateParam(c.req.query('from'), 'Početni datum');
    const to = parseDateParam(c.req.query('to'), 'Krajnji datum');
    if (from > to) throw badRequest('Početni datum je posle krajnjeg.');
    if (diffDays(from, to) + 1 > MAX_STATS_DAYS) throw badRequest(`Opseg može imati najviše ${MAX_STATS_DAYS} dana.`);
    // Logičko danas klijenta (opciono): za završen period i poslednji dan prekida niz.
    const todayRaw = c.req.query('today');
    const today = todayRaw ? parseDateParam(todayRaw, 'Današnji datum') : undefined;
    return c.json(repoOf(c).stats(from, to, today));
  });

  api.get('/journal', (c) => {
    const beforeRaw = c.req.query('before');
    const before = beforeRaw ? parseDateParam(beforeRaw) : undefined;
    const q = (c.req.query('q') ?? '').trim().slice(0, 200) || undefined;
    const limitRaw = c.req.query('limit');
    let limit = 20;
    if (limitRaw) {
      if (!/^\d{1,4}$/.test(limitRaw) || Number(limitRaw) < 1) throw badRequest('Neispravan limit.');
      limit = Math.min(Number(limitRaw), 100);
    }
    return c.json(repoOf(c).journal({ before, q, limit }));
  });

  // ---- Raspored ----

  const schedule = (c: Context<ApiEnv>) => c.json(repoOf(c).schedule());

  api.get('/schedule', schedule);

  // Raspored ispočetka: kategorije, šabloni i dani u nedelji; sačuvani dani, zadaci i beleške ostaju.
  api.post('/schedule/reset', async (c) => {
    repoOf(c).resetSchedule(await body(c, scheduleReset));
    return schedule(c);
  });

  api.post('/categories', async (c) => {
    repoOf(c).addCategory(await body(c, categoryInput));
    return schedule(c);
  });

  api.patch('/categories/:id', async (c) => {
    const id = idParam(c);
    repoOf(c).patchCategory(id, await body(c, categoryPatch));
    return schedule(c);
  });

  api.delete('/categories/:id', (c) => {
    repoOf(c).deleteCategory(idParam(c));
    return schedule(c);
  });

  api.post('/templates', async (c) => {
    const { name, copyFrom } = await body(c, templateInput);
    repoOf(c).addTemplate(name, copyFrom);
    return schedule(c);
  });

  api.patch('/templates/:id', async (c) => {
    const id = idParam(c);
    repoOf(c).patchTemplate(id, await body(c, templatePatch));
    return schedule(c);
  });

  api.delete('/templates/:id', (c) => {
    repoOf(c).deleteTemplate(idParam(c));
    return schedule(c);
  });

  api.put('/templates/:id/blocks', async (c) => {
    const id = idParam(c);
    const { blocks } = await body(c, templateBlocks);
    repoOf(c).putTemplateBlocks(id, blocks);
    return schedule(c);
  });

  api.put('/weekdays', async (c) => {
    repoOf(c).putWeekdays(await body(c, weekdayMap));
    return schedule(c);
  });

  api.patch('/settings', async (c) => {
    repoOf(c).patchSettings(await body(c, settingsPatch));
    return schedule(c);
  });

  // ---- Rezervna kopija ----

  // Samo podaci prijavljenog korisnika (bez user_id).
  api.get('/export', (c) => {
    const repo = repoOf(c);
    c.header('Content-Disposition', `attachment; filename="ritam-backup-${localISODate()}.json"`);
    return c.json(exportData(db, repo.uid, repo.getSettings()));
  });

  api.post('/import', async (c) => {
    const input = await readJson(c);
    // Blokovi šablona koji su u kopiji ceo van logičkog dana prelaze na drugi kraj dana (isto pravilo kao
    // pri pokretanju i promeni dayStart) — u istoj transakciji kao uvoz.
    // Zamenjuje samo podatke prijavljenog korisnika; svi redovi dobijaju nove id-jeve (backup.ts).
    const repo = repoOf(c);
    tx(db, () => {
      importData(db, repo.uid, input);
      repo.normalizeTemplateBlocks();
    });
    return c.json({ ok: true as const });
  });

  // Nepoznata API putanja ne sme da padne na SPA fallback.
  api.all('*', (c) => c.json({ error: 'Ne postoji.' }, 404));

  return api;
}
