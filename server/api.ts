// Rute `/api/*`: CSRF i auth middleware, validacija ulaza (zod) i pozivi repozitorijuma.
// Svaka mutacija dana vraća ceo DayPayload, svaka mutacija rasporeda ceo SchedulePayload.

import { Hono } from 'hono';
import type { Context, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { AuthState, HealthPayload } from '../shared/types.ts';
import { diffDays, isValidISODate, isValidRange, localISODate } from '../shared/time.ts';
import { SESSION_COOKIE, SESSION_MAX_AGE_S, SESSION_RENEW_AFTER_MS, createLoginLimiter } from './auth.ts';
import type { Auth } from './auth.ts';
import { exportData, importData } from './backup.ts';
import { tx } from './db.ts';
import type { Repo } from './repo.ts';
import { HttpError, badRequest, isHttps, parseDateParam, parseIdParam } from './util.ts';

export interface ApiDeps {
  db: DatabaseSync;
  repo: Repo;
  auth: Auth;
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

/** Opšte poruke na srpskom za greške koje nemaju svoju poruku u šemi. */
const srErrorMap: z.core.$ZodErrorMap = (iss) => {
  const path = iss.path ?? [];
  const where = path.length ? ` (${path.join('.')})` : '';
  switch (iss.code) {
    case 'invalid_type':
      return iss.input === undefined ? `Nedostaje vrednost${where}.` : `Pogrešan tip vrednosti${where}.`;
    case 'too_small':
    case 'too_big':
      return `Vrednost je van dozvoljenog opsega${where}.`;
    case 'unrecognized_keys':
      return `Nepoznato polje: ${iss.keys.join(', ')}.`;
    default:
      return `Neispravna vrednost${where}.`;
  }
};

function parse<T extends z.ZodType>(schema: T, data: unknown): z.output<T> {
  const r = schema.safeParse(data, { error: srErrorMap });
  if (!r.success) throw badRequest(r.error.issues[0]?.message ?? 'Neispravni podaci.');
  return r.data;
}

/** Telo zahteva kao JSON; prazno telo = {}. */
async function readJson(c: Context): Promise<unknown> {
  const text = await c.req.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw badRequest('Neispravan JSON u zahtevu.');
  }
}

async function body<T extends z.ZodType>(c: Context, schema: T): Promise<z.output<T>> {
  return parse(schema, await readJson(c));
}

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

const loginInput = z.object({ password: z.string({ error: 'Unesi lozinku.' }).max(1000) });

// ---- Pomoćnici ----

/** Adresa sa iste mašine (lokalni reverse proxy ili razvoj). */
function isLoopback(addr: string): boolean {
  const a = addr.replace(/^::ffff:/i, '');
  return a === '::1' || /^127\.\d+\.\d+\.\d+$/.test(a);
}

/**
 * Ključ klijenta za ograničenje: IPv4 adresa, a za IPv6 mreža /64 (jedan priključak obično
 * dobija ceo /64, pa bi menjanje adrese unutar njega zaobišlo ograničenje).
 */
function addressKey(addr: string): string {
  const a = addr
    .trim()
    .toLowerCase()
    .replace(/^\[([^\]]*)\](:\d+)?$/, '$1') // [v6]:port
    .replace(/%.*$/, '') // zona (fe80::1%eth0)
    .replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/, '')
    .replace(/^(\d+\.\d+\.\d+\.\d+):\d+$/, '$1'); // v4:port
  if (!a.includes(':')) return a;
  const [head, tail] = a.split('::', 2);
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const zeros = tail === undefined ? [] : Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0');
  const prefix = [...left, ...zeros, ...right].slice(0, 4).map((g) => g.replace(/^0+(?=.)/, ''));
  return `${prefix.join(':')}::/64`;
}

/**
 * Adresa klijenta za ograničenje pokušaja prijave. X-Forwarded-For može da lažira svako ko
 * direktno pristupa serveru, pa se uzima u obzir samo iza proxy-ja kome verujemo
 * (TRUST_PROXY=n: svaki proxy dopisuje adresu od koje je primio zahtev, pa je klijent n-ti unos
 * od kraja; Caddy = 1) ili sa iste mašine (poslednji unos). Kraći lanac od očekivanog (zahtev
 * je zaobišao proxy) → adresa konekcije.
 */
function clientAddress(c: Context, proxyHops: number): string {
  let peer = 'unknown';
  try {
    peer = getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    // Nema Node socket-a (npr. app.request u testu).
  }
  const hops = proxyHops > 0 ? proxyHops : isLoopback(peer) ? 1 : 0;
  if (hops > 0) {
    const chain = (c.req.header('x-forwarded-for') ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const addr = chain[chain.length - hops];
    if (addr) return addr;
  }
  return peer;
}

/** "15 minuta", "1 minut" */
function minutesLabel(n: number): string {
  return `${n} ${n % 10 === 1 && n % 100 !== 11 ? 'minut' : 'minuta'}`;
}

function sizeLimit(maxSize: number): MiddlewareHandler {
  return bodyLimit({
    maxSize,
    // Nepročitano telo ostaje na konekciji — zatvori je da klijent ne bi ponovo koristio isti socket.
    onError: (c) => c.json({ error: 'Zahtev je prevelik.' }, 413, { Connection: 'close' }),
  });
}

// ---- Rute ----

export function createApi({ db, repo, auth, proxyHops, build }: ApiDeps): Hono {
  const api = new Hono();
  const limiter = createLoginLimiter();
  const smallBody = sizeLimit(1 * MB);
  const largeBody = sizeLimit(20 * MB);

  const setSessionCookie = (c: Context) =>
    setCookie(c, SESSION_COOKIE, auth.issueSession(), {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: SESSION_MAX_AGE_S,
      secure: isHttps(c),
    });

  /** Važeća sesija; starija od 30 dana se obnavlja, pa uređaj koji se koristi ostaje prijavljen. */
  const hasSession = (c: Context): boolean => {
    const issuedAt = auth.sessionIssuedAt(getCookie(c, SESSION_COOKIE));
    if (issuedAt == null) return false;
    if (Date.now() - issuedAt > SESSION_RENEW_AFTER_MS) setSessionCookie(c);
    return true;
  };

  const authState = (c: Context): AuthState => ({
    authRequired: auth.required,
    authenticated: !auth.required || hasSession(c),
  });

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

  // Sve osim /api/health i /api/auth/* traži važeću sesiju.
  api.use('*', async (c, next) => {
    const p = c.req.path;
    if (auth.required && p !== '/api/health' && !p.startsWith('/api/auth/')) {
      if (!hasSession(c)) throw new HttpError(401, 'Nisi prijavljen.');
    }
    await next();
  });

  // ---- Zdravlje i prijava ----

  const health: HealthPayload = build ? { ok: true, build } : { ok: true };
  api.get('/health', (c) => c.json(health));

  api.get('/auth/me', (c) => c.json(authState(c)));

  api.post('/auth/login', async (c) => {
    const { password } = await body(c, loginInput);
    if (!auth.required) return c.json<AuthState>({ authRequired: false, authenticated: true });
    const address = clientAddress(c, proxyHops);
    const key = addressKey(address);
    const wait = limiter.retryAfter(key);
    if (wait > 0) {
      const minutes = Math.max(1, Math.ceil(wait / 60_000));
      return c.json(
        { error: `Previše pokušaja. Pokušaj ponovo za ${minutesLabel(minutes)}.` },
        429,
        { 'Retry-After': String(Math.ceil(wait / 1000)) },
      );
    }
    if (!auth.checkPassword(password)) {
      limiter.fail(key);
      // Adresa u logu: provera da li se iza proxy-ja vidi prava adresa klijenta (README, TRUST_PROXY).
      console.warn(`Ritam: pogrešna lozinka (adresa ${address.slice(0, 64).replace(/[^\w.:%[\]-]/g, '?')}).`);
      throw new HttpError(401, 'Pogrešna lozinka.');
    }
    limiter.reset(key);
    setSessionCookie(c);
    return c.json<AuthState>({ authRequired: true, authenticated: true });
  });

  api.post('/auth/logout', (c) => {
    deleteCookie(c, SESSION_COOKIE, { path: '/', httpOnly: true, sameSite: 'Lax', secure: isHttps(c) });
    return c.json<AuthState>({ authRequired: auth.required, authenticated: !auth.required });
  });

  // ---- Dan ----

  const day = (c: Context, date: string, ensure = false) => c.json(repo.dayPayload(date, ensure));
  const dateParam = (c: Context) => parseDateParam(c.req.param('date'));
  const idParam = (c: Context) => parseIdParam(c.req.param('id'));

  api.get('/days/:date', (c) => {
    const ensure = ['1', 'true'].includes(c.req.query('ensure') ?? '');
    return day(c, dateParam(c), ensure);
  });

  api.post('/days/:date/init', async (c) => {
    const date = dateParam(c);
    repo.initDayRequest(date, await body(c, dayInit));
    return day(c, date);
  });

  api.patch('/days/:date', async (c) => {
    const date = dateParam(c);
    repo.patchDay(date, await body(c, dayPatch));
    return day(c, date);
  });

  api.post('/days/:date/blocks', async (c) => {
    const date = dateParam(c);
    repo.addBlock(date, await body(c, blockInput));
    return day(c, date);
  });

  // ---- Blokovi ----

  api.patch('/blocks/:id', async (c) => {
    const id = idParam(c);
    const date = repo.patchBlock(id, await body(c, blockPatch));
    return day(c, date);
  });

  api.delete('/blocks/:id', (c) => day(c, repo.deleteBlock(idParam(c))));

  api.post('/blocks/:id/split', async (c) => {
    const id = idParam(c);
    const { at } = await body(c, splitInput);
    return day(c, repo.splitBlock(id, at));
  });

  // Zamena naslova i kategorije dva bloka istog dana; termini ostaju.
  api.post('/blocks/:id/swap', async (c) => {
    const id = idParam(c);
    const { with: withId } = await body(c, swapInput);
    return day(c, repo.swapBlocks(id, withId));
  });

  // ---- Zadaci ----

  api.post('/tasks', async (c) => {
    const { date, title, categoryId } = await body(c, taskInput);
    repo.addTask(date, title, categoryId);
    return day(c, date);
  });

  api.post('/tasks/carry', async (c) => {
    const { to } = await body(c, carryInput);
    repo.carryTasks(to);
    return day(c, to);
  });

  api.get('/tasks/done', (c) => {
    const from = parseDateParam(c.req.query('from'), 'Početni datum');
    const to = parseDateParam(c.req.query('to'), 'Krajnji datum');
    if (from > to) throw badRequest('Početni datum je posle krajnjeg.');
    return c.json(repo.doneTasks(from, to));
  });

  api.patch('/tasks/:id', async (c) => {
    const id = idParam(c);
    const oldDate = repo.patchTask(id, await body(c, taskPatch));
    return day(c, oldDate);
  });

  api.delete('/tasks/:id', (c) => day(c, repo.deleteTask(idParam(c))));

  // ---- Statistika i dnevnik ----

  api.get('/stats', (c) => {
    const from = parseDateParam(c.req.query('from'), 'Početni datum');
    const to = parseDateParam(c.req.query('to'), 'Krajnji datum');
    if (from > to) throw badRequest('Početni datum je posle krajnjeg.');
    if (diffDays(from, to) + 1 > MAX_STATS_DAYS) throw badRequest(`Opseg može imati najviše ${MAX_STATS_DAYS} dana.`);
    // Logičko danas klijenta (opciono): za završen period i poslednji dan prekida niz.
    const todayRaw = c.req.query('today');
    const today = todayRaw ? parseDateParam(todayRaw, 'Današnji datum') : undefined;
    return c.json(repo.stats(from, to, today));
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
    return c.json(repo.journal({ before, q, limit }));
  });

  // ---- Raspored ----

  const schedule = (c: Context) => c.json(repo.schedule());

  api.get('/schedule', schedule);

  // Raspored ispočetka: kategorije, šabloni i dani u nedelji; sačuvani dani, zadaci i beleške ostaju.
  api.post('/schedule/reset', async (c) => {
    repo.resetSchedule(await body(c, scheduleReset));
    return schedule(c);
  });

  api.post('/categories', async (c) => {
    repo.addCategory(await body(c, categoryInput));
    return schedule(c);
  });

  api.patch('/categories/:id', async (c) => {
    const id = idParam(c);
    repo.patchCategory(id, await body(c, categoryPatch));
    return schedule(c);
  });

  api.delete('/categories/:id', (c) => {
    repo.deleteCategory(idParam(c));
    return schedule(c);
  });

  api.post('/templates', async (c) => {
    const { name, copyFrom } = await body(c, templateInput);
    repo.addTemplate(name, copyFrom);
    return schedule(c);
  });

  api.patch('/templates/:id', async (c) => {
    const id = idParam(c);
    repo.patchTemplate(id, await body(c, templatePatch));
    return schedule(c);
  });

  api.delete('/templates/:id', (c) => {
    repo.deleteTemplate(idParam(c));
    return schedule(c);
  });

  api.put('/templates/:id/blocks', async (c) => {
    const id = idParam(c);
    const { blocks } = await body(c, templateBlocks);
    repo.putTemplateBlocks(id, blocks);
    return schedule(c);
  });

  api.put('/weekdays', async (c) => {
    repo.putWeekdays(await body(c, weekdayMap));
    return schedule(c);
  });

  api.patch('/settings', async (c) => {
    repo.patchSettings(await body(c, settingsPatch));
    return schedule(c);
  });

  // ---- Rezervna kopija ----

  api.get('/export', (c) => {
    c.header('Content-Disposition', `attachment; filename="ritam-backup-${localISODate()}.json"`);
    return c.json(exportData(db, repo.getSettings()));
  });

  api.post('/import', async (c) => {
    const input = await readJson(c);
    // Blokovi šablona koji su u kopiji ceo van logičkog dana prelaze na drugi kraj dana (isto pravilo kao
    // pri pokretanju i promeni dayStart) — u istoj transakciji kao uvoz.
    tx(db, () => {
      importData(db, input);
      repo.normalizeTemplateBlocks();
    });
    return c.json({ ok: true as const });
  });

  // Nepoznata API putanja ne sme da padne na SPA fallback.
  api.all('*', (c) => c.json({ error: 'Ne postoji.' }, 404));

  return api;
}
