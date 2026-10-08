// Smoke test celog API-ja na posebnoj (privremenoj) instanci servera, nikad na pravoj:
//   DATA_DIR=<privremen folder> PORT=3999 SIGNUP_CODE=x ACCESS_TOKEN_TTL_SEC=3 REFRESH_RACE_GRACE_SEC=2 npm start
//   DATA_DIR=<drugi privremen folder> PORT=3998 SIGNUP=closed npm start
//   BASE_URL=http://localhost:3999 SMOKE_CLOSED_URL=http://localhost:3998 SIGNUP_CODE=x REFRESH_RACE_GRACE_SEC=2 node scripts/smoke.mjs
// Bez SMOKE_CLOSED_URL provera zatvorene registracije je SKIP (zbir: "… PASS, 0 FAIL, 1 SKIP"), što nije greška.
//
// Test pravi svoje naloge (smoke-<oznaka>-…@example.test): A je glavni korisnik — kroz njega idu sve
// funkcionalne provere (prazan start, raspored, dani, blokovi, zadaci, statistika, dnevnik, izvoz/uvoz,
// "Raspored ispočetka" na uvezenoj bazi iz ranije verzije) — a B, C… proveravaju registraciju, prijavu,
// tokene, odjavu, promenu lozinke, ograničenja pokušaja i potpunu odvojenost podataka (B ne vidi i ne menja
// ništa od A). Svoje dane pravi na datumima u 2093–2099.
//
// Kratak ACCESS_TOKEN_TTL_SEC (npr. 3) proverava istek access tokena (401 token_expired → refresh → radi), a
// test usput stalno osvežava tokene kao klijent. REFRESH_RACE_GRACE_SEC (isti broj za server i test,
// podrazumevano 30) skraćuje čekanje za proveru ponovo upotrebljenog refresh tokena. SIGNUP_CODE (ili
// APP_PASSWORD) = kod za registraciju kad server traži kod. SMOKE_CLOSED_URL (opciono) = druga instanca sa
// SIGNUP=closed. Ograničenja pokušaja (lažne adrese preko X-Forwarded-For) se proveravaju samo na lokalnom
// serveru (SMOKE_RATE_LIMIT=0 ih preskače).
//
// Prvi nalog na serveru preuzima podatke iz verzije bez naloga: zato A pravi PRVI i odmah proverava da je
// prazan; ako nije (server je imao podatke bez vlasnika), test staje pre ikakve izmene i kaže kako da se
// podaci prebace u pravi nalog. Izlazni kod 1 ako bilo koja provera ne prođe.

// Isti kod kojim stranica dana računa ispunjenost i klijent pretvara zidno vreme u minute dana
// (Node 24 učitava .ts direktno).
import { summarizeBlocks } from '../shared/summary.ts';
import { normalizeRange, parseClock } from '../shared/time.ts';

if (!process.env.BASE_URL) {
  console.error('Postavi BASE_URL privremene instance (vidi uputstvo na vrhu fajla) — test menja podatke.');
  process.exit(2);
}
const BASE = process.env.BASE_URL.replace(/\/+$/, '');
const CODE = process.env.SIGNUP_CODE ?? process.env.APP_PASSWORD ?? process.env.CODE ?? '';
const RACE_GRACE_SEC = Number(process.env.REFRESH_RACE_GRACE_SEC || 30);
const REFRESH_TTL_SEC = Number(process.env.REFRESH_TOKEN_TTL_SEC || 90 * 24 * 60 * 60);
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
let failed = 0;
let skipped = 0;

// ---------------------------------------------------------------- pomoćnici

function check(name, cond, detail) {
  if (cond) {
    passed++;
    console.log(`PASS ${name}`);
  } else {
    failed++;
    const extra = detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
    console.log(`FAIL ${name}${extra.length > 400 ? extra.slice(0, 400) + '…' : extra}`);
  }
  return !!cond;
}

function skip(name, why) {
  skipped++;
  console.log(`SKIP ${name} (${why})`);
}

/** Pokreće grupu provera; izuzetak se broji kao FAIL, a ostale grupe idu dalje. */
async function section(name, fn) {
  try {
    await fn();
  } catch (err) {
    check(`${name}: bez izuzetka`, false, err?.stack || String(err));
  }
}

// ---- Nalozi i sesije testa ----

/** Nasumična adresa klijenta (X-Forwarded-For sa lokalne mašine): svaka grupa ima svoje ograničenje pokušaja. */
const fakeIp = () => `10.${(Math.random() * 250) | 0}.${(Math.random() * 250) | 0}.${((Math.random() * 250) | 0) + 1}`;

/** Korisnik (i jedna sesija = jedan uređaj): access token u memoriji, refresh token kao kolačić. */
function newUser(label) {
  return {
    label,
    email: `smoke-${label}-${RUN}@example.test`,
    password: `Lozinka-${label}-${RUN}`,
    id: null,
    token: null,
    exp: 0,
    cookie: '',
    ip: fakeIp(),
  };
}

/** Druga sesija istog korisnika (drugi uređaj): isti nalog, svoj kolačić i token. */
const device = (u) => ({ ...u, token: null, exp: 0, cookie: '', ip: fakeIp() });

let current = null; // korisnik za req() bez `as`

/** ritam_refresh iz Set-Cookie: nova vrednost ('' = obrisan) ili undefined (nije menjan). */
function refreshCookieFrom(headers) {
  for (const sc of headers.getSetCookie?.() ?? []) {
    const m = /^ritam_refresh=([^;]*)/.exec(sc);
    if (m) return m[1] ? `ritam_refresh=${m[1]}` : '';
  }
  return undefined;
}

/** Jedan HTTP zahtev bez ikakve automatike. */
async function rawReq(method, path, opts = {}) {
  const { body, headers = {}, csrf = true, rawBody, token, cookie, base = BASE } = opts;
  const h = { ...headers };
  if (csrf && method !== 'GET' && method !== 'HEAD') h['X-Ritam'] = '1';
  if (token) h.Authorization = `Bearer ${token}`;
  if (cookie) h.Cookie = cookie;
  let payload;
  if (rawBody !== undefined) {
    payload = rawBody;
    h['Content-Type'] = 'application/json';
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    h['Content-Type'] = 'application/json';
  }
  const res = await fetch(base + path, { method, headers: h, body: payload });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, json, text, setCookie: refreshCookieFrom(res.headers) };
}

/** Odgovor sa AuthResponse → sesija korisnika (token u memoriji, kolačić iz Set-Cookie). */
function applyAuth(u, r) {
  if (r.setCookie !== undefined) u.cookie = r.setCookie;
  if (r.json?.accessToken) {
    u.token = r.json.accessToken;
    u.exp = Date.now() + r.json.expiresIn * 1000;
    u.id = r.json.user?.id ?? u.id;
  }
  return r;
}

/** POST /api/auth/refresh sa kolačićem sesije (kao klijent: rotira kolačić, nov access token). */
async function refreshSession(u, opts = {}) {
  const r = await rawReq('POST', '/api/auth/refresh', { cookie: u.cookie, headers: { 'X-Forwarded-For': u.ip }, ...opts });
  if (r.setCookie !== undefined) u.cookie = r.setCookie;
  if (r.status === 200) applyAuth(u, r);
  return r;
}

/**
 * Zahtev kao korisnik `as` (podrazumevano `current`): Bearer token, kolačić samo za /api/auth/*. Kao klijent:
 * token kome ističe rok se prvo osveži, a 401 token_expired → refresh → isti zahtev još jednom.
 * `auth: false` = bez tokena (i bez kolačića).
 */
async function req(method, path, opts = {}) {
  const { as = current, auth = true, withCookie, retry = true, ...rest } = opts;
  const useAuth = auth && withCookie !== false && !!as;
  if (useAuth && as.token && as.cookie && Date.now() > as.exp - 1500) await refreshSession(as);
  const r = await rawReq(method, path, {
    ...rest,
    token: useAuth ? as.token : undefined,
    cookie: useAuth && path.startsWith('/api/auth/') ? as.cookie : undefined,
    headers: { ...(useAuth ? { 'X-Forwarded-For': as.ip } : {}), ...(rest.headers ?? {}) },
  });
  if (useAuth && r.setCookie !== undefined) as.cookie = r.setCookie;
  if (useAuth && retry && r.status === 401 && r.json?.code === 'token_expired' && as.cookie) {
    await refreshSession(as);
    return req(method, path, { ...opts, retry: false });
  }
  return r;
}

const get = (p, o) => req('GET', p, o);
const post = (p, body, o = {}) => req('POST', p, { ...o, body });
const patch = (p, body, o = {}) => req('PATCH', p, { ...o, body });
const put = (p, body, o = {}) => req('PUT', p, { ...o, body });
const del = (p, o) => req('DELETE', p, o);

/** Registracija (nova sesija); `code` podrazumevano kod iz env-a. */
async function register(u, { code = CODE, email = u.email, password = u.password, ip = u.ip } = {}) {
  const r = await rawReq('POST', '/api/auth/register', { body: { email, password, code }, headers: { 'X-Forwarded-For': ip } });
  if (r.status === 201) applyAuth(u, r);
  return r;
}

/** Prijava (nova sesija = nova familija refresh tokena). */
async function login(u, { email = u.email, password = u.password, ip = u.ip, headers = {} } = {}) {
  const r = await rawReq('POST', '/api/auth/login', { body: { email, password }, headers: { 'X-Forwarded-For': ip, ...headers } });
  if (r.status === 200) applyAuth(u, r);
  return r;
}

/** Očekuje status; vraća json (ili baca grešku da se grupa prekine). */
async function expectOk(name, promise, status = 200) {
  const r = await promise;
  if (!check(name, r.status === status, `status ${r.status}: ${r.text.slice(0, 200)}`)) {
    throw new Error(`${name}: neočekivan status ${r.status}`);
  }
  return r.json;
}

async function expectStatus(name, promise, status) {
  const r = await promise;
  check(name, r.status === status && (status < 400 || typeof r.json?.error === 'string'), `status ${r.status}: ${r.text.slice(0, 200)}`);
  return r;
}

/** Očekuje grešku sa tačnim statusom, porukom i (opciono) kodom. */
async function expectError(name, promise, status, error, code) {
  const r = await promise;
  check(
    name,
    r.status === status && (error === undefined || r.json?.error === error) && (code === undefined || r.json?.code === code),
    `status ${r.status}: ${r.text.slice(0, 200)}`,
  );
  return r;
}

const jwtClaims = (t) => {
  try {
    return JSON.parse(Buffer.from(String(t).split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return null;
  }
};

const pad = (n) => String(n).padStart(2, '0');
function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}
function isoWeekday(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return ((new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7) + 1;
}
function logicalToday(dayStart) {
  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  const local = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return mins < dayStart ? addDays(local, -1) : local;
}
const shape = (b) => [b.start, b.end, b.title, b.categoryId];
const sortShapes = (list) => [...list].sort((x, y) => x[0] - y[0] || x[1] - y[1] || String(x[2]).localeCompare(String(y[2])));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** Izvoz bez vremena izvoza (za poređenje identičnih podataka, i id-jeva). */
const rawStamp = (exp) => {
  const { exportedAt, ...rest } = exp ?? {};
  return rest;
};
/**
 * Izvoz bez vremena izvoza i bez konkretnih id-jeva: uvoz dodeljuje nove id-jeve (redosled ostaje), pa se
 * kopije porede tako što svaki id postane redni broj reda u svojoj tabeli (i veze isto).
 */
const withoutStamp = (exp) => {
  const x = rawStamp(exp);
  if (!Array.isArray(x.categories)) return x;
  const idx = (rows) => new Map((rows ?? []).map((r, i) => [r.id, i + 1]));
  const cat = idx(x.categories);
  const tpl = idx(x.templates);
  const tb = idx(x.template_blocks);
  const blk = idx(x.blocks);
  const tsk = idx(x.tasks);
  const c = (id) => (id == null ? null : (cat.get(id) ?? `?${id}`));
  const t = (id) => (id == null ? null : (tpl.get(id) ?? `?${id}`));
  return {
    ...x,
    categories: x.categories.map((r) => ({ ...r, id: cat.get(r.id) })),
    templates: x.templates.map((r) => ({ ...r, id: tpl.get(r.id) })),
    template_blocks: x.template_blocks.map((r) => ({ ...r, id: tb.get(r.id), template_id: t(r.template_id), category_id: c(r.category_id) })),
    weekday_templates: x.weekday_templates.map((r) => ({ ...r, template_id: t(r.template_id) })),
    days: x.days.map((r) => ({ ...r, template_id: t(r.template_id) })),
    blocks: x.blocks.map((r) => ({ ...r, id: blk.get(r.id), category_id: c(r.category_id) })),
    tasks: x.tasks.map((r) => ({ ...r, id: tsk.get(r.id), category_id: c(r.category_id) })),
  };
};
const near = (a, b) => typeof a === 'number' && Math.abs(a - b) < 1e-9;
const DATA_TABLES = ['categories', 'templates', 'template_blocks', 'days', 'blocks', 'tasks'];
const isEmptyExport = (e) => DATA_TABLES.every((k) => Array.isArray(e?.[k]) && e[k].length === 0);

// Datumi koje test koristi (daleko od stvarnih podataka).
const FUT = '2099-06-15';
const D1 = '2095-01-10'; // init / reset / templateId
const D2 = '2095-01-11'; // beleška i ocena bez inicijalizacije
const D3 = '2095-01-12'; // blokovi
const D4 = '2095-01-13'; // zadaci
const D5 = '2095-01-14'; // premeštanje zadatka
const D6 = '2095-01-15'; // carry izvor
const D7 = '2095-01-16'; // carry izvor
const D8 = '2095-01-17'; // carry cilj
const D9 = '2095-02-01'; // statistika
const D10 = '2095-02-02';
const D11 = '2095-02-03'; // samo otvoren dan (nije praćen)
const D12 = '2095-01-20'; // zamena blokova
const D13 = '2095-01-21'; // zamena: blok drugog dana
const D14 = '2095-03-10'; // baseNote na danu bez reda
const D15 = '2095-04-01'; // brisanje kategorije koja se ne računa
const E1 = '2094-06-01'; // prazna baza: pregled i ensure bez šablona
const E2 = '2094-06-02'; // prazna baza: init bez šablona
const E3 = '2094-06-03'; // prazna baza: blok, zadatak i beleška bez kategorija
const L1 = '2093-03-02'; // raspored ispočetka: praćen dan (stari šablon 1)
const L2 = '2093-03-03'; // raspored ispočetka: praćen dan (stari šablon 2)
const L3 = '2093-03-04'; // raspored ispočetka: samo beleška i ocena
const L4 = '2093-03-09'; // raspored ispočetka: dan bez reda (pregled iz šablona dana u nedelji)

/**
 * Baza kakvu ostavlja ranija verzija (nova baza je dobijala primer rasporeda: kategorije, šablone,
 * sve dane u nedelji sa šablonom i dan od 01:00), sa nekoliko već praćenih dana. Nazivi su neutralni.
 */
function legacyBackup() {
  const at = '2093-03-04T20:00:00.000Z';
  const block = (id, date, start_min, end_min, title, category_id, status, actual_min = null, note = '') => ({ id, date, start_min, end_min, title, category_id, status, actual_min, note });
  return {
    app: 'ritam',
    version: 1,
    exportedAt: at,
    settings: { dayStart: 60, streakThreshold: 0.7 },
    categories: [
      { id: 1, name: 'Stara A', color: '#5b6b9a', counts: 1, sort: 0, archived: 0 },
      { id: 2, name: 'Stara B', color: '#2f6db5', counts: 1, sort: 1, archived: 0 },
      { id: 3, name: 'Stara pauza', color: '#9a9890', counts: 0, sort: 2, archived: 0 },
      { id: 4, name: 'Stara obrisana', color: '#445566', counts: 1, sort: 3, archived: 1 },
    ],
    templates: [
      { id: 1, name: 'Stari šablon 1', sort: 0 },
      { id: 2, name: 'Stari šablon 2', sort: 1 },
    ],
    template_blocks: [
      { id: 1, template_id: 1, start_min: 60, end_min: 540, title: 'Noćni blok', category_id: 1 },
      { id: 2, template_id: 1, start_min: 555, end_min: 840, title: 'Blok B', category_id: 2 },
      { id: 3, template_id: 1, start_min: 840, end_min: 900, title: 'Pauza', category_id: 3 },
      { id: 4, template_id: 1, start_min: 1440, end_min: 1500, title: 'Posle ponoći', category_id: 1 },
      { id: 5, template_id: 2, start_min: 60, end_min: 540, title: 'Noćni blok', category_id: 1 },
      { id: 6, template_id: 2, start_min: 600, end_min: 720, title: 'Blok B', category_id: 2 },
    ],
    weekday_templates: [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, template_id: weekday <= 5 ? 1 : 2 })),
    days: [
      { date: L1, initialized: 1, template_id: 1, note: 'Stari dan', rating: 4, updated_at: at },
      { date: L2, initialized: 1, template_id: 2, note: '', rating: null, updated_at: at },
      { date: L3, initialized: 0, template_id: null, note: 'Samo beleška', rating: 3, updated_at: at },
    ],
    // L1: done + partial + pauza (ne računa se) + skipped u obrisanoj kategoriji → 1.5 / 3; L2: sve urađeno.
    blocks: [
      block(1, L1, 60, 540, 'Noćni blok', 1, 'done'),
      block(2, L1, 555, 840, 'Blok B', 2, 'partial', 100, 'beleška bloka'),
      block(3, L1, 840, 900, 'Pauza', 3, 'done'),
      block(4, L1, 1440, 1500, 'Posle ponoći', 4, 'skipped'),
      block(5, L2, 60, 540, 'Noćni blok', 1, 'done'),
      block(6, L2, 600, 720, 'Blok B', 2, 'done'),
    ],
    tasks: [
      { id: 1, date: L1, title: 'Stari zadatak', done: 1, done_at: at, category_id: 2, sort: 1, created_at: at },
      { id: 2, date: L2, title: 'Otvoren stari zadatak', done: 0, done_at: null, category_id: 3, sort: 1, created_at: at },
    ],
  };
}

/** Podešavanja nove baze (SPEC, sekcija 4). */
const EMPTY_SETTINGS = { dayStart: 0, streakThreshold: 0.7 };
const NO_TEMPLATES = { 1: null, 2: null, 3: null, 4: null, 5: null, 6: null, 7: null };
/** Početak dana sa kojim test pravi svoje šablone (zidno vreme → minuti dana, kao klijent). */
const FX_DAY_START = 60;
function wall(from, to, title, categoryId) {
  const { start, end } = normalizeRange(parseClock(from), parseClock(to), FX_DAY_START);
  return { start, end, title, categoryId };
}


// ---------------------------------------------------------------- testovi

let snapshot = null; // izvoz korisnika A na početku — vraća se na kraju
let fresh = false;
let schedule = null;
let signupPolicy = null;
const A = newUser('a');
const isLocal = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(new URL(BASE).hostname);

async function authSections() {
  // ---- Konfiguracija i prvi nalog (A) ----
  await section('auth config', async () => {
    const r = await get('/api/auth/config', { auth: false });
    check('config 200 { signup }', r.status === 200 && ['open', 'code', 'closed'].includes(r.json?.signup) && same(Object.keys(r.json), ['signup']), r.text);
    check('config: no-store', r.headers.get('cache-control') === 'no-store', r.headers.get('cache-control'));
    signupPolicy = r.json?.signup ?? null;
  });
  if (signupPolicy === 'closed') {
    throw new Error('Registracija je zatvorena (SIGNUP=closed) — test pravi svoje naloge; pokreni ga na privremenoj instanci sa SIGNUP=open ili kodom.');
  }
  if (signupPolicy === 'code' && !CODE) throw new Error('Server traži kod za registraciju — postavi SIGNUP_CODE (ili APP_PASSWORD) za test.');

  await section('register A', async () => {
    // A je prvi nalog testa (vidi uputstvo na vrhu): mešana slova i razmaci → email malim slovima.
    const shown = `  ${A.email.replace('smoke-a', 'Smoke-A').toUpperCase()}  `;
    const r = await expectOk('registracija A → 201', register(A, { email: shown }), 201);
    check('A: AuthResponse oblik', typeof r.accessToken === 'string' && r.accessToken.split('.').length === 3 && Number.isInteger(r.expiresIn) && r.expiresIn > 0 && same(Object.keys(r).sort(), ['accessToken', 'expiresIn', 'user']), r);
    check('A: email trim + mala slova', r.user?.email === A.email && Number.isInteger(r.user?.id) && r.user.id > 0 && same(Object.keys(r.user).sort(), ['email', 'id']), r.user);
    const claims = jwtClaims(r.accessToken);
    check('A: JWT claims (sub, typ, iat, exp)', claims?.sub === String(r.user.id) && claims?.typ === 'access' && claims.exp - claims.iat === r.expiresIn, claims);
    check('A: JWT header HS256', jwtClaims(`x.${r.accessToken.split('.')[0]}`)?.alg === 'HS256');
    check('A: kolačić ritam_refresh', /^ritam_refresh=[A-Za-z0-9_-]{40,}$/.test(A.cookie), A.cookie);
    const exp = await expectOk('A: izvoz odmah posle registracije', get('/api/export', { as: A }));
    if (!isEmptyExport(exp)) {
      console.log(
        `\nSTOP: nalog ${A.email} (lozinka ${A.password}) je PRVI nalog na ovom serveru i preuzeo je postojeće podatke ` +
          'iz verzije bez naloga. Ništa nije menjano. Prijavi se njime, preuzmi kopiju (Podešavanja → Preuzmi kopiju), ' +
          'pa je uvezi u svoj nalog. Smoke test pokreći samo na privremenoj instanci.\n',
      );
      throw new Error('A je preuzeo postojeće podatke — prekidam pre ikakve izmene.');
    }
    fresh = true;
  });
  if (!fresh) throw new Error('Nalog A nije napravljen — prekidam.');
  current = A;

  await section('register', async () => {
    const r0 = await rawReq('POST', '/api/auth/register', { body: { email: A.email, password: A.password, code: CODE }, headers: { 'X-Forwarded-For': A.ip } });
    const sc = r0.headers.getSetCookie?.() ?? [];
    check('duplikat: 409 bez kolačića', r0.status === 409 && sc.length === 0, r0.text);
    const ip = fakeIp();
    const reg = (body, o = {}) => rawReq('POST', '/api/auth/register', { body, headers: { 'X-Forwarded-For': ip }, ...o });
    const X = newUser('x');
    await expectStatus('registracija bez X-Ritam → 403', reg({ email: X.email, password: X.password, code: CODE }, { csrf: false }), 403);
    await expectStatus('registracija: neispravan JSON → 400', rawReq('POST', '/api/auth/register', { rawBody: '{"email": ', headers: { 'X-Forwarded-For': ip } }), 400);
    await expectError('registracija: neispravan email → 400', reg({ email: 'nije-email', password: X.password, code: CODE }), 400, 'Unesi ispravnu email adresu.');
    await expectError('registracija: email bez domena → 400', reg({ email: 'a@b', password: X.password, code: CODE }), 400, 'Unesi ispravnu email adresu.');
    await expectError('registracija: bez emaila → 400', reg({ password: X.password, code: CODE }), 400, 'Unesi ispravnu email adresu.');
    await expectError('registracija: email > 254 → 400', reg({ email: `${'x'.repeat(250)}@example.test`, password: X.password, code: CODE }), 400, 'Unesi ispravnu email adresu.');
    await expectError('registracija: lozinka 7 znakova → 400', reg({ email: X.email, password: 'kratka7', code: CODE }), 400, 'Lozinka mora imati bar 8 znakova.');
    await expectError('registracija: bez lozinke → 400', reg({ email: X.email, code: CODE }), 400, 'Lozinka mora imati bar 8 znakova.');
    await expectError('registracija: lozinka 201 znak → 400', reg({ email: X.email, password: 'x'.repeat(201), code: CODE }), 400, 'Lozinka može imati najviše 200 znakova.');
    if (signupPolicy === 'code') {
      await expectError('registracija bez koda → 403 bad_code', reg({ email: X.email, password: X.password }), 403, 'Pogrešan kod za registraciju.', 'bad_code');
      await expectError('registracija pogrešan kod → 403 bad_code', reg({ email: X.email, password: X.password, code: `${CODE}x` }), 403, 'Pogrešan kod za registraciju.', 'bad_code');
      await expectError('duplikat sa pogrešnim kodom → 403 (kod pre emaila)', reg({ email: A.email, password: X.password, code: 'pogresan' }), 403, undefined, 'bad_code');
    } else {
      skip('registracija: provere koda', `server nema kod (signup: ${signupPolicy})`);
    }
    await expectError('duplikat (velika slova) → 409', reg({ email: A.email.toUpperCase(), password: X.password, code: CODE }), 409, 'Nalog sa tom email adresom već postoji.');
    const lg = await login(X, { ip });
    check('neuspela registracija ne pravi nalog', lg.status === 401, lg.text);
  });

  // ---- Prijava ----
  await section('login', async () => {
    const ip = fakeIp();
    await expectError('prijava pogrešna lozinka → 401', rawReq('POST', '/api/auth/login', { body: { email: A.email, password: 'pogresna-lozinka' }, headers: { 'X-Forwarded-For': ip } }), 401, 'Pogrešan email ili lozinka.');
    await expectError('prijava nepostojeći email → 401 (ista poruka)', rawReq('POST', '/api/auth/login', { body: { email: `nema-${RUN}@example.test`, password: A.password }, headers: { 'X-Forwarded-For': ip } }), 401, 'Pogrešan email ili lozinka.');
    await expectError('prijava neispravan email → 401', rawReq('POST', '/api/auth/login', { body: { email: 'nije-email', password: A.password }, headers: { 'X-Forwarded-For': ip } }), 401, 'Pogrešan email ili lozinka.');
    await expectStatus('prijava bez lozinke → 400', rawReq('POST', '/api/auth/login', { body: { email: A.email }, headers: { 'X-Forwarded-For': ip } }), 400);
    // Tab iz verzije pre naloga šalje samo { password } (APP_PASSWORD): poruka kaže da osveži stranicu.
    await expectError('prijava bez emaila (stari klijent) → 400 client_outdated', rawReq('POST', '/api/auth/login', { body: { password: 'stara-lozinka-aplikacije' }, headers: { 'X-Forwarded-For': ip } }), 400, 'Ritam je ažuriran. Osveži stranicu (ili zatvori i ponovo otvori aplikaciju), pa se prijavi email-om.', 'client_outdated');
    await expectStatus('prijava bez X-Ritam → 403', rawReq('POST', '/api/auth/login', { body: { email: A.email, password: A.password }, csrf: false, headers: { 'X-Forwarded-For': ip } }), 403);
    const S = device(A);
    const r = await expectOk('prijava (email velikim slovima) → 200', login(S, { email: ` ${A.email.toUpperCase()} `, ip }));
    check('prijava: isti korisnik', r.user?.id === A.id && r.user?.email === A.email, r.user);
    check('prijava: nov kolačić (nova sesija)', /^ritam_refresh=/.test(S.cookie) && S.cookie !== A.cookie, S.cookie);
    const raw = await rawReq('POST', '/api/auth/login', { body: { email: A.email, password: A.password }, headers: { 'X-Forwarded-For': ip, 'X-Forwarded-Proto': 'https', Cookie: 'ritam_session=v1.1700000000000.AAAA' } });
    const sc = raw.headers.getSetCookie?.() ?? [];
    const rc = sc.find((x) => x.startsWith('ritam_refresh=')) ?? '';
    check('kolačić: HttpOnly, SameSite=Strict, Path=/api/auth', /HttpOnly/i.test(rc) && /SameSite=Strict/i.test(rc) && /Path=\/api\/auth(;|$)/.test(rc), rc);
    check(`kolačić: Max-Age ${REFRESH_TTL_SEC}`, new RegExp(`Max-Age=${REFRESH_TTL_SEC}(;|$)`).test(rc), rc);
    check('kolačić: Secure preko HTTPS-a', /;\s*Secure/i.test(rc), rc);
    check('kolačić: bez Secure preko HTTP-a', !/;\s*Secure/i.test(A.cookie) && !(await rawReq('POST', '/api/auth/login', { body: { email: A.email, password: A.password }, headers: { 'X-Forwarded-For': ip } })).headers.getSetCookie().some((x) => /Secure/i.test(x)));
    check('stari kolačić ritam_session se briše', sc.some((x) => /^ritam_session=;/.test(x) && /Max-Age=0/i.test(x) && /Path=\/(;|$)/.test(x)), sc);
  });

  // ---- Access token ----
  await section('bearer', async () => {
    const protectedRoutes = [
      ['GET', '/api/schedule'],
      ['GET', '/api/days/2095-01-10'],
      ['POST', '/api/days/2095-01-10/init'],
      ['PATCH', '/api/days/2095-01-10'],
      ['POST', '/api/days/2095-01-10/blocks'],
      ['PATCH', '/api/blocks/1'],
      ['DELETE', '/api/blocks/1'],
      ['POST', '/api/blocks/1/split'],
      ['POST', '/api/blocks/1/swap'],
      ['POST', '/api/tasks'],
      ['PATCH', '/api/tasks/1'],
      ['DELETE', '/api/tasks/1'],
      ['POST', '/api/tasks/carry'],
      ['GET', '/api/tasks/done?from=2095-01-01&to=2095-01-02'],
      ['GET', '/api/stats?from=2095-01-01&to=2095-01-02'],
      ['GET', '/api/journal'],
      ['POST', '/api/categories'],
      ['PATCH', '/api/categories/1'],
      ['DELETE', '/api/categories/1'],
      ['POST', '/api/templates'],
      ['PATCH', '/api/templates/1'],
      ['DELETE', '/api/templates/1'],
      ['PUT', '/api/templates/1/blocks'],
      ['PUT', '/api/weekdays'],
      ['PATCH', '/api/settings'],
      ['POST', '/api/schedule/reset'],
      ['GET', '/api/export'],
      ['POST', '/api/import'],
      ['GET', '/api/auth/me'],
      ['POST', '/api/auth/password'],
      ['GET', '/api/ne-postoji'],
    ];
    const bad = [];
    for (const [m, p] of protectedRoutes) {
      const r = await rawReq(m, p, { body: m === 'GET' ? undefined : {} });
      if (!(r.status === 401 && r.json?.error === 'Nisi prijavljen.' && r.json?.code === 'unauthorized')) bad.push([m, p, r.status, r.text.slice(0, 80)]);
    }
    check(`${protectedRoutes.length} zaštićenih ruta bez tokena → 401 unauthorized`, bad.length === 0, bad);
    await refreshSession(A); // svež token (kratak ACCESS_TOKEN_TTL_SEC u testu)
    const tok = A.token;
    const [h, p, s] = tok.split('.');
    const tries = {
      'smeće': 'abc',
      'pokvaren potpis': `${h}.${p}.${s.slice(0, -2)}${s.endsWith('AA') ? 'BB' : 'AA'}`,
      'izmenjen sub': `${h}.${Buffer.from(JSON.stringify({ ...jwtClaims(tok), sub: String(A.id + 1) })).toString('base64url')}.${s}`,
      'alg none': `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${p}.`,
    };
    for (const [name, t] of Object.entries(tries)) {
      await expectError(`token: ${name} → 401 unauthorized`, rawReq('GET', '/api/schedule', { token: t }), 401, 'Nisi prijavljen.', 'unauthorized');
    }
    await expectError('Authorization bez "Bearer" → 401', rawReq('GET', '/api/schedule', { headers: { Authorization: tok } }), 401, undefined, 'unauthorized');
    await expectError('stari kolačić ritam_session ne prijavljuje', rawReq('GET', '/api/schedule', { cookie: 'ritam_session=v1.1700000000000.AAAA' }), 401, undefined, 'unauthorized');
    await expectError('refresh kolačić nije access token', rawReq('GET', '/api/schedule', { cookie: A.cookie }), 401, undefined, 'unauthorized');
    await expectStatus('važeći token ("bearer" malim slovima) → 200', rawReq('GET', '/api/schedule', { headers: { Authorization: `bearer ${tok}` } }), 200);
    const me = await expectOk('GET /api/auth/me', get('/api/auth/me'));
    check('me: { user: { id, email } }', same(me, { user: { id: A.id, email: A.email } }), me);
    await expectStatus('izmena bez X-Ritam (sa tokenom) → 403', patch('/api/settings', { dayStart: 0 }, { csrf: false }), 403);
    const unknown = await get('/api/ne-postoji');
    check('nepoznata API ruta (prijavljen) → 404 JSON', unknown.status === 404 && typeof unknown.json?.error === 'string', unknown.text);
    const health = await rawReq('GET', '/api/health');
    check('health bez tokena → 200', health.status === 200 && health.json?.ok === true, health.text);
  });

  await section('access expiry', async () => {
    const S = device(A);
    const r = await expectOk('istek: nova sesija', login(S));
    if (r.expiresIn > 10) {
      skip('istek access tokena', `ACCESS_TOKEN_TTL_SEC=${r.expiresIn} (za proveru pokreni server sa npr. 3)`);
      return;
    }
    const old = S.token;
    await sleep(r.expiresIn * 1000 + 1100);
    await expectError('istekao token → 401 token_expired', rawReq('GET', '/api/schedule', { token: old }), 401, 'Nisi prijavljen.', 'token_expired');
    await expectError('istekao token: /api/auth/me → 401 token_expired', rawReq('GET', '/api/auth/me', { token: old }), 401, undefined, 'token_expired');
    const rr = await refreshSession(S);
    check('posle isteka: refresh → 200 i nov token', rr.status === 200 && S.token !== old && rr.json?.user?.id === A.id, rr.text);
    await expectStatus('nov token radi', rawReq('GET', '/api/schedule', { token: S.token }), 200);
  });

  // ---- Refresh: rotacija, trka između tabova, ponovo upotrebljen token ----
  await section('refresh', async () => {
    await expectError('refresh bez kolačića → 401 no_session', rawReq('POST', '/api/auth/refresh'), 401, 'Nisi prijavljen.', 'no_session');
    let r = await rawReq('POST', '/api/auth/refresh', { cookie: 'ritam_refresh=abc' });
    check('refresh neispravan kolačić → 401 invalid_refresh + briše kolačić', r.status === 401 && r.json?.code === 'invalid_refresh' && r.setCookie === '', [r.status, r.text, r.setCookie]);
    r = await rawReq('POST', '/api/auth/refresh', { cookie: `ritam_refresh=${'A'.repeat(43)}` });
    check('refresh nepoznat token → 401 invalid_refresh', r.status === 401 && r.json?.code === 'invalid_refresh', r.text);
    await expectStatus('refresh bez X-Ritam → 403', rawReq('POST', '/api/auth/refresh', { cookie: A.cookie, csrf: false }), 403);

    const S = device(A);
    await expectOk('refresh: nova sesija', login(S));
    const t1 = S.cookie;
    const tok1 = S.token;
    r = await refreshSession(S);
    const t2 = S.cookie;
    check('refresh → 200, AuthResponse', r.status === 200 && typeof r.json?.accessToken === 'string' && r.json?.user?.id === A.id && r.json?.user?.email === A.email && Number.isInteger(r.json?.expiresIn), r.text);
    check('refresh: rotiran kolačić', /^ritam_refresh=/.test(t2) && t2 !== t1, [t1, t2]);
    const rc = (r.headers.getSetCookie?.() ?? []).find((x) => x.startsWith('ritam_refresh=')) ?? '';
    check('refresh: kolačić HttpOnly, Strict, Path=/api/auth, Max-Age', /HttpOnly/i.test(rc) && /SameSite=Strict/i.test(rc) && /Path=\/api\/auth/.test(rc) && /Max-Age=\d+/.test(rc), rc);
    check('refresh: nov access token radi', (await rawReq('GET', '/api/schedule', { token: S.token })).status === 200 && jwtClaims(S.token)?.iat >= jwtClaims(tok1)?.iat);

    // Drugi tab je istovremeno poslao isti (upravo zamenjen) token: 401 refresh_race, bez ikakve izmene.
    r = await rawReq('POST', '/api/auth/refresh', { cookie: t1 });
    check('isti stari token odmah → 401 refresh_race', r.status === 401 && r.json?.code === 'refresh_race' && r.json?.error === 'Nisi prijavljen.', r.text);
    check('refresh_race ne briše kolačić', r.setCookie === undefined, r.headers.getSetCookie?.());
    r = await refreshSession(S);
    const t3 = S.cookie;
    check('posle trke sesija i dalje radi (nov token)', r.status === 200 && t3 !== t2, r.text);

    if (RACE_GRACE_SEC > 35) {
      skip('ponovo upotrebljen stari token posle roka', `REFRESH_RACE_GRACE_SEC=${RACE_GRACE_SEC}`);
    } else {
      await sleep(RACE_GRACE_SEC * 1000 + 600);
      r = await rawReq('POST', '/api/auth/refresh', { cookie: t1 });
      check('stari token posle roka (krađa) → 401 invalid_refresh + briše kolačić', r.status === 401 && r.json?.code === 'invalid_refresh' && r.setCookie === '', [r.status, r.text]);
      r = await rawReq('POST', '/api/auth/refresh', { cookie: t3 });
      check('krađa opoziva celu sesiju: i najnoviji token → 401', r.status === 401 && r.json?.code === 'invalid_refresh', r.text);
      r = await rawReq('POST', '/api/auth/refresh', { cookie: t2 });
      check('i srednji token → 401 invalid_refresh', r.status === 401 && r.json?.code === 'invalid_refresh', r.text);
    }
    r = await refreshSession(A);
    check('druga sesija istog korisnika (A) nije pogođena', r.status === 200, r.text);
  });

  // ---- Odjava ----
  await section('logout', async () => {
    const S = device(A);
    await expectOk('odjava: nova sesija', login(S));
    const old = S.cookie;
    const r = await rawReq('POST', '/api/auth/logout', { cookie: old });
    const sc = (r.headers.getSetCookie?.() ?? []).find((x) => x.startsWith('ritam_refresh=')) ?? '';
    check('odjava → 200 { ok: true }', r.status === 200 && same(r.json, { ok: true }), r.text);
    check('odjava briše kolačić (Max-Age=0, Path=/api/auth)', /^ritam_refresh=;/.test(sc) && /Max-Age=0/i.test(sc) && /Path=\/api\/auth/.test(sc), sc);
    const rr = await rawReq('POST', '/api/auth/refresh', { cookie: old });
    check('posle odjave: refresh → 401 invalid_refresh', rr.status === 401 && rr.json?.code === 'invalid_refresh', rr.text);
    check('odjava bez kolačića → 200', same((await rawReq('POST', '/api/auth/logout')).json, { ok: true }));
    check('odjava sa neispravnim kolačićem → 200', (await rawReq('POST', '/api/auth/logout', { cookie: 'ritam_refresh=abc' })).status === 200);
    await expectStatus('odjava bez X-Ritam → 403', rawReq('POST', '/api/auth/logout', { cookie: A.cookie, csrf: false }), 403);
    const a = await refreshSession(A);
    check('odjava jednog uređaja ne odjavljuje drugi', a.status === 200, a.text);
  });

  // ---- Promena lozinke ----
  await section('password', async () => {
    const C = newUser('c');
    await expectOk('C: registracija', register(C), 201);
    check('C nije prvi nalog (prazan)', isEmptyExport(await expectOk('C: izvoz', get('/api/export', { as: C }))));
    const C2 = device(C);
    await expectOk('C: druga sesija (drugi uređaj)', login(C2));
    const oldCookie = C.cookie;
    const newPassword = `${C.password}-nova`;
    await expectError('promena lozinke bez tokena → 401', rawReq('POST', '/api/auth/password', { body: { currentPassword: C.password, newPassword } }), 401, undefined, 'unauthorized');
    await expectStatus('promena lozinke bez X-Ritam → 403', post('/api/auth/password', { currentPassword: C.password, newPassword }, { as: C, csrf: false }), 403);
    await expectError('pogrešna trenutna lozinka → 401 bad_password', post('/api/auth/password', { currentPassword: 'pogresna-lozinka', newPassword }, { as: C }), 401, 'Trenutna lozinka nije tačna.', 'bad_password');
    await expectError('nova lozinka prekratka → 400', post('/api/auth/password', { currentPassword: C.password, newPassword: 'kratko' }, { as: C }), 400, 'Lozinka mora imati bar 8 znakova.');
    await expectError('nova lozinka > 200 → 400', post('/api/auth/password', { currentPassword: C.password, newPassword: 'x'.repeat(201) }, { as: C }), 400, 'Lozinka može imati najviše 200 znakova.');
    check('posle odbijenih promena C2 i dalje radi', (await refreshSession(C2)).status === 200);
    const r = await post('/api/auth/password', { currentPassword: C.password, newPassword }, { as: C });
    check('promena lozinke → 200 AuthResponse', r.status === 200 && typeof r.json?.accessToken === 'string' && r.json?.user?.id === C.id && r.json?.user?.email === C.email, r.text);
    applyAuth(C, r);
    check('promena lozinke: nov kolačić', /^ritam_refresh=/.test(C.cookie) && C.cookie !== oldCookie, C.cookie);
    let x = await rawReq('POST', '/api/auth/refresh', { cookie: C2.cookie });
    check('drugi uređaj odjavljen (refresh → 401 invalid_refresh)', x.status === 401 && x.json?.code === 'invalid_refresh', x.text);
    x = await rawReq('POST', '/api/auth/refresh', { cookie: oldCookie });
    check('stari kolačić ovog uređaja → 401 invalid_refresh', x.status === 401 && x.json?.code === 'invalid_refresh', x.text);
    x = await refreshSession(C);
    check('nov kolačić ovog uređaja radi', x.status === 200, x.text);
    await expectError('prijava starom lozinkom → 401', rawReq('POST', '/api/auth/login', { body: { email: C.email, password: C.password }, headers: { 'X-Forwarded-For': C.ip } }), 401, 'Pogrešan email ili lozinka.');
    const C3 = device(C);
    await expectOk('prijava novom lozinkom → 200', login(C3, { password: newPassword }));
    C.password = newPassword;
  });

  // ---- Ograničenje pokušaja (lažna adresa preko X-Forwarded-For radi samo sa lokalnog klijenta) ----
  await section('rate limit', async () => {
    if (!isLocal) return skip('ograničenja pokušaja', 'server nije lokalni');
    if (process.env.SMOKE_RATE_LIMIT === '0') return skip('ograničenja pokušaja', 'SMOKE_RATE_LIMIT=0');
    const R = newUser('r');
    await expectOk('R: registracija', register(R), 201);
    const ip1 = fakeIp();
    const statuses = [];
    for (let i = 0; i < 10; i++) {
      const r = await rawReq('POST', '/api/auth/login', { body: { email: R.email, password: `pogresno-${i}` }, headers: { 'X-Forwarded-For': ip1 } });
      statuses.push(r.status);
    }
    check('10 pogrešnih → 401', statuses.every((s) => s === 401), statuses);
    const r = await rawReq('POST', '/api/auth/login', { body: { email: R.email, password: R.password }, headers: { 'X-Forwarded-For': ip1 } });
    check('11. pokušaj (i tačna lozinka) → 429', r.status === 429 && r.json?.error === 'Previše pokušaja. Pokušaj ponovo za 15 minuta.' && r.json?.code === 'rate_limited', r.text);
    const retry = Number(r.headers.get('retry-after'));
    check('429: Retry-After u sekundama (do 15 min)', Number.isInteger(retry) && retry > 840 && retry <= 900, r.headers.get('retry-after'));
    const byEmail = await rawReq('POST', '/api/auth/login', { body: { email: R.email, password: R.password }, headers: { 'X-Forwarded-For': fakeIp() } });
    check('isti email sa druge adrese → 429 (ograničenje po emailu)', byEmail.status === 429, byEmail.text);
    const byIp = await rawReq('POST', '/api/auth/login', { body: { email: A.email, password: A.password }, headers: { 'X-Forwarded-For': ip1 } });
    check('drugi email sa iste adrese → 429 (ograničenje po adresi)', byIp.status === 429, byIp.text);
    const other = await rawReq('POST', '/api/auth/login', { body: { email: `nema-${RUN}@example.test`, password: 'pogresno' }, headers: { 'X-Forwarded-For': fakeIp() } });
    check('drugi email sa druge adrese nije blokiran', other.status === 401, other.text);
    check('A se i dalje prijavljuje (druga adresa)', (await login(device(A))).status === 200);
    // Sesija R ostaje (blokirana je samo prijava).
    check('postojeća sesija R radi i dok je prijava blokirana', (await refreshSession(R)).status === 200);

    // Uspele prijave se ne broje: više uređaja (ili cela kuća iza jedne adrese) ne dolazi do blokade.
    const ipOk = fakeIp();
    const okStatuses = [];
    for (let i = 0; i < 12; i++) okStatuses.push((await login(device(A), { ip: ipOk })).status);
    check('12 uspelih prijava sa iste adrese → sve 200', okStatuses.every((s) => s === 200), okStatuses);
    const N = newUser('n');
    await expectOk('N: registracija', register(N), 201);
    const nOk = await login(device(N), { ip: ipOk });
    check('i drugi nalog sa te adrese → 200', nOk.status === 200, nOk.text);
    // …ali uspela prijava ne briše ranije neuspehe sa adrese (sopstveni nalog ne poništava blokadu).
    const ipMix = fakeIp();
    const wrong = (i) => rawReq('POST', '/api/auth/login', { body: { email: `nema-${i}-${RUN}@example.test`, password: 'pogresno' }, headers: { 'X-Forwarded-For': ipMix } });
    const mix = [];
    for (let i = 0; i < 9; i++) mix.push((await wrong(i)).status);
    mix.push((await login(device(A), { ip: ipMix })).status);
    mix.push((await wrong(9)).status);
    check('9 neuspelih, uspela, neuspela sa iste adrese → 401…, 200, 401', same(mix, [...Array(9).fill(401), 200, 401]), mix);
    const afterMix = await login(device(A), { ip: ipMix });
    check('posle 10 neuspelih (uspela se ne računa) → 429', afterMix.status === 429 && afterMix.json?.code === 'rate_limited', afterMix.text);

    // Tuđe neuspele prijave email-om naloga ne blokiraju promenu lozinke prijavljenom vlasniku.
    const Q = newUser('q');
    await expectOk('Q: registracija', register(Q), 201);
    const ipQ = fakeIp();
    const qs = [];
    for (let i = 0; i < 10; i++) {
      qs.push((await rawReq('POST', '/api/auth/login', { body: { email: Q.email, password: `pogresno-${i}` }, headers: { 'X-Forwarded-For': ipQ } })).status);
    }
    check('10 tuđih pogrešnih prijava Q email-om → 401', qs.every((s) => s === 401), qs);
    check('prijava Q (druga adresa) → 429 (ograničenje po email-u)', (await login(device(Q))).status === 429);
    const qNew = `${Q.password}-nova`;
    const qp = await post('/api/auth/password', { currentPassword: Q.password, newPassword: qNew }, { as: Q });
    check('promena lozinke prijavljenom Q i dalje radi → 200', qp.status === 200 && qp.json?.user?.id === Q.id, qp.text);
    check('posle promene lozinke Q se prijavljuje novom lozinkom', (await login(device(Q), { password: qNew })).status === 200);

    // Registracija: 10 pokušaja po adresi u 15 min (i uspeli; ograničava i pogađanje koda).
    const ipR = fakeIp();
    const reg = [];
    for (let i = 0; i < 10; i++) {
      const rr = await rawReq('POST', '/api/auth/register', { body: { email: A.email, password: A.password, code: signupPolicy === 'code' ? `pogresno-${i}` : CODE }, headers: { 'X-Forwarded-For': ipR } });
      reg.push(rr.status);
    }
    check('10 odbijenih registracija (403/409)', reg.every((s) => s === (signupPolicy === 'code' ? 403 : 409)), reg);
    const R2 = newUser('r2');
    const r11 = await register(R2, { ip: ipR });
    check('11. registracija sa iste adrese → 429', r11.status === 429 && r11.json?.code === 'rate_limited' && Number(r11.headers.get('retry-after')) > 0, r11.text);
    check('registracija sa druge adrese radi', (await register(R2, { ip: fakeIp() })).status === 201);

    // Provera trenutne lozinke (promena lozinke) se broji kao neuspela prijava za taj email.
    const P = newUser('p');
    await expectOk('P: registracija', register(P), 201);
    const ps = [];
    for (let i = 0; i < 10; i++) ps.push((await post('/api/auth/password', { currentPassword: `pogresno-${i}`, newPassword: 'nova-lozinka-1' }, { as: P })).status);
    check('10 pogrešnih trenutnih lozinki → 401', ps.every((s) => s === 401), ps);
    const p11 = await post('/api/auth/password', { currentPassword: P.password, newPassword: 'nova-lozinka-1' }, { as: P });
    check('11. promena lozinke → 429', p11.status === 429, p11.text);
    const pl = await rawReq('POST', '/api/auth/login', { body: { email: P.email, password: P.password }, headers: { 'X-Forwarded-For': fakeIp() } });
    check('i prijava tim emailom → 429', pl.status === 429, pl.text);
  });

  await section('closed signup', async () => {
    const url = process.env.SMOKE_CLOSED_URL?.replace(/\/+$/, '');
    if (!url) return skip('zatvorena registracija', 'postavi SMOKE_CLOSED_URL (instanca sa SIGNUP=closed)');
    const cfg = await rawReq('GET', '/api/auth/config', { base: url });
    check('zatvorena: config { signup: "closed" }', same(cfg.json, { signup: 'closed' }), cfg.text);
    await expectError('zatvorena: registracija → 403 signup_closed', rawReq('POST', '/api/auth/register', { base: url, body: { email: `z-${RUN}@example.test`, password: 'lozinka-123', code: CODE } }), 403, 'Registracija nije otvorena.', 'signup_closed');
    await expectError('zatvorena: i neispravno telo → 403', rawReq('POST', '/api/auth/register', { base: url, body: {} }), 403, undefined, 'signup_closed');
    await expectError('zatvorena: prijava radi (nepostojeći nalog → 401)', rawReq('POST', '/api/auth/login', { base: url, body: { email: `z-${RUN}@example.test`, password: 'lozinka-123' }, headers: { 'X-Forwarded-For': fakeIp() } }), 401, 'Pogrešan email ili lozinka.');
  });
}

async function main() {
  console.log(`Ritam smoke test → ${BASE}`);

  // ---- Zdravlje, bezbednosni headeri ----
  await section('health', async () => {
    const r = await get('/api/health');
    check('health 200 {ok:true}', r.status === 200 && r.json?.ok === true, r.text);
    check('health: CSP header', (r.headers.get('content-security-policy') || '').includes("default-src 'self'"));
    check('health: nosniff', r.headers.get('x-content-type-options') === 'nosniff');
    check('health: X-Frame-Options DENY', r.headers.get('x-frame-options') === 'DENY');
    check('health: Referrer-Policy', r.headers.get('referrer-policy') === 'same-origin');
    const root = await get('/', { withCookie: false });
    check('GET / odgovara (build ili uputstvo)', root.status === 200, `status ${root.status}`);

    // build = glavni JS iz index.html koji server servira (klijent ga poredi sa svojim, lib/pwa.ts).
    const keys = Object.keys(r.json ?? {}).sort();
    const entry = /<script type="module"[^>]*\ssrc="(\/assets\/[^"]+)"/.exec(root.text)?.[1];
    if (entry) {
      check('health: build = glavni JS iz index.html', r.json?.build === entry && same(keys, ['build', 'ok']), [r.json, entry]);
      const js = await get(entry, { withCookie: false });
      check('health: build fajl postoji (JS, immutable)', js.status === 200 && /javascript/.test(js.headers.get('content-type') || '') && /immutable/.test(js.headers.get('cache-control') || ''), `status ${js.status}`);
    } else {
      check('health: bez web build-a nema build polja', same(keys, ['ok']), r.json);
    }
    check('health: Cache-Control no-store', r.headers.get('cache-control') === 'no-store', r.headers.get('cache-control'));
    check('health: bez HSTS preko HTTP-a', r.headers.get('strict-transport-security') === null, r.headers.get('strict-transport-security'));
    const tls = await get('/api/health', { headers: { 'X-Forwarded-Proto': 'https' } });
    check('health: HSTS preko HTTPS-a', /max-age=31536000/.test(tls.headers.get('strict-transport-security') || ''), tls.headers.get('strict-transport-security'));
  });

  await authSections();

  // ---- Funkcionalne provere kao korisnik A. Početni snimak (vraća se na kraju) i raspored ----
  current = A;
  await section('snapshot', async () => {
    snapshot = await expectOk('export na početku', get('/api/export'));
    // Nov nalog nema nijedan red podataka (ni kategorije ni šablone — ništa se ne upisuje unapred).
    fresh = isEmptyExport(snapshot);
    schedule = await expectOk('GET schedule', get('/api/schedule'));
    check('schedule: oblik', Array.isArray(schedule.categories) && Array.isArray(schedule.archivedCategories) && Array.isArray(schedule.templates) && schedule.settings && schedule.weekdays && Object.keys(schedule.weekdays).length === 7, schedule);
  });
  if (!snapshot || !schedule) throw new Error('Nema početnog stanja — prekidam.');
  if (!fresh) {
    snapshot = null; // ništa nije menjano, nema šta da se vraća
    throw new Error('Nalog A nije prazan — prekidam.');
  }

  // ---- Prazan start (samo nova baza): ništa nije unapred napravljeno, a API radi i bez rasporeda ----
  await section('empty start', async () => {
    if (!fresh) {
      skip('provere prazne baze', 'baza nije nova');
      return;
    }
    check('prazno: nema kategorija', schedule.categories.length === 0 && schedule.archivedCategories.length === 0, schedule.categories);
    check('prazno: nema šablona', schedule.templates.length === 0, schedule.templates);
    check('prazno: svi dani u nedelji bez šablona', same(schedule.weekdays, NO_TEMPLATES), schedule.weekdays);
    check('prazno: podešavanja (dan počinje u 00:00, prag 70%)', same(schedule.settings, EMPTY_SETTINGS), schedule.settings);
    const tables = ['categories', 'templates', 'template_blocks', 'days', 'blocks', 'tasks'];
    check('prazno: kopija bez redova', tables.every((k) => snapshot[k].length === 0), tables.map((k) => [k, snapshot[k].length]));
    check(
      'prazno: kopija ima 7 dana u nedelji bez šablona',
      same(snapshot.weekday_templates, [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, template_id: null }))),
      snapshot.weekday_templates,
    );
    check('prazno: kopija ima podešavanja', same(snapshot.settings, EMPTY_SETTINGS), snapshot.settings);

    // Dan za koji nema šablona: pregled je prazan, ensure/init prave prazan dan.
    let d = await expectOk('prazno: pregled dana', get(`/api/days/${E1}`));
    check(
      'prazno: pregled bez blokova i šablona',
      d.initialized === false && d.blocks.length === 0 && d.templateId === null && d.templateName === null && d.tasks.length === 0 && d.openBefore === 0 && d.note === '' && d.rating === null,
      d,
    );
    d = await expectOk('prazno: dan ?ensure=1', get(`/api/days/${E1}?ensure=1`));
    check('prazno: ensure pravi prazan dan', d.initialized === true && d.blocks.length === 0 && d.templateId === null && d.templateName === null, d);
    const again = await expectOk('prazno: ensure ponovo', get(`/api/days/${E1}?ensure=1`));
    check('prazno: ensure je idempotentan', same(again, d), again);
    d = await expectOk('prazno: init dana', post(`/api/days/${E2}/init`, {}));
    check('prazno: init bez šablona = prazan dan', d.initialized === true && d.blocks.length === 0 && d.templateId === null, d);
    await expectStatus('prazno: init ponovo → 409', post(`/api/days/${E2}/init`, {}), 409);
    d = await expectOk('prazno: init reset', post(`/api/days/${E2}/init`, { reset: true }));
    check('prazno: reset bez šablona = prazan dan', d.initialized === true && d.blocks.length === 0, d);
    await expectStatus('prazno: init sa nepostojećim šablonom → 400', post(`/api/days/${E2}/init`, { reset: true, templateId: 1 }), 400);

    // Blok, zadatak, beleška i ocena bez ijedne kategorije.
    await expectStatus('prazno: blok sa nepostojećom kategorijom → 400', post(`/api/days/${E3}/blocks`, { start: 600, end: 660, title: 'X', categoryId: 1 }), 400);
    d = await expectOk('prazno: blok bez kategorije', post(`/api/days/${E3}/blocks`, { start: 600, end: 660, title: 'Blok bez kategorije', categoryId: null }));
    check('prazno: dodavanje bloka pravi dan sa tim blokom', d.initialized === true && d.blocks.length === 1 && d.blocks[0].categoryId === null && d.templateId === null, d.blocks);
    await expectOk('prazno: blok urađen', patch(`/api/blocks/${d.blocks[0].id}`, { status: 'done' }));
    await expectStatus('prazno: zadatak sa nepostojećom kategorijom → 400', post('/api/tasks', { date: E3, title: 'X', categoryId: 1 }), 400);
    d = await expectOk('prazno: zadatak bez kategorije', post('/api/tasks', { date: E3, title: 'Zadatak bez kategorije' }));
    await expectOk('prazno: zadatak urađen', patch(`/api/tasks/${d.tasks[0].id}`, { done: true }));
    await expectOk('prazno: beleška i ocena', patch(`/api/days/${E3}`, { note: 'Prvi dan, još bez rasporeda.', rating: 4 }));

    // Statistika, dnevnik i završeni zadaci bez kategorija (blok bez kategorije se računa).
    const s = await expectOk('prazno: statistika', get(`/api/stats?from=${E1}&to=${E3}`));
    check('prazno: statistika po danima', same(s.days.map((x) => [x.date, x.initialized, x.summary === null]), [[E1, true, true], [E2, true, true], [E3, true, false]]), s.days);
    const se = s.days[2]?.summary;
    check(
      'prazno: blok bez kategorije se računa',
      near(se?.score, 1) && se?.counted === 1 && se?.plannedMin === 60 && se?.doneMin === 60 && same(se?.categories.map((c) => c.categoryId), [null]),
      se,
    );
    const tot = s.totals;
    check(
      'prazno: totals',
      tot.daysTracked === 1 && near(tot.avgScore, 1) && tot.avgRating === 4 && tot.tasksTotal === 1 && tot.tasksDone === 1 && same(tot.categories.map((c) => c.categoryId), [null]),
      tot,
    );
    check('prazno: niz', s.streak === 1, s.streak);
    const j = await expectOk('prazno: dnevnik', get('/api/journal'));
    check('prazno: dnevnik ima jedan unos', j.length === 1 && j[0].date === E3 && near(j[0].score, 1) && j[0].rating === 4 && j[0].tasksDone === 1 && j[0].tasksTotal === 1, j);
    const doneList = await expectOk('prazno: završeni zadaci', get(`/api/tasks/done?from=${E1}&to=${E3}`));
    check('prazno: završeni zadaci', doneList.length === 1 && doneList[0].title === 'Zadatak bez kategorije', doneList);

    // Dani u nedelji i podešavanja bez ijednog šablona.
    let sc = await expectOk('prazno: dan u nedelji bez šablona', put('/api/weekdays', { 1: null }));
    check('prazno: dani u nedelji ostaju bez šablona', same(sc.weekdays, NO_TEMPLATES), sc.weekdays);
    await expectStatus('prazno: dan u nedelji sa nepostojećim šablonom → 400', put('/api/weekdays', { 1: 1 }), 400);
    sc = await expectOk('prazno: dan počinje u 01:00', patch('/api/settings', { dayStart: 60 }));
    check('prazno: dayStart sačuvan bez šablona', sc.settings.dayStart === 60 && sc.templates.length === 0, sc.settings);
    sc = await expectOk('prazno: dan počinje u 00:00', patch('/api/settings', { dayStart: 0 }));
    check('prazno: dayStart vraćen', same(sc.settings, EMPTY_SETTINGS), sc.settings);

    // Izvoz i uvoz baze bez rasporeda.
    const exp = await expectOk('prazno: izvoz', get('/api/export'));
    check(
      'prazno: izvoz sa danima, bez rasporeda',
      exp.categories.length === 0 && exp.templates.length === 0 && exp.template_blocks.length === 0 && exp.days.length === 3 && exp.blocks.length === 1 && exp.tasks.length === 1,
      tables.map((k) => [k, exp[k]?.length]),
    );
    await expectOk('prazno: uvoz te kopije', post('/api/import', exp));
    const exp2 = await expectOk('prazno: izvoz posle uvoza', get('/api/export'));
    check('prazno: roundtrip bez kategorija i šablona', same(withoutStamp(exp2), withoutStamp(exp)));
    await expectOk('prazno: uvoz prazne kopije', post('/api/import', snapshot));
    const exp3 = await expectOk('prazno: izvoz posle prazne kopije', get('/api/export'));
    check('prazno: prazna kopija vraća praznu bazu', same(withoutStamp(exp3), withoutStamp(snapshot)), exp3);

    // Kopija bez redova za dane u nedelji (ručno napravljena): svi dani su bez šablona i mogu da se menjaju.
    await expectOk('prazno: uvoz kopije bez dana u nedelji', post('/api/import', { ...snapshot, weekday_templates: [], settings: { dayStart: 120, streakThreshold: 0.5 } }));
    sc = await expectOk('prazno: raspored posle te kopije', get('/api/schedule'));
    check(
      'prazno: bez redova = svi dani bez šablona, podešavanja iz kopije',
      same(sc.weekdays, NO_TEMPLATES) && same(sc.settings, { dayStart: 120, streakThreshold: 0.5 }) && sc.categories.length === 0 && sc.templates.length === 0,
      sc,
    );
    d = await expectOk('prazno: ensure bez redova za dane u nedelji', get(`/api/days/${E1}?ensure=1`));
    check('prazno: ensure bez redova = prazan dan', d.initialized === true && d.blocks.length === 0 && d.templateId === null, d);
    sc = await expectOk('prazno: izmena dana u nedelji bez reda', put('/api/weekdays', { 3: null }));
    check('prazno: izmena dana u nedelji bez reda', same(sc.weekdays, NO_TEMPLATES), sc.weekdays);
    await expectOk('prazno: vrati praznu bazu', post('/api/import', snapshot));
    const exp4 = await expectOk('prazno: izvoz na kraju', get('/api/export'));
    check('prazno: baza ponovo prazna', same(withoutStamp(exp4), withoutStamp(snapshot)), exp4);
  });

  // ---- Podaci testa: neutralne kategorije, šabloni i dani u nedelji, napravljeni kroz API ----
  // Ništa u ponašanju ne zavisi od naziva; na bazi koja nije nova nazivi dobijaju oznaku pokretanja.
  const fx = { catA: null, catB: null, catN: null, tpl1: null, tpl2: null };
  await section('fixtures', async () => {
    const tag = fresh ? '' : ` smoke-${Date.now().toString(36).slice(-5)}`;
    let s = await expectOk('podaci: dan počinje u 01:00', patch('/api/settings', { dayStart: FX_DAY_START }));
    check('podaci: dayStart 60', s.settings.dayStart === FX_DAY_START, s.settings);

    const addCat = async (name, color, counts) => {
      const r = await expectOk(`podaci: kategorija "${name}"`, post('/api/categories', { name: name + tag, color, counts }));
      return r.categories.find((c) => c.name === name + tag);
    };
    fx.catA = await addCat('Kat A', '#2f6db5', true);
    fx.catB = await addCat('Kat B', '#7b5ea7', true);
    fx.catN = await addCat('Kat neutral', '#9a9890', false);
    check('podaci: kategorije napravljene', fx.catA && fx.catB && fx.catN && new Set([fx.catA.id, fx.catB.id, fx.catN.id]).size === 3, fx);
    check('podaci: counts po izboru', fx.catA?.counts === true && fx.catB?.counts === true && fx.catN?.counts === false, fx);
    s = await expectOk('podaci: raspored posle kategorija', get('/api/schedule'));
    if (fresh) check('podaci: samo test kategorije, redom dodavanja', same(s.categories.map((c) => c.name), ['Kat A', 'Kat B', 'Kat neutral']), s.categories);

    const addTpl = async (name) => {
      const r = await expectOk(`podaci: šablon "${name}"`, post('/api/templates', { name: name + tag }));
      const t = r.templates.find((x) => x.name === name + tag);
      check(`podaci: "${name}" počinje bez blokova`, t && t.blocks.length === 0, t);
      return t;
    };
    fx.tpl1 = await addTpl('Šablon 1');
    fx.tpl2 = await addTpl('Šablon 2');
    const A = fx.catA.id;
    const B = fx.catB.id;
    const N = fx.catN.id;
    // Zidno vreme → minuti dana sa dayStart 01:00 (00:00–01:00 je kraj dana, posle ponoći).
    const blocks1 = [
      wall('00:00', '01:00', 'Posle ponoći', A),
      wall('23:00', '00:00', 'Kasni blok', A),
      wall('19:00', '20:00', 'Večernji blok', B),
      wall('16:00', '18:00', 'Blok B', B),
      wall('14:00', '15:00', 'Neutralno', N),
      wall('09:15', '14:00', 'Blok A', A),
      wall('01:00', '09:00', 'Noćni blok', A),
    ];
    const blocks2 = [
      wall('01:00', '09:00', 'Noćni blok', A),
      wall('10:00', '12:00', 'Blok B', B),
      wall('12:00', '13:00', 'Neutralno', N),
      wall('16:00', '17:30', 'Blok A', A),
    ];
    await expectOk('podaci: blokovi šablona 1', put(`/api/templates/${fx.tpl1.id}/blocks`, { blocks: blocks1 }));
    s = await expectOk('podaci: blokovi šablona 2', put(`/api/templates/${fx.tpl2.id}/blocks`, { blocks: blocks2 }));
    const t1 = s.templates.find((t) => t.id === fx.tpl1.id);
    const t2 = s.templates.find((t) => t.id === fx.tpl2.id);
    check(
      'podaci: šablon 1 (7 blokova, sortirano po vremenu)',
      same(t1?.blocks.map(shape), [
        [60, 540, 'Noćni blok', A],
        [555, 840, 'Blok A', A],
        [840, 900, 'Neutralno', N],
        [960, 1080, 'Blok B', B],
        [1140, 1200, 'Večernji blok', B],
        [1380, 1440, 'Kasni blok', A],
        [1440, 1500, 'Posle ponoći', A],
      ]),
      t1?.blocks.map(shape),
    );
    check('podaci: šablon 2 (4 bloka)', same(t2?.blocks.map(shape), sortShapes(blocks2.map(shape))), t2?.blocks.map(shape));
    check('podaci: blokovi znaju svoj šablon', t1?.blocks.every((b) => b.templateId === fx.tpl1.id) && t2?.blocks.every((b) => b.templateId === fx.tpl2.id));
    if (fresh) check('podaci: samo test šabloni', same(s.templates.map((t) => t.name), ['Šablon 1', 'Šablon 2']), s.templates.map((t) => t.name));

    // Pon, uto, čet → šablon 1; sre, pet, sub → šablon 2; nedelja bez šablona.
    const map = { 1: fx.tpl1.id, 2: fx.tpl1.id, 3: fx.tpl2.id, 4: fx.tpl1.id, 5: fx.tpl2.id, 6: fx.tpl2.id, 7: null };
    s = await expectOk('podaci: dani u nedelji', put('/api/weekdays', map));
    check('podaci: dani u nedelji sačuvani', same(s.weekdays, map), s.weekdays);
    schedule = await expectOk('podaci: raspored', get('/api/schedule'));
    check('podaci: raspored ima šablone i podešavanja', schedule.templates.some((t) => t.id === fx.tpl1.id) && schedule.settings.dayStart === FX_DAY_START);
  });
  if (!fx.catA || !fx.catB || !fx.catN || !fx.tpl1 || !fx.tpl2) throw new Error('Podaci testa nisu napravljeni — prekidam.');

  const tplById = (id) => schedule.templates.find((t) => t.id === id);
  const weekdayTpl = (date) => tplById(schedule.weekdays[isoWeekday(date)] ?? -1) ?? null;

  // ---- Dan: danas sa ensure, pregled budućeg dana ----
  await section('days', async () => {
    const today = logicalToday(schedule.settings.dayStart);
    const tpl = weekdayTpl(today);
    const d = await expectOk('GET danas ?ensure=1', get(`/api/days/${today}?ensure=1`));
    check('danas: initialized', d.initialized === true && d.date === today, d);
    check('danas: šablon dana u nedelji', d.templateId === (tpl?.id ?? null) && d.templateName === (tpl?.name ?? null), [d.templateId, d.templateName]);
    if (!d.blocks.some((b) => b.status !== 'pending' || b.note)) {
      // Dan nije menjan → blokovi su tačno blokovi šablona.
      check('danas: blokovi iz šablona', same(d.blocks.map(shape), (tpl?.blocks ?? []).map(shape)), d.blocks.map(shape));
    }
    check('danas: pozitivni id-jevi', d.blocks.every((b) => b.id > 0));
    check('danas: sortirano po start', d.blocks.every((b, i, a) => i === 0 || a[i - 1].start <= b.start));
    const d2 = await expectOk('GET danas ponovo', get(`/api/days/${today}?ensure=1`));
    check('danas: ensure je idempotentan', same(d2.blocks.map((b) => b.id), d.blocks.map((b) => b.id)));

    const ftpl = weekdayTpl(FUT);
    const p = await expectOk('GET budući dan bez ensure', get(`/api/days/${FUT}`));
    check('pregled: initialized false', p.initialized === false, p.initialized);
    check('pregled: negativni id-jevi -1..-n', same(p.blocks.map((b) => b.id), p.blocks.map((_, i) => -(i + 1))), p.blocks.map((b) => b.id));
    check('pregled: svi pending', p.blocks.every((b) => b.status === 'pending' && b.actualMin === null));
    check('pregled: blokovi šablona', same(p.blocks.map(shape), (ftpl?.blocks ?? []).map(shape)));
    check('pregled: templateName', p.templateId === (ftpl?.id ?? null) && p.templateName === (ftpl?.name ?? null));
    check('pregled: ponedeljak → šablon 1 (7 blokova)', p.templateId === fx.tpl1.id && p.blocks.length === 7, [p.templateId, p.blocks.length]);
    // Nedelja nema šablon: pregled je prazan dan.
    const sunday = addDays(FUT, 6);
    const ps = await expectOk('GET budući dan bez šablona', get(`/api/days/${sunday}`));
    check('pregled dana bez šablona: prazan', isoWeekday(sunday) === 7 && ps.initialized === false && ps.blocks.length === 0 && ps.templateId === null && ps.templateName === null, ps);
    const p2 = await expectOk('GET budući dan ponovo', get(`/api/days/${FUT}`));
    check('pregled: ništa nije upisano', p2.initialized === false);

    await expectStatus('neispravan datum 2026-02-30 → 400', get('/api/days/2026-02-30'), 400);
    await expectStatus('neispravan datum "abc" → 400', get('/api/days/abc'), 400);
  });

  // ---- POST init: reset, templateId ----
  await section('init', async () => {
    const tpl = weekdayTpl(D1);
    const a = await expectOk('init dan', post(`/api/days/${D1}/init`, {}));
    check('init: blokovi iz šablona', a.initialized && same(a.blocks.map(shape), (tpl?.blocks ?? []).map(shape)));
    await expectStatus('init ponovo bez reset → 409', post(`/api/days/${D1}/init`, {}), 409);
    if (a.blocks[0]) await expectOk('init: status bloka', patch(`/api/blocks/${a.blocks[0].id}`, { status: 'done' }));
    const b = await expectOk('init reset', post(`/api/days/${D1}/init`, { reset: true }));
    check('reset: svi blokovi ponovo pending', b.initialized && b.blocks.length === a.blocks.length && b.blocks.every((x) => x.status === 'pending'));
    const empty = await expectOk('init reset templateId null', post(`/api/days/${D1}/init`, { reset: true, templateId: null }));
    check('prazan dan', empty.blocks.length === 0 && empty.templateId === null && empty.templateName === null, empty);
    // D1 je ponedeljak → šablon 1 (7 blokova) iz podataka testa.
    check('init: šablon dana u nedelji sa blokovima', tpl?.id === fx.tpl1.id && a.templateId === fx.tpl1.id && a.blocks.length === 7, [tpl?.id, a.templateId, a.blocks.length]);
    const other = schedule.templates.find((t) => t.blocks.length > 0 && t.id !== tpl?.id);
    check('init: postoji drugi šablon sa blokovima', !!other);
    if (other) {
      const c = await expectOk('init drugi šablon', post(`/api/days/${D1}/init`, { reset: true, templateId: other.id }));
      check('drugi šablon: blokovi i naziv', c.templateId === other.id && c.templateName === other.name && same(c.blocks.map(shape), other.blocks.map(shape)));
    }
    await expectStatus('init nepostojeći šablon → 400', post(`/api/days/${D1}/init`, { reset: true, templateId: 999999 }), 400);
    await expectStatus('init loš tip reset → 400', post(`/api/days/${D1}/init`, { reset: 'da' }), 400);
  });

  // ---- PATCH dan: beleška i ocena ----
  await section('day patch', async () => {
    const a = await expectOk('beleška + ocena', patch(`/api/days/${D2}`, { note: 'Popio sam čaj i radio ceo dan.', rating: 4 }));
    check('beleška sačuvana', a.note === 'Popio sam čaj i radio ceo dan.' && a.rating === 4, a);
    check('beleška ne inicijalizuje dan', a.initialized === false && a.blocks.every((b) => b.id < 0));
    const b = await expectOk('ocena null', patch(`/api/days/${D2}`, { rating: null }));
    check('ocena obrisana, beleška ostaje', b.rating === null && b.note.startsWith('Popio'));
    // baseNote: zastareo draft sa drugog uređaja ne sme da prepiše novu belešku.
    const note1 = 'Popio sam čaj i radio ceo dan.';
    const note2 = `${note1} Uveče šetnja.`;
    const stale = await expectStatus('zastareo baseNote → 409', patch(`/api/days/${D2}`, { note: 'telefon: stari draft', baseNote: 'stari tekst', rating: 1 }), 409);
    check('409: poruka o promeni na drugom uređaju', stale.json?.error === 'Beleška je u međuvremenu promenjena na drugom uređaju.', stale.text);
    const kept = await expectOk('dan posle 409', get(`/api/days/${D2}`));
    check('409: beleška i ocena nepromenjene', kept.note === note1 && kept.rating === null, kept);
    let c = await expectOk('baseNote = sačuvana beleška → 200', patch(`/api/days/${D2}`, { note: note2, baseNote: note1 }));
    check('baseNote: nova beleška sačuvana', c.note === note2, c);
    c = await expectOk('ponovljeno slanje (isti tekst, stari baseNote) → 200', patch(`/api/days/${D2}`, { note: note2, baseNote: note1 }));
    check('ponovljeno slanje: beleška ista', c.note === note2, c);
    c = await expectOk('baseNote ignorisan bez beleške', patch(`/api/days/${D2}`, { rating: 5, baseNote: 'stari tekst' }));
    check('ocena sa baseNote bez beleške', c.rating === 5 && c.note === note2, c);
    c = await expectOk('bez baseNote: bezuslovan upis', patch(`/api/days/${D2}`, { note: note1 }));
    check('bezuslovan upis sačuvan', c.note === note1, c);
    await expectStatus('baseNote loš tip → 400', patch(`/api/days/${D2}`, { note: note1, baseNote: 5 }), 400);
    // baseNote se samo poredi: duža beleška (npr. iz uvezene kopije) ne sme da blokira čuvanje.
    await expectStatus('baseNote > 20000 znakova → 409, ne 400', patch(`/api/days/${D2}`, { note: 'kraće', baseNote: 'y'.repeat(25000) }), 409);
    // Dan bez reda u `days`: sačuvana beleška je ''.
    await expectStatus('dan bez reda: zastareo baseNote → 409', patch(`/api/days/${D14}`, { note: 'prvi unos', baseNote: 'stari tekst' }), 409);
    c = await expectOk('dan bez reda: baseNote "" → 200', patch(`/api/days/${D14}`, { note: 'prvi unos', baseNote: '' }));
    check('dan bez reda: beleška sačuvana', c.note === 'prvi unos', c);
    c = await expectOk('dan bez reda: brisanje beleške', patch(`/api/days/${D14}`, { note: '', baseNote: 'prvi unos' }));
    check('dan bez reda: beleška obrisana', c.note === '', c);
    await expectOk('ocena ponovo', patch(`/api/days/${D2}`, { rating: 3 }));
    await expectStatus('ocena 6 → 400', patch(`/api/days/${D2}`, { rating: 6 }), 400);
    await expectStatus('ocena 2.5 → 400', patch(`/api/days/${D2}`, { rating: 2.5 }), 400);
    await expectStatus('beleška > 20000 → 400', patch(`/api/days/${D2}`, { note: 'x'.repeat(20001) }), 400);
    await expectStatus('mutacija bez X-Ritam → 403', patch(`/api/days/${D2}`, { rating: 2 }, { csrf: false }), 403);
    await expectStatus('neispravan JSON → 400', req('PATCH', `/api/days/${D2}`, { rawBody: '{"note": ' }), 400);
    const big = await req('PATCH', `/api/days/${D2}`, { rawBody: JSON.stringify({ note: 'x'.repeat(1_100_000) }) });
    check('telo > 1 MB → 413', big.status === 413, `status ${big.status}`);
  });

  // ---- Blokovi ----
  let catCount = null; // kategorija koja se računa
  let catFree = null; // kategorija koja se ne računa
  let catDel = null; // kategorija za brisanje
  await section('categories setup', async () => {
    let s = await expectOk('nova kategorija', post('/api/categories', { name: 'Smoke računa', color: '#AABBCC', counts: true }));
    catCount = s.categories.find((c) => c.name === 'Smoke računa');
    check('kategorija: boja malim slovima, na kraju', catCount?.color === '#aabbcc' && s.categories.at(-1)?.id === catCount?.id, catCount);
    s = await expectOk('kategorija koja se ne računa', post('/api/categories', { name: 'Smoke ne računa', color: '#112233', counts: false }));
    catFree = s.categories.find((c) => c.name === 'Smoke ne računa');
    check('kategorija counts false', catFree?.counts === false);
    s = await expectOk('kategorija za brisanje', post('/api/categories', { name: 'Smoke briši', color: '#445566', counts: true }));
    catDel = s.categories.find((c) => c.name === 'Smoke briši');
    await expectStatus('kategorija loša boja → 400', post('/api/categories', { name: 'X', color: 'crvena', counts: true }), 400);
    await expectStatus('kategorija bez naziva → 400', post('/api/categories', { name: '  ', color: '#000000', counts: true }), 400);
    await expectStatus('kategorija naziv > 40 → 400', post('/api/categories', { name: 'x'.repeat(41), color: '#000000', counts: true }), 400);
    s = await expectOk('izmena kategorije', patch(`/api/categories/${catFree.id}`, { name: 'Smoke slobodno', counts: false }));
    check('izmena kategorije sačuvana', s.categories.find((c) => c.id === catFree.id)?.name === 'Smoke slobodno');
    // Isti naziv (bez obzira na velika slova i razmake) → 409; klijent uvek šalje i nepromenjen naziv.
    const dup = await expectStatus('kategorija postojeći naziv → 409', post('/api/categories', { name: '  smoke RAČUNA ', color: '#000000', counts: true }), 409);
    check('409: poruka o nazivu kategorije', dup.json?.error === 'Kategorija sa tim nazivom već postoji.', dup.text);
    await expectStatus('preimenovanje u postojeći naziv → 409', patch(`/api/categories/${catFree.id}`, { name: 'Smoke Računa' }), 409);
    await expectOk('izmena boje sa nepromenjenim nazivom', patch(`/api/categories/${catCount.id}`, { name: 'Smoke računa', color: '#aabbcc', counts: true }));
    s = await expectOk('promena samo velikih slova', patch(`/api/categories/${catFree.id}`, { name: 'smoke slobodno' }));
    check('promena velikih slova sačuvana', s.categories.find((c) => c.id === catFree.id)?.name === 'smoke slobodno');
    await expectOk('vrati naziv', patch(`/api/categories/${catFree.id}`, { name: 'Smoke slobodno' }));
    await expectStatus('izmena nepostojeće kategorije → 404', patch('/api/categories/99999999', { name: 'X' }), 404);
    await expectStatus('kategorija id "x" → 400', patch('/api/categories/x', { name: 'X' }), 400);
  });

  await section('blocks', async () => {
    const tpl = weekdayTpl(D3);
    const a = await expectOk('dodaj blok na neinicijalizovan dan', post(`/api/days/${D3}/blocks`, { start: 600, end: 660, title: '  Smoke blok  ', categoryId: catDel.id }));
    const added = a.blocks.find((b) => b.title === 'Smoke blok');
    check('dodavanje inicijalizuje dan iz šablona', a.initialized && a.templateId === fx.tpl2.id && tpl?.blocks.length === 4 && a.blocks.length === 5, [a.templateId, a.blocks.length]);
    check('blok: naslov trimovan, pending', added && added.status === 'pending' && added.start === 600 && added.end === 660 && added.categoryId === catDel.id, added);
    check('blokovi sortirani', a.blocks.every((b, i, arr) => i === 0 || arr[i - 1].start < b.start || (arr[i - 1].start === b.start && (arr[i - 1].end < b.end || (arr[i - 1].end === b.end && arr[i - 1].id < b.id)))));
    await expectStatus('blok kraj pre početka → 400', post(`/api/days/${D3}/blocks`, { start: 700, end: 600, title: 'X', categoryId: null }), 400);
    await expectStatus('blok duži od 24h → 400', post(`/api/days/${D3}/blocks`, { start: 0, end: 1441, title: 'X', categoryId: null }), 400);
    await expectStatus('blok bez naslova → 400', post(`/api/days/${D3}/blocks`, { start: 600, end: 660, title: '', categoryId: null }), 400);
    await expectStatus('blok nepostojeća kategorija → 400', post(`/api/days/${D3}/blocks`, { start: 600, end: 660, title: 'X', categoryId: 999999 }), 400);
    await expectStatus('blok neceo minut → 400', post(`/api/days/${D3}/blocks`, { start: 600.5, end: 660, title: 'X', categoryId: null }), 400);

    let r = await expectOk('status done', patch(`/api/blocks/${added.id}`, { status: 'done' }));
    check('done sačuvan', r.blocks.find((b) => b.id === added.id)?.status === 'done');
    r = await expectOk('partial + actualMin', patch(`/api/blocks/${added.id}`, { status: 'partial', actualMin: 20 }));
    let blk = r.blocks.find((b) => b.id === added.id);
    check('partial 20 min', blk?.status === 'partial' && blk?.actualMin === 20, blk);
    r = await expectOk('skipped briše actualMin', patch(`/api/blocks/${added.id}`, { status: 'skipped' }));
    blk = r.blocks.find((b) => b.id === added.id);
    check('skipped → actualMin null', blk?.status === 'skipped' && blk?.actualMin === null, blk);
    r = await expectOk('naslov, beleška, vreme', patch(`/api/blocks/${added.id}`, { title: 'Smoke blok 2', note: 'beleška bloka', start: 610, end: 670 }));
    blk = r.blocks.find((b) => b.id === added.id);
    check('izmene bloka sačuvane', blk?.title === 'Smoke blok 2' && blk?.note === 'beleška bloka' && blk?.start === 610 && blk?.end === 670, blk);
    await expectStatus('početak posle postojećeg kraja → 400', patch(`/api/blocks/${added.id}`, { start: 700 }), 400);
    await expectStatus('neispravan status → 400', patch(`/api/blocks/${added.id}`, { status: 'gotovo' }), 400);
    await expectStatus('nepostojeći blok → 404', patch('/api/blocks/99999999', { status: 'done' }), 404);
    await expectStatus('negativan id (pregled) → 400', patch('/api/blocks/-1', { status: 'done' }), 400);

    // Podela: 610–670, done sa 50 min → prvi deo 30 min gubi actualMin.
    await expectOk('done 50 min', patch(`/api/blocks/${added.id}`, { status: 'done', actualMin: 50 }));
    r = await expectOk('podeli blok', post(`/api/blocks/${added.id}/split`, { at: 640 }));
    const first = r.blocks.find((b) => b.id === added.id);
    const second = r.blocks.find((b) => b.start === 640 && b.title === 'Smoke blok 2');
    check('split: prvi deo zadržava id i status', first?.start === 610 && first?.end === 640 && first?.status === 'done' && first?.note === 'beleška bloka', first);
    check('split: actualMin veći od trajanja → null', first?.actualMin === null, first);
    check('split: drugi deo pending, ista kategorija, prazna beleška', second && second.end === 670 && second.status === 'pending' && second.categoryId === catDel.id && second.note === '' && second.id !== added.id, second);
    await expectStatus('split kraći od 5 min → 400', post(`/api/blocks/${second.id}/split`, { at: 643 }), 400);
    await expectStatus('split van bloka → 400', post(`/api/blocks/${second.id}/split`, { at: 700 }), 400);
    await expectStatus('split nepostojeći blok → 404', post('/api/blocks/99999999/split', { at: 700 }), 404);

    r = await expectOk('obriši blok', del(`/api/blocks/${second.id}`));
    check('blok obrisan', !r.blocks.some((b) => b.id === second.id) && r.date === D3);
    await expectStatus('obriši ponovo → 404', del(`/api/blocks/${second.id}`), 404);

    // Blok od skoro 24h posle ponoći (00:30–00:15 = 1470–2895): drugi deo bi počeo u 2890 (≥ 2880).
    r = await expectOk('dug blok posle ponoći', post(`/api/days/${D3}/blocks`, { start: 1470, end: 2895, title: 'Smoke dug', categoryId: null }));
    const long = r.blocks.find((b) => b.title === 'Smoke dug');
    const bad = await expectStatus('split na 2890 → 400', post(`/api/blocks/${long.id}/split`, { at: 2890 }), 400);
    check('split na 2890: poruka', bad.json?.error === 'Neispravno mesto deljenja.', bad.json);
    r = await expectOk('dug blok: status', patch(`/api/blocks/${long.id}`, { status: 'done' }));
    check('dug blok: ostao ceo', r.blocks.filter((b) => b.title === 'Smoke dug').length === 1);
    await expectOk('obriši dug blok', del(`/api/blocks/${long.id}`));

    // Id obrisanog bloka se ne dodeljuje ponovo (zastareo zahtev sa drugog uređaja → 404).
    r = await expectOk('novi blok posle brisanja', post(`/api/days/${D3}/blocks`, { start: 900, end: 930, title: 'Smoke novi', categoryId: null }));
    const fresh2 = r.blocks.find((b) => b.title === 'Smoke novi');
    check('novi blok ne dobija id obrisanog', fresh2 && fresh2.id > long.id, [fresh2?.id, long.id]);
    await expectStatus('izmena obrisanog bloka → 404', patch(`/api/blocks/${long.id}`, { status: 'done' }), 404);
    await expectOk('obriši novi blok', del(`/api/blocks/${fresh2.id}`));
  });

  // ---- Zamena blokova: menjaju se samo naslov i kategorija, termini ostaju ----
  await section('swap', async () => {
    await expectOk('D12 prazan dan', post(`/api/days/${D12}/init`, { reset: true, templateId: null }));
    await expectOk('D12 jutarnji blok', post(`/api/days/${D12}/blocks`, { start: 555, end: 840, title: 'Smoke jutro', categoryId: catCount.id }));
    await expectOk('D12 popodnevni blok', post(`/api/days/${D12}/blocks`, { start: 960, end: 1080, title: 'Smoke popodne', categoryId: null }));
    let d = await expectOk('D12 večernji blok', post(`/api/days/${D12}/blocks`, { start: 1140, end: 1200, title: 'Smoke veče', categoryId: catFree.id }));
    const by = (t) => d.blocks.find((b) => b.title === t);
    const work = by('Smoke jutro');
    const learn = by('Smoke popodne');
    const gym = by('Smoke veče');
    await expectOk('D12 jutro: done + stvarno vreme + beleška', patch(`/api/blocks/${work.id}`, { status: 'done', actualMin: 250, note: 'jutarnji termin' }));
    d = await expectOk('D12 popodne: skipped', patch(`/api/blocks/${learn.id}`, { status: 'skipped' }));
    const before = d.blocks;

    const r = await expectOk('zameni jutarnji i popodnevni blok', post(`/api/blocks/${work.id}/swap`, { with: learn.id }));
    check('swap: vraća DayPayload dana', r.date === D12 && r.initialized === true && r.blocks.length === 3, [r.date, r.blocks.length]);
    const a = r.blocks.find((b) => b.id === work.id);
    const b = r.blocks.find((x) => x.id === learn.id);
    check('swap: jutarnji termin dobija naslov i kategoriju popodnevnog bloka', a?.title === 'Smoke popodne' && a?.categoryId === null, a);
    check('swap: popodnevni termin dobija naslov i kategoriju jutarnjeg bloka', b?.title === 'Smoke jutro' && b?.categoryId === catCount.id, b);
    check('swap: vreme, status, stvarno vreme i beleška ostaju u terminu', a?.start === 555 && a?.end === 840 && a?.status === 'done' && a?.actualMin === 250 && a?.note === 'jutarnji termin' && b?.start === 960 && b?.end === 1080 && b?.status === 'skipped' && b?.actualMin === null && b?.note === '', [a, b]);
    check('swap: ostali blokovi nepromenjeni', same(r.blocks.find((x) => x.id === gym.id), before.find((x) => x.id === gym.id)));
    check('swap: redosled po vremenu', same(r.blocks.map((x) => x.id), before.map((x) => x.id)));
    const back = await expectOk('zameni nazad (obrnut redosled)', post(`/api/blocks/${learn.id}/swap`, { with: work.id }));
    check('swap dva puta = početno stanje', same(back.blocks, before), back.blocks);

    // Greške: ništa se ne menja.
    await expectOk('D13 prazan dan', post(`/api/days/${D13}/init`, { reset: true, templateId: null }));
    const other = (await expectOk('D13 blok', post(`/api/days/${D13}/blocks`, { start: 600, end: 660, title: 'Smoke drugi dan', categoryId: null }))).blocks[0];
    const diff = await expectStatus('swap blokova različitih dana → 400', post(`/api/blocks/${work.id}/swap`, { with: other.id }), 400);
    check('swap različitih dana: poruka', diff.json?.error === 'Možeš da zameniš samo blokove istog dana.', diff.json);
    const selfSwap = await expectStatus('swap sa samim sobom → 400', post(`/api/blocks/${work.id}/swap`, { with: work.id }), 400);
    check('swap sa samim sobom: poruka', selfSwap.json?.error === 'Blok ne može da se zameni sam sa sobom.', selfSwap.json);
    await expectStatus('swap nepostojeći "with" → 404', post(`/api/blocks/${work.id}/swap`, { with: 99999999 }), 404);
    await expectStatus('swap nepostojeći blok → 404', post(`/api/blocks/99999999/swap`, { with: work.id }), 404);
    await expectStatus('swap bez "with" → 400', post(`/api/blocks/${work.id}/swap`, {}), 400);
    await expectStatus('swap "with" string → 400', post(`/api/blocks/${work.id}/swap`, { with: String(learn.id) }), 400);
    await expectStatus('swap "with" negativan (pregled) → 400', post(`/api/blocks/${work.id}/swap`, { with: -1 }), 400);
    await expectStatus('swap "with" neceo → 400', post(`/api/blocks/${work.id}/swap`, { with: 1.5 }), 400);
    await expectStatus('swap id "x" → 400', post('/api/blocks/x/swap', { with: learn.id }), 400);
    await expectStatus('swap bez X-Ritam → 403', post(`/api/blocks/${work.id}/swap`, { with: learn.id }, { csrf: false }), 403);
    const after = await expectOk('GET D12 posle grešaka', get(`/api/days/${D12}`));
    check('neuspela zamena ne menja ništa', same(after.blocks, before), after.blocks);
    const d13 = await expectOk('GET D13 posle grešaka', get(`/api/days/${D13}`));
    check('neuspela zamena ne menja drugi dan', same(d13.blocks, [other]), d13.blocks);
  });

  // ---- Zadaci ----
  await section('tasks', async () => {
    let d = await expectOk('dodaj zadatak', post('/api/tasks', { date: D4, title: '  Kupi čaj  ', categoryId: catDel.id }));
    const t1 = d.tasks.find((t) => t.title === 'Kupi čaj');
    check('zadatak: trimovan, nije urađen', t1 && t1.done === false && t1.doneAt === null && t1.categoryId === catDel.id && t1.date === D4, t1);
    check('zadatak ne inicijalizuje dan', d.initialized === false);
    d = await expectOk('drugi zadatak', post('/api/tasks', { date: D4, title: 'Drugi zadatak' }));
    d = await expectOk('treći zadatak', post('/api/tasks', { date: D4, title: 'Treći zadatak' }));
    const [a, b, c] = d.tasks;
    check('zadaci po redosledu dodavanja', same(d.tasks.map((t) => t.title), ['Kupi čaj', 'Drugi zadatak', 'Treći zadatak']) && a.sort < b.sort && b.sort < c.sort);
    await expectStatus('zadatak bez naziva → 400', post('/api/tasks', { date: D4, title: '   ' }), 400);
    await expectStatus('zadatak naziv > 300 → 400', post('/api/tasks', { date: D4, title: 'x'.repeat(301) }), 400);
    await expectStatus('zadatak loš datum → 400', post('/api/tasks', { date: '2095-13-01', title: 'X' }), 400);

    d = await expectOk('označi urađen', patch(`/api/tasks/${a.id}`, { done: true }));
    const doneA = d.tasks.find((t) => t.id === a.id);
    check('urađen: doneAt postavljen', doneA?.done === true && typeof doneA?.doneAt === 'string');
    check('urađeni na kraju liste', d.tasks.at(-1)?.id === a.id, d.tasks.map((t) => t.title));
    d = await expectOk('vrati na neurađen', patch(`/api/tasks/${a.id}`, { done: false }));
    check('neurađen: doneAt null', d.tasks.find((t) => t.id === a.id)?.doneAt === null);
    d = await expectOk('preimenuj zadatak', patch(`/api/tasks/${a.id}`, { title: 'Kupi zeleni čaj', done: true }));
    check('preimenovan i urađen', d.tasks.find((t) => t.id === a.id)?.title === 'Kupi zeleni čaj');

    await expectOk('zadatak na ciljnom danu', post('/api/tasks', { date: D5, title: 'Postojeći na D5' }));
    d = await expectOk('premesti zadatak', patch(`/api/tasks/${b.id}`, { date: D5 }));
    check('premeštanje vraća STARI dan', d.date === D4 && !d.tasks.some((t) => t.id === b.id), d.date);
    const d5 = await expectOk('GET ciljni dan', get(`/api/days/${D5}`));
    check('premešten na kraj ciljnog dana', d5.tasks.at(-1)?.id === b.id && d5.tasks.length === 2, d5.tasks.map((t) => t.title));

    d = await expectOk('obriši zadatak', del(`/api/tasks/${c.id}`));
    check('zadatak obrisan', d.date === D4 && !d.tasks.some((t) => t.id === c.id));
    await expectStatus('obriši ponovo → 404', del(`/api/tasks/${c.id}`), 404);
    await expectStatus('izmena nepostojećeg zadatka → 404', patch('/api/tasks/99999999', { done: true }), 404);
    await expectStatus('zadatak done "da" → 400', patch(`/api/tasks/${a.id}`, { done: 'da' }), 400);

    // Prebacivanje nezavršenih.
    await expectOk('zadatak na D8', post('/api/tasks', { date: D8, title: 'Već na D8' }));
    await expectOk('D6 zadatak 1', post('/api/tasks', { date: D6, title: 'D6 prvi' }));
    await expectOk('D6 zadatak 2', post('/api/tasks', { date: D6, title: 'D6 drugi' }));
    await expectOk('D7 zadatak', post('/api/tasks', { date: D7, title: 'D7 jedini' }));
    const before = await expectOk('GET D8', get(`/api/days/${D8}`));
    check('openBefore broji nezavršene ranije', before.openBefore >= 4, before.openBefore);
    d = await expectOk('carry', post('/api/tasks/carry', { to: D8 }));
    const titles = d.tasks.map((t) => t.title);
    const idx = (t) => titles.indexOf(t);
    check('carry: postojeći ostaje prvi', titles[0] === 'Već na D8', titles);
    check('carry: redosled po datumu i sort-u', idx('D6 prvi') > 0 && idx('D6 prvi') < idx('D6 drugi') && idx('D6 drugi') < idx('D7 jedini'), titles);
    check('carry: premešten i D5 zadatak', idx('Drugi zadatak') > 0 && idx('Drugi zadatak') < idx('D6 prvi'), titles);
    check('carry: openBefore 0', d.openBefore === 0, d.openBefore);
    check('carry: urađeni ostaju', !titles.includes('Kupi zeleni čaj'));
    const d6 = await expectOk('GET D6 posle carry', get(`/api/days/${D6}`));
    check('carry: izvorni dan prazan', d6.tasks.length === 0);
    await expectStatus('carry loš datum → 400', post('/api/tasks/carry', { to: 'sutra' }), 400);

    const list = await expectOk('završeni zadaci', get(`/api/tasks/done?from=${D4}&to=${D8}`));
    check('završeni: samo urađeni u opsegu', Array.isArray(list) && list.length === 1 && list[0].id === a.id && list[0].done === true, list);
    await expectStatus('završeni bez from → 400', get(`/api/tasks/done?to=${D8}`), 400);
    await expectStatus('završeni from > to → 400', get(`/api/tasks/done?from=${D8}&to=${D4}`), 400);

    // Id obrisanog zadatka se ne dodeljuje ponovo.
    d = await expectOk('zadatak za brisanje', post('/api/tasks', { date: D4, title: 'Smoke privremeni' }));
    const tmp = d.tasks.find((t) => t.title === 'Smoke privremeni');
    await expectOk('obriši privremeni', del(`/api/tasks/${tmp.id}`));
    d = await expectOk('novi zadatak posle brisanja', post('/api/tasks', { date: D4, title: 'Smoke sledeći' }));
    const next = d.tasks.find((t) => t.title === 'Smoke sledeći');
    check('novi zadatak ne dobija id obrisanog', next && next.id > tmp.id, [next?.id, tmp.id]);
    await expectStatus('čekiranje obrisanog zadatka → 404', patch(`/api/tasks/${tmp.id}`, { done: true }), 404);
    d = await expectOk('GET D4 posle zastarelog zahteva', get(`/api/days/${D4}`));
    check('novi zadatak nije čekiran', d.tasks.find((t) => t.id === next.id)?.done === false);
    await expectOk('obriši sledeći', del(`/api/tasks/${next.id}`));
  });

  // ---- Statistika ----
  await section('stats', async () => {
    // D9: CA done 60 + CA partial 60 (pola) + CF done (ne računa se) → 0.75; D10: CA done → 1.
    await expectOk('D9 prazan dan', post(`/api/days/${D9}/init`, { reset: true, templateId: null }));
    await expectOk('D9 blok 1', post(`/api/days/${D9}/blocks`, { start: 600, end: 660, title: 'A1', categoryId: catCount.id }));
    await expectOk('D9 blok 2', post(`/api/days/${D9}/blocks`, { start: 700, end: 760, title: 'A2', categoryId: catCount.id }));
    let d = await expectOk('D9 blok 3', post(`/api/days/${D9}/blocks`, { start: 800, end: 860, title: 'F1', categoryId: catFree.id }));
    const byTitle = (t) => d.blocks.find((b) => b.title === t);
    await expectOk('D9 A1 done', patch(`/api/blocks/${byTitle('A1').id}`, { status: 'done' }));
    await expectOk('D9 A2 partial', patch(`/api/blocks/${byTitle('A2').id}`, { status: 'partial' }));
    await expectOk('D9 F1 done', patch(`/api/blocks/${byTitle('F1').id}`, { status: 'done' }));
    await expectOk('D9 ocena', patch(`/api/days/${D9}`, { rating: 4, note: 'Jutros sam pio ČAJ od nane.' }));
    await expectOk('D9 zadatak 1', post('/api/tasks', { date: D9, title: 'S1' }));
    d = await expectOk('D9 zadatak 2', post('/api/tasks', { date: D9, title: 'S2' }));
    await expectOk('D9 zadatak urađen', patch(`/api/tasks/${d.tasks[0].id}`, { done: true }));
    await expectOk('D10 prazan dan', post(`/api/days/${D10}/init`, { reset: true, templateId: null }));
    d = await expectOk('D10 blok', post(`/api/days/${D10}/blocks`, { start: 600, end: 690, title: 'A3', categoryId: catCount.id }));
    await expectOk('D10 done', patch(`/api/blocks/${d.blocks[0].id}`, { status: 'done' }));
    await expectOk('D10 beleška', patch(`/api/days/${D10}`, { note: 'Dan bez ičega posebnog.' }));

    const thr = schedule.settings.streakThreshold;
    const s = await expectOk('stats D9..D11', get(`/api/stats?from=${D9}&to=${D11}`));
    check('stats: svi datumi u opsegu', same(s.days.map((x) => x.date), [D9, D10, D11]), s.days.map((x) => x.date));
    const s9 = s.days[0].summary;
    check('stats: score D9 = 0.75', near(s9?.score, 0.75), s9);
    check('stats: counted 2, done 1, partial 1', s9?.counted === 2 && s9?.done === 1 && s9?.partial === 1, s9);
    check('stats: minuti (samo računate)', s9?.plannedMin === 120 && s9?.doneMin === 90, s9);
    const ct = s9?.categories.find((x) => x.categoryId === catCount.id);
    check('stats: kategorija D9', ct?.plannedMin === 120 && ct?.doneMin === 90 && ct?.plannedCount === 2 && ct?.doneCount === 1.5, ct);
    check('stats: score D10 = 1', near(s.days[1].summary?.score, 1));
    check('stats: neinicijalizovan dan', s.days[2].initialized === false && s.days[2].summary === null);
    check('stats: zadaci D9', s.days[0].tasksTotal === 2 && s.days[0].tasksDone === 1, s.days[0]);
    check('stats: rating i beleška', s.days[0].rating === 4 && s.days[0].hasNote === true);
    const tot = s.totals;
    check('stats: totals', tot.daysTracked === 2 && near(tot.avgScore, 0.875) && tot.avgRating === 4 && tot.tasksTotal === 2 && tot.tasksDone === 1, tot);
    const tc = tot.categories.find((x) => x.categoryId === catCount.id);
    check('stats: zbir po kategoriji', tc?.plannedMin === 210 && tc?.doneMin === 180 && tc?.plannedCount === 3, tc);
    const tf = tot.categories.find((x) => x.categoryId === catFree.id);
    check('stats: kategorija koja se ne računa je u zbiru', tf?.plannedMin === 60 && tf?.doneMin === 60, tf);
    const expectedStreak = 0.75 >= thr ? 2 : 1;
    check('stats: niz (danas ne prekida)', s.streak === expectedStreak, `${s.streak} ≠ ${expectedStreak}`);
    const s2 = await expectOk('stats samo D10', get(`/api/stats?from=${D10}&to=${D10}`));
    check('stats: niz gleda celu istoriju', s2.streak === expectedStreak, s2.streak);
    await expectStatus('stats > 400 dana → 400', get(`/api/stats?from=2090-01-01&to=2095-01-01`), 400);
    await expectStatus('stats from > to → 400', get(`/api/stats?from=${D10}&to=${D9}`), 400);
    await expectStatus('stats bez parametara → 400', get('/api/stats'), 400);

    // Samo otvoren dan (blokovi iz šablona, svi pending) nije praćen: ne ulazi u prosek ni u zbir.
    const opened = await expectOk('otvori D11 bez čekiranja', get(`/api/days/${D11}?ensure=1`));
    check('D11 inicijalizovan', opened.initialized === true, opened.initialized);
    await expectOk('D11 beleška', patch(`/api/days/${D11}`, { note: 'Samo otvoren dan.' }));
    const s3 = await expectOk('stats posle otvaranja D11', get(`/api/stats?from=${D9}&to=${D11}`));
    check('otvoren dan: initialized, summary null', s3.days[2].initialized === true && s3.days[2].summary === null, s3.days[2]);
    check('otvoren dan ne menja totals', s3.totals.daysTracked === 2 && near(s3.totals.avgScore, 0.875) && same(s3.totals.categories, tot.categories), s3.totals);
    check('otvoren dan ne menja niz', s3.streak === expectedStreak, s3.streak);

    // `today`: kad je period završen, i njegov poslednji dan prekida niz.
    let st = await expectOk('stats today = to', get(`/api/stats?from=${D9}&to=${D11}&today=${D11}`));
    check('niz: poslednji dan još traje', st.streak === expectedStreak, st.streak);
    st = await expectOk('stats završen period', get(`/api/stats?from=${D9}&to=${D11}&today=${addDays(D11, 1)}`));
    check('niz: završen period, poslednji dan nije praćen → 0', st.streak === 0, st.streak);
    st = await expectOk('stats završen period do D10', get(`/api/stats?from=${D9}&to=${D10}&today=${D11}`));
    check('niz: završen period do D10', st.streak === expectedStreak, st.streak);
    await expectStatus('stats today loš → 400', get(`/api/stats?from=${D9}&to=${D10}&today=sutra`), 400);
  });

  // ---- Dnevnik ----
  await section('journal', async () => {
    await expectOk('beleška samo razmaci', patch(`/api/days/${D8}`, { note: '   \n  ' }));
    let j = await expectOk('dnevnik q=čaj', get(`/api/journal?q=${encodeURIComponent('čaj')}&limit=100`));
    const dates = j.map((e) => e.date);
    check('pretraga: pronađen "čaj" i "ČAJ"', dates.includes(D2) && dates.includes(D9), dates);
    check('pretraga: bez nepovezanih', !dates.includes(D10), dates);
    check('pretraga: opadajuće po datumu', dates.every((x, i) => i === 0 || dates[i - 1] > x));
    const e9 = j.find((e) => e.date === D9);
    check('unos: score, ocena, zadaci', near(e9?.score, 0.75) && e9?.rating === 4 && e9?.tasksDone === 1 && e9?.tasksTotal === 2, e9);
    const e2 = j.find((e) => e.date === D2);
    check('unos neinicijalizovanog dana: score null', e2 && e2.score === null && e2.rating === 3, e2);
    const all = await expectOk('dnevnik sve', get('/api/journal?limit=100'));
    const e11 = all.find((e) => e.date === D11);
    check('unos samo otvorenog dana: score null', e11 && e11.score === null, e11);
    j = await expectOk('dnevnik q=CAJ (bez kvačica)', get('/api/journal?q=CAJ&limit=100'));
    check('pretraga bez dijakritika', j.some((e) => e.date === D9) && j.some((e) => e.date === D2));
    j = await expectOk('dnevnik before', get(`/api/journal?before=${D10}&limit=100`));
    check('before: samo raniji datumi', j.every((e) => e.date < D10) && j.some((e) => e.date === D9));
    check('prazna beleška se ne prikazuje', !j.some((e) => e.date === D8));
    j = await expectOk('dnevnik limit=1', get('/api/journal?limit=1'));
    check('limit 1', j.length === 1);
    j = await expectOk('dnevnik podrazumevano', get('/api/journal'));
    check('podrazumevani limit ≤ 20', Array.isArray(j) && j.length <= 20 && j.length >= 3);
    await expectStatus('dnevnik limit=abc → 400', get('/api/journal?limit=abc'), 400);
    await expectStatus('dnevnik before loš → 400', get('/api/journal?before=juce'), 400);
  });

  // ---- Raspored: brisanje kategorije, šabloni, dani u nedelji, podešavanja ----
  await section('schedule', async () => {
    // Brisanje kategorije = arhiviranje: nestaje iz izbora, sačuvani blokovi i zadaci je zadržavaju.
    let s = await expectOk('obriši kategoriju', del(`/api/categories/${catDel.id}`));
    check('kategorija obrisana iz izbora', !s.categories.some((c) => c.id === catDel.id));
    check('obrisana kategorija u archivedCategories', s.archivedCategories?.some((c) => c.id === catDel.id && c.name === 'Smoke briši'), s.archivedCategories);
    const d3 = await expectOk('GET D3', get(`/api/days/${D3}`));
    const kept = d3.blocks.find((b) => b.title === 'Smoke blok 2');
    check('blok zadržava obrisanu kategoriju', kept?.categoryId === catDel.id, kept);
    const d4 = await expectOk('GET D4', get(`/api/days/${D4}`));
    check('zadatak zadržava obrisanu kategoriju', d4.tasks.find((t) => t.title === 'Kupi zeleni čaj')?.categoryId === catDel.id);
    await expectStatus('obriši kategoriju ponovo → 404', del(`/api/categories/${catDel.id}`), 404);
    await expectStatus('izmena obrisane kategorije → 404', patch(`/api/categories/${catDel.id}`, { name: 'X' }), 404);
    await expectStatus('nov blok sa obrisanom kategorijom → 400', post(`/api/days/${D3}/blocks`, { start: 1000, end: 1010, title: 'X', categoryId: catDel.id }), 400);
    await expectStatus('nov zadatak sa obrisanom kategorijom → 400', post('/api/tasks', { date: D4, title: 'X', categoryId: catDel.id }), 400);
    await expectStatus('blok prebačen u obrisanu kategoriju → 400', patch(`/api/blocks/${d3.blocks.find((b) => b.categoryId !== catDel.id).id}`, { categoryId: catDel.id }), 400);
    await expectOk('blok sa istom (obrisanom) kategorijom → 200', patch(`/api/blocks/${kept.id}`, { categoryId: catDel.id, note: 'i dalje radi' }));
    s = await expectOk('nova kategorija sa nazivom obrisane', post('/api/categories', { name: 'Smoke briši', color: '#445566', counts: true }));
    const reborn = s.categories.find((c) => c.name === 'Smoke briši');
    check('nova kategorija ne dobija id obrisane', reborn && reborn.id > catDel.id, [reborn?.id, catDel.id]);
    await expectOk('obriši novu kategoriju', del(`/api/categories/${reborn.id}`));

    // Ranije ispunjenosti i niz se ne menjaju kad se obriše kategorija koja se ne računa,
    // a šabloni je više ne koriste.
    s = await expectOk('kategorija "Smoke pauza" (ne računa se)', post('/api/categories', { name: 'Smoke pauza', color: '#9a9890', counts: false }));
    const pauza = s.categories.find((c) => c.name === 'Smoke pauza');
    await expectOk('D15 prazan dan', post(`/api/days/${D15}/init`, { reset: true, templateId: null }));
    await expectOk('D15 pauza', post(`/api/days/${D15}/blocks`, { start: 900, end: 960, title: 'Pauza', categoryId: pauza.id }));
    let d15 = await expectOk('D15 rad', post(`/api/days/${D15}/blocks`, { start: 600, end: 700, title: 'Rad', categoryId: catCount.id }));
    await expectOk('D15 rad done', patch(`/api/blocks/${d15.blocks.find((b) => b.title === 'Rad').id}`, { status: 'done' }));
    s = await expectOk('šablon sa pauzom', post('/api/templates', { name: 'Smoke pauza šablon' }));
    const pTpl = s.templates.find((t) => t.name === 'Smoke pauza šablon');
    await expectOk('šablon: blok pauze', put(`/api/templates/${pTpl.id}/blocks`, { blocks: [{ start: 900, end: 960, title: 'Pauza', categoryId: pauza.id }] }));
    const st1 = await expectOk('stats D15 pre brisanja', get(`/api/stats?from=${D15}&to=${D15}`));
    check('D15: score 1, counted 1', near(st1.days[0].summary?.score, 1) && st1.days[0].summary?.counted === 1, st1.days[0].summary);
    s = await expectOk('obriši "Smoke pauza"', del(`/api/categories/${pauza.id}`));
    check('šablon: blok pauze bez kategorije', s.templates.find((t) => t.id === pTpl.id)?.blocks[0]?.categoryId === null, s.templates.find((t) => t.id === pTpl.id));
    const st2 = await expectOk('stats D15 posle brisanja', get(`/api/stats?from=${D15}&to=${D15}`));
    check('D15: ispunjenost i niz isti posle brisanja', same(st2.days[0].summary, st1.days[0].summary) && st2.streak === st1.streak, [st2.days[0].summary, st2.streak, st1.streak]);
    d15 = await expectOk('GET D15', get(`/api/days/${D15}`));
    check('D15: pauza zadržava kategoriju', d15.blocks.find((b) => b.title === 'Pauza')?.categoryId === pauza.id);
    // Stranica dana računa ispunjenost na klijentu sa categories + archivedCategories iz rasporeda;
    // mora da se slaže sa statistikom (Napredak, niz). Samo aktivne kategorije bi pauzu računale kao blok bez kategorije.
    const sp = await expectOk('raspored posle brisanja "Smoke pauza"', get('/api/schedule'));
    check('archivedCategories: "Smoke pauza" sa nazivom, bojom i counts=false', sp.archivedCategories?.some((c) => c.id === pauza.id && c.name === 'Smoke pauza' && c.color === '#9a9890' && c.counts === false), sp.archivedCategories);
    const dayView = summarizeBlocks(d15.blocks, [...sp.categories, ...(sp.archivedCategories ?? [])]);
    check('D15: ispunjenost dana (kao na klijentu) = statistika', same(dayView, st2.days[0].summary), [dayView, st2.days[0].summary]);
    check('D15: bez archivedCategories bi se pauza računala', !near(summarizeBlocks(d15.blocks, sp.categories).score, st2.days[0].summary?.score ?? NaN));
    await expectOk('obriši šablon sa pauzom', del(`/api/templates/${pTpl.id}`));

    const src = schedule.templates.find((t) => t.blocks.length > 0);
    s = await expectOk('novi šablon', post('/api/templates', { name: 'Smoke šablon' }));
    const created = s.templates.find((t) => t.name === 'Smoke šablon');
    check('novi šablon prazan, na kraju', created && created.blocks.length === 0 && s.templates.at(-1).id === created.id);
    s = await expectOk('kopija šablona', post('/api/templates', { name: 'Smoke kopija', copyFrom: src.id }));
    const copy = s.templates.find((t) => t.name === 'Smoke kopija');
    check('kopija ima iste blokove', copy && same(copy.blocks.map(shape), src.blocks.map(shape)) && copy.blocks.every((b) => b.templateId === copy.id));
    await expectStatus('kopija nepostojećeg → 400', post('/api/templates', { name: 'X', copyFrom: 999999 }), 400);
    await expectStatus('šablon bez naziva → 400', post('/api/templates', { name: '' }), 400);
    s = await expectOk('preimenuj šablon', patch(`/api/templates/${created.id}`, { name: 'Smoke šablon 2' }));
    check('šablon preimenovan', s.templates.find((t) => t.id === created.id)?.name === 'Smoke šablon 2');
    const dupTpl = await expectStatus('šablon postojeći naziv → 409', post('/api/templates', { name: ' smoke ŠABLON 2' }), 409);
    check('409: poruka o nazivu šablona', dupTpl.json?.error === 'Šablon sa tim nazivom već postoji.', dupTpl.text);
    await expectStatus('kopija sa postojećim nazivom → 409', post('/api/templates', { name: 'Smoke kopija', copyFrom: src.id }), 409);
    await expectStatus('preimenovanje šablona u postojeći naziv → 409', patch(`/api/templates/${copy.id}`, { name: 'Smoke Šablon 2' }), 409);
    await expectOk('isti naziv šablona (bez promene) → 200', patch(`/api/templates/${created.id}`, { name: 'Smoke šablon 2' }));
    await expectStatus('preimenuj nepostojeći → 404', patch('/api/templates/99999999', { name: 'X' }), 404);

    const blocks = [
      { start: 1380, end: 1440, title: 'Kasno', categoryId: catCount.id },
      { start: 600, end: 720, title: 'Jutro', categoryId: null },
    ];
    s = await expectOk('PUT blokovi šablona', put(`/api/templates/${created.id}/blocks`, { blocks }));
    const tb = s.templates.find((t) => t.id === created.id).blocks;
    check('blokovi šablona zamenjeni i sortirani', same(tb.map(shape), [[600, 720, 'Jutro', null], [1380, 1440, 'Kasno', catCount.id]]), tb);
    await expectStatus('PUT blokovi loš opseg → 400', put(`/api/templates/${created.id}/blocks`, { blocks: [{ start: 500, end: 400, title: 'X', categoryId: null }] }), 400);
    await expectStatus('PUT blokovi > 100 → 400', put(`/api/templates/${created.id}/blocks`, { blocks: Array.from({ length: 101 }, () => ({ start: 600, end: 610, title: 'X', categoryId: null })) }), 400);
    await expectStatus('PUT blokovi naslov > 120 → 400', put(`/api/templates/${created.id}/blocks`, { blocks: [{ start: 600, end: 610, title: 'x'.repeat(121), categoryId: null }] }), 400);
    await expectStatus('PUT blokovi nepostojeći šablon → 404', put('/api/templates/99999999/blocks', { blocks: [] }), 404);
    {
      // Blok ceo van logičkog dana prelazi na drugi kraj dana (inače bi bio skriven na traci šablona i u danu).
      const ds = s.settings.dayStart;
      const outside = [
        { start: ds + 1440 + 30, end: ds + 1440 + 90, title: 'Posle kraja dana', categoryId: null },
        ...(ds > 0 ? [{ start: 0, end: ds, title: 'Pre početka dana', categoryId: null }] : []),
      ];
      s = await expectOk('PUT blokovi van logičkog dana', put(`/api/templates/${created.id}/blocks`, { blocks: [...outside, ...blocks] }));
      const got = sortShapes(s.templates.find((t) => t.id === created.id).blocks.map(shape));
      const want = sortShapes([
        [ds + 30, ds + 90, 'Posle kraja dana', null],
        ...(ds > 0 ? [[1440, 1440 + ds, 'Pre početka dana', null]] : []),
        ...blocks.map(shape),
      ]);
      check('blokovi van logičkog dana premešteni na drugi kraj dana', same(got, want), got);
      s = await expectOk('vrati blokove šablona', put(`/api/templates/${created.id}/blocks`, { blocks }));
      check('blokovi šablona vraćeni', same(s.templates.find((t) => t.id === created.id).blocks.map(shape), [[600, 720, 'Jutro', null], [1380, 1440, 'Kasno', catCount.id]]));
    }

    // Dani u nedelji
    const origWeekdays = { ...schedule.weekdays };
    s = await expectOk('PUT dani u nedelji', put('/api/weekdays', { ...origWeekdays, 6: copy.id, 7: null }));
    check('dani u nedelji sačuvani', s.weekdays[6] === copy.id && s.weekdays[7] === null, s.weekdays);
    await expectStatus('dan u nedelji 8 → 400', put('/api/weekdays', { 8: null }), 400);
    await expectStatus('nepostojeći šablon za dan → 400', put('/api/weekdays', { 1: 999999 }), 400);
    s = await expectOk('obriši šablon', del(`/api/templates/${copy.id}`));
    check('šablon obrisan, dan u nedelji → null', !s.templates.some((t) => t.id === copy.id) && s.weekdays[6] === null, s.weekdays);
    await expectStatus('obriši šablon ponovo → 404', del(`/api/templates/${copy.id}`), 404);
    s = await expectOk('vrati dane u nedelji', put('/api/weekdays', origWeekdays));
    check('dani u nedelji vraćeni', same(s.weekdays, origWeekdays));

    // Podešavanja: promena dayStart premešta samo blokove šablona koji ispadnu iz novog dana
    // (zidno vreme ostaje isto; blok koji se i dalje preklapa sa danom ostaje gde je).
    const origSettings = s.settings;
    const tplShapes = (sched) => sched.templates.map((t) => ({ id: t.id, blocks: sortShapes(t.blocks.map(shape)) }));
    const beforeTpl = tplShapes(s);
    s = await expectOk('prag niza 0.8', patch('/api/settings', { streakThreshold: 0.8 }));
    check('prag sačuvan', s.settings.streakThreshold === 0.8 && s.settings.dayStart === origSettings.dayStart);
    const replaceBlocks = (tpls, ds) =>
      tpls.map((t) => ({
        id: t.id,
        blocks: sortShapes(
          t.blocks.map(([st, en, title, cat]) => {
            const shift = st >= ds + 1440 ? -1440 : en <= ds ? 1440 : 0;
            return [st + shift, en + shift, title, cat];
          }),
        ),
      }));
    let expected = beforeTpl;
    const starts = origSettings.dayStart === 0 ? [120, 180, 360, 0] : [0, 120, 180, 360];
    for (const ds of starts) {
      s = await expectOk(`dayStart → ${ds}`, patch('/api/settings', { dayStart: ds }));
      expected = replaceBlocks(expected, ds);
      const actual = tplShapes(s);
      check(`dayStart ${ds}: blokovi šablona na pravom mestu`, same(actual, expected), actual);
      // Šablon 1 iz podataka testa (napravljen sa dayStart 01:00).
      const t1 = s.templates.find((t) => t.id === fx.tpl1.id);
      const has = (title, st, en) => !!t1?.blocks.some((b) => b.title === title && b.start === st && b.end === en);
      check(`dayStart ${ds}: 01:00–09:00 ostaje 60–540`, has('Noćni blok', 60, 540), t1?.blocks.map(shape));
      check(`dayStart ${ds}: 23:00–00:00 ostaje 1380–1440`, has('Kasni blok', 1380, 1440), t1?.blocks.map(shape));
      if (ds === 0) check('dayStart 0: 00:00–01:00 prelazi na početak dana (0–60)', has('Posle ponoći', 0, 60), t1?.blocks.map(shape));
      else check(`dayStart ${ds}: 00:00–01:00 ostaje 1440–1500`, has('Posle ponoći', 1440, 1500), t1?.blocks.map(shape));
      check(`dayStart ${ds}: šablon 2 — 01:00–09:00 ostaje 60–540`, !!s.templates.find((t) => t.id === fx.tpl2.id)?.blocks.some((b) => b.start === 60 && b.end === 540));
    }
    const d3b = await expectOk('sačuvani dani se ne menjaju', get(`/api/days/${D3}`));
    check('dan D3 isti posle promene dayStart', same(d3b.blocks.map(shape), d3.blocks.map(shape)));
    s = await expectOk('vrati podešavanja', patch('/api/settings', origSettings));
    const back = tplShapes(s);
    check('povratak dayStart: blokovi na pravom mestu', same(back, replaceBlocks(expected, origSettings.dayStart)), back);
    const fxOnly = (list) => list.filter((t) => t.id === fx.tpl1.id || t.id === fx.tpl2.id);
    check('povratak dayStart: šabloni testa isti kao pre', fxOnly(back).length === 2 && same(fxOnly(back), fxOnly(beforeTpl)), fxOnly(back));
    if (fresh) check('povratak dayStart vraća iste blokove', same(back, beforeTpl), back);
    await expectStatus('dayStart 361 → 400', patch('/api/settings', { dayStart: 361 }), 400);
    await expectStatus('dayStart 30.5 → 400', patch('/api/settings', { dayStart: 30.5 }), 400);
    await expectStatus('prag 0.05 → 400', patch('/api/settings', { streakThreshold: 0.05 }), 400);

    s = await expectOk('obriši smoke šablon', del(`/api/templates/${created.id}`));
    check('smoke šablon obrisan', !s.templates.some((t) => t.id === created.id));
  });

  // ---- Izvoz i uvoz ----
  await section('backup', async () => {
    const r = await get('/api/export');
    check('export 200', r.status === 200, r.status);
    check('export: Content-Disposition', /attachment; filename="ritam-backup-\d{4}-\d{2}-\d{2}\.json"/.test(r.headers.get('content-disposition') || ''), r.headers.get('content-disposition'));
    const e1 = r.json;
    check('export: oblik', e1?.app === 'ritam' && e1?.version === 1 && typeof e1?.exportedAt === 'string' && ['categories', 'templates', 'template_blocks', 'weekday_templates', 'days', 'blocks', 'tasks'].every((k) => Array.isArray(e1[k])));
    check('export: snake_case kolone', e1.blocks.length > 0 && 'start_min' in e1.blocks[0] && 'actual_min' in e1.blocks[0]);
    check('export: budući pregled nije upisan', !e1.days.some((d) => d.date === FUT));

    const ok = await expectOk('import (roundtrip)', post('/api/import', e1));
    check('import vraća {ok:true}', ok?.ok === true);
    const e2 = await expectOk('export posle importa', get('/api/export'));
    check('roundtrip: isti podaci', same(withoutStamp(e1), withoutStamp(e2)));

    await expectStatus('import pogrešan oblik → 400', post('/api/import', { app: 'nesto' }), 400);
    const broken = { ...e1, blocks: [...e1.blocks, { ...e1.blocks[0], id: 99999999, date: '2001-01-01' }] };
    await expectStatus('import pokvarene veze → 400', post('/api/import', broken), 400);
    const e3 = await expectOk('export posle neuspelog importa', get('/api/export'));
    check('neuspeo import ne menja ništa', same(withoutStamp(e1), withoutStamp(e3)));

    check('export: obrisane kategorije su u kopiji', e1.categories.some((c) => c.id === catDel.id && c.archived === 1), e1.categories);

    // Uvoz poštuje ista ograničenja kao API (inače red kasnije ne bi mogao da se izmeni).
    const bad = (name, mutate) => expectStatus(`import: ${name} → 400`, post('/api/import', mutate(structuredClone(e1))), 400);
    await bad('prazan naslov bloka', (x) => ((x.blocks[0].title = '  '), x));
    await bad('naslov bloka > 120', (x) => ((x.blocks[0].title = 'x'.repeat(121)), x));
    await bad('negativno stvarno vreme', (x) => ((x.blocks[0].actual_min = -50), x));
    await bad('beleška bloka > 5000', (x) => ((x.blocks[0].note = 'x'.repeat(5001)), x));
    await bad('naziv kategorije > 40', (x) => ((x.categories[0].name = 'x'.repeat(41)), x));
    await bad('naziv šablona > 60', (x) => ((x.templates[0].name = 'x'.repeat(61)), x));
    await bad('prazan naslov bloka šablona', (x) => ((x.template_blocks[0].title = ''), x));
    await bad('beleška dana > 20000', (x) => ((x.days[0].note = 'x'.repeat(20001)), x));
    await bad('prazan naziv zadatka', (x) => ((x.tasks[0].title = ' '), x));
    const e5 = await expectOk('export posle odbijenih uvoza', get('/api/export'));
    check('odbijeni uvozi ne menjaju ništa', same(withoutStamp(e1), withoutStamp(e5)));

    // Kopija od pre arhiviranja kategorija (bez kolone archived) se uvozi: sve kategorije su aktivne.
    const legacy = structuredClone(e1);
    for (const c of legacy.categories) delete c.archived;
    await expectOk('import stare kopije bez "archived"', post('/api/import', legacy));
    const e6 = await expectOk('export posle stare kopije', get('/api/export'));
    check('stara kopija: kategorije aktivne', e6.categories.length === e1.categories.length && e6.categories.every((c) => c.archived === 0), e6.categories);

    // Veća kopija od 1 MB prolazi (limit za uvoz je 20 MB).
    const extraDays = Array.from({ length: 60 }, (_, i) => ({
      date: addDays('2096-01-01', i),
      initialized: 0,
      template_id: null,
      note: `beleška ${i} `.repeat(1800),
      rating: null,
      updated_at: new Date().toISOString(),
    }));
    const big = { ...e1, days: [...e1.days, ...extraDays] };
    check('kopija je veća od 1 MB', Buffer.byteLength(JSON.stringify(big)) > 1024 * 1024, Buffer.byteLength(JSON.stringify(big)));
    await expectOk('import > 1 MB', post('/api/import', big));
    const e4 = await expectOk('export velike kopije', get('/api/export'));
    check('velika kopija sačuvana', extraDays.every((x) => e4.days.find((d) => d.date === x.date)?.note === x.note));
    await expectOk('import nazad', post('/api/import', e1));
  });

  // ---- Raspored ispočetka (POST /api/schedule/reset) na bazi iz ranije verzije ----
  // Postojeća baza se nikad ne prazni sama; korisnik ovom akcijom briše kategorije, šablone i dane u nedelji,
  // a sačuvani dani, zadaci, beleške i ispunjenost ranijih dana ostaju.
  await section('schedule reset', async () => {
    const before = await expectOk('reset: izvoz pre', get('/api/export'));
    try {
      await expectOk('reset: uvoz baze iz ranije verzije', post('/api/import', legacyBackup()));
      const exp0 = await expectOk('reset: izvoz stare baze', get('/api/export'));
      const sc0 = await expectOk('reset: stari raspored', get('/api/schedule'));
      check('reset: stari raspored postoji', sc0.categories.length === 3 && sc0.templates.length === 2 && Object.values(sc0.weekdays).every((v) => v !== null) && sc0.settings.dayStart === 60, sc0);
      const statsUrl = `/api/stats?from=${L1}&to=${L3}&today=${L4}`;
      const st0 = await expectOk('reset: statistika pre', get(statsUrl));
      check('reset: stari dani praćeni (0.5 i 1)', near(st0.days[0].summary?.score, 0.5) && st0.days[0].summary?.counted === 3 && near(st0.days[1].summary?.score, 1) && st0.days[2].summary === null, st0.days.map((d) => d.summary));
      const st0b = await expectOk('reset: niz pre', get(`/api/stats?from=${L1}&to=${L2}&today=${L3}`));
      check('reset: niz pre = 1', st0b.streak === 1, st0b.streak);
      const j0 = await expectOk('reset: dnevnik pre', get('/api/journal?limit=100'));
      const d1Before = await expectOk('reset: praćen dan pre', get(`/api/days/${L1}`));
      const p4Before = await expectOk('reset: pregled pre', get(`/api/days/${L4}`));
      check('reset: pregled iz starog šablona', p4Before.initialized === false && p4Before.blocks.length > 0 && p4Before.templateId !== null, p4Before);

      await expectStatus('reset bez X-Ritam → 403', post('/api/schedule/reset', {}, { csrf: false }), 403);
      await expectStatus('reset: dayStart "da" → 400', post('/api/schedule/reset', { dayStart: 'da' }), 400);
      const unchanged = await expectOk('reset: izvoz posle odbijenih', get('/api/export'));
      check('reset: odbijen zahtev ne menja ništa', same(withoutStamp(unchanged), withoutStamp(exp0)));

      let sc = await expectOk('raspored ispočetka', post('/api/schedule/reset', {}));
      check('reset: nema kategorija ni šablona', sc.categories.length === 0 && sc.templates.length === 0, sc);
      check('reset: svi dani u nedelji bez šablona', same(sc.weekdays, NO_TEMPLATES), sc.weekdays);
      check('reset: bez dayStart podešavanja ostaju', same(sc.settings, exp0.settings), sc.settings);
      const archived = exp0.categories.map((c) => [c.id, c.name, c.color, c.counts === 1]);
      check('reset: sve kategorije su među obrisanim (naziv, boja, counts)', same(sc.archivedCategories.map((c) => [c.id, c.name, c.color, c.counts]), archived), sc.archivedCategories);
      const exp1 = await expectOk('reset: izvoz posle', get('/api/export'));
      check('reset: kopija bez šablona i blokova šablona', exp1.templates.length === 0 && exp1.template_blocks.length === 0, [exp1.templates, exp1.template_blocks]);
      check('reset: kategorije arhivirane, ne obrisane', same(exp1.categories, exp0.categories.map((c) => ({ ...c, archived: 1 }))), exp1.categories);
      check('reset: dani u nedelji null u kopiji', same(exp1.weekday_templates, exp0.weekday_templates.map((w) => ({ ...w, template_id: null }))), exp1.weekday_templates);
      check('reset: dani ostaju (samo bez šablona)', same(exp1.days, exp0.days.map((d) => ({ ...d, template_id: null }))), exp1.days);
      check('reset: blokovi i zadaci nepromenjeni', same(exp1.blocks, exp0.blocks) && same(exp1.tasks, exp0.tasks));

      const st1 = await expectOk('reset: statistika posle', get(statsUrl));
      check('reset: ispunjenost i zbir po kategorijama isti', same(st1.days, st0.days) && same(st1.totals, st0.totals), [st1.days.map((d) => d.summary?.score), st1.totals]);
      const st1b = await expectOk('reset: niz posle', get(`/api/stats?from=${L1}&to=${L2}&today=${L3}`));
      check('reset: niz isti', st1b.streak === st0b.streak, st1b.streak);
      const j1 = await expectOk('reset: dnevnik posle', get('/api/journal?limit=100'));
      check('reset: dnevnik isti', same(j1, j0), j1);
      const d1 = await expectOk('reset: praćen dan posle', get(`/api/days/${L1}`));
      check('reset: praćen dan zadržava blokove, zadatke i belešku', d1.initialized === true && same(d1.blocks, d1Before.blocks) && same(d1.tasks, d1Before.tasks) && d1.note === d1Before.note && d1.rating === d1Before.rating, d1);
      check('reset: praćen dan bez šablona', d1.templateId === null && d1.templateName === null, [d1.templateId, d1.templateName]);
      const d1Summary = summarizeBlocks(d1.blocks, [...sc.categories, ...sc.archivedCategories]);
      check('reset: ispunjenost dana (kao na klijentu) = statistika', same(d1Summary, st1.days[0].summary), [d1Summary, st1.days[0].summary]);
      const p4 = await expectOk('reset: pregled posle', get(`/api/days/${L4}`));
      check('reset: pregled je prazan dan', p4.initialized === false && p4.blocks.length === 0 && p4.templateId === null && p4.templateName === null, p4);

      sc = await expectOk('reset ponovo, i dan od 00:00', post('/api/schedule/reset', { dayStart: true }));
      check('reset: dayStart → 00:00, prag ostaje', same(sc.settings, { dayStart: 0, streakThreshold: exp0.settings.streakThreshold }), sc.settings);
      check('reset: ponovljen reset ne menja ostalo', sc.categories.length === 0 && sc.templates.length === 0 && same(sc.weekdays, NO_TEMPLATES) && sc.archivedCategories.length === archived.length, sc);
      const st2 = await expectOk('reset: statistika posle dayStart', get(statsUrl));
      check('reset: dayStart ne menja ranije dane', same(st2.days, st0.days) && same(st2.totals, st0.totals));

      // Posle reseta korisnik pravi svoj raspored; stari nazivi su slobodni, a stari id-jevi se ne vezuju ni za šta.
      sc = await expectOk('reset: nova kategorija sa starim nazivom', post('/api/categories', { name: 'Stara A', color: '#123456', counts: true }));
      const cat = sc.categories.find((c) => c.name === 'Stara A');
      check('reset: nova kategorija dobija nov id', sc.categories.length === 1 && cat && cat.id > Math.max(...archived.map((a) => a[0])), sc.categories);
      sc = await expectOk('reset: nov šablon', post('/api/templates', { name: 'Stari šablon 1' }));
      const tpl = sc.templates[0];
      await expectOk('reset: blok novog šablona', put(`/api/templates/${tpl.id}/blocks`, { blocks: [{ start: 600, end: 660, title: 'Nov blok', categoryId: cat.id }] }));
      sc = await expectOk('reset: šablon za dan u nedelji', put('/api/weekdays', { [isoWeekday(L4)]: tpl.id }));
      check('reset: dan u nedelji dobija nov šablon', sc.weekdays[isoWeekday(L4)] === tpl.id, sc.weekdays);
      const p4b = await expectOk('reset: pregled sa novim šablonom', get(`/api/days/${L4}`));
      check('reset: pregled iz novog šablona', p4b.templateId === tpl.id && same(p4b.blocks.map(shape), [[600, 660, 'Nov blok', cat.id]]), p4b);
      const d1b = await expectOk('reset: stari dan posle novog šablona', get(`/api/days/${L1}`));
      check('reset: stari dan ne dobija nov šablon', d1b.templateId === null && d1b.templateName === null && same(d1b.blocks, d1Before.blocks), [d1b.templateId, d1b.templateName]);
    } finally {
      await expectOk('reset: vrati stanje', post('/api/import', before));
      const back = await expectOk('reset: izvoz posle vraćanja', get('/api/export'));
      check('reset: stanje vraćeno', same(withoutStamp(back), withoutStamp(before)));
    }
  });
}


// ---- Odvojeni podaci: B ne vidi i ne menja ništa od A (svaki tuđ id/datum izgleda kao da ne postoji) ----
async function isolationSection() {
  await section('isolation', async () => {
    current = A;
    const DI = '2097-05-05';
    const DI0 = addDays(DI, -1);
    const DI1 = addDays(DI, 1);
    let s = await expectOk('A: kategorija (izolacija)', post('/api/categories', { name: 'Izolacija', color: '#336699', counts: true }));
    const catI = s.categories.find((c) => c.name === 'Izolacija');
    s = await expectOk('A: šablon (izolacija)', post('/api/templates', { name: 'Izolacija šablon' }));
    const tplI = s.templates.find((t) => t.name === 'Izolacija šablon');
    await expectOk('A: blok šablona', put(`/api/templates/${tplI.id}/blocks`, { blocks: [{ start: 480, end: 600, title: 'A jutro', categoryId: catI.id }] }));
    await expectOk('A: dan iz šablona', post(`/api/days/${DI}/init`, { reset: true, templateId: tplI.id }));
    let d = await expectOk('A: drugi blok', post(`/api/days/${DI}/blocks`, { start: 700, end: 760, title: 'A podne', categoryId: null }));
    const [ab1, ab2] = d.blocks;
    await expectOk('A: blok urađen', patch(`/api/blocks/${ab1.id}`, { status: 'done' }));
    await expectOk('A: beleška i ocena', patch(`/api/days/${DI}`, { note: 'A tajna beleška', rating: 5 }));
    d = await expectOk('A: zadatak', post('/api/tasks', { date: DI, title: 'A zadatak', categoryId: catI.id }));
    const at1 = d.tasks[0];
    await expectOk('A: zadatak urađen', patch(`/api/tasks/${at1.id}`, { done: true }));
    d = await expectOk('A: otvoren raniji zadatak', post('/api/tasks', { date: DI0, title: 'A otvoren', categoryId: null }));
    const at2 = d.tasks.find((t) => t.title === 'A otvoren');
    const aView = async () => ({
      schedule: await expectOk('A: raspored', get('/api/schedule')),
      day: await expectOk('A: dan', get(`/api/days/${DI}`)),
      day0: await expectOk('A: raniji dan', get(`/api/days/${DI0}`)),
      stats: await expectOk('A: statistika', get(`/api/stats?from=${DI0}&to=${DI1}`)),
      journal: await expectOk('A: dnevnik', get('/api/journal?limit=100')),
      done: await expectOk('A: završeni zadaci', get(`/api/tasks/done?from=${DI0}&to=${DI1}`)),
    });
    const before = await aView();
    const ea0 = await expectOk('A: izvoz pre', get('/api/export'));
    check('A: podaci za izolaciju postoje', before.day.blocks.length === 2 && before.day.note === 'A tajna beleška' && before.done.length === 1 && before.day0.tasks.length === 1, before.day);

    const B = newUser('b');
    const reg = await expectOk('B: registracija', register(B), 201);
    check('B: drugi id', reg.user.id !== A.id, reg.user);
    const asB = { as: B };
    check('B: /api/auth/me je B', same(await expectOk('B: me', get('/api/auth/me', asB)), { user: { id: B.id, email: B.email } }));
    const sb = await expectOk('B: raspored', get('/api/schedule', asB));
    check(
      'B: prazan raspored (bez A-ovih kategorija i šablona)',
      sb.categories.length === 0 && sb.archivedCategories.length === 0 && sb.templates.length === 0 && same(sb.weekdays, NO_TEMPLATES) && same(sb.settings, EMPTY_SETTINGS),
      sb,
    );
    const eb0 = await expectOk('B: izvoz', get('/api/export', asB));
    check(
      'B: prazan izvoz (7 dana u nedelji bez šablona, podrazumevana podešavanja)',
      isEmptyExport(eb0) && same(eb0.weekday_templates, [1, 2, 3, 4, 5, 6, 7].map((weekday) => ({ weekday, template_id: null }))) && same(eb0.settings, EMPTY_SETTINGS),
      eb0,
    );
    let bd = await expectOk('B: A-ov datum', get(`/api/days/${DI}`, asB));
    check('B: ne vidi A-ov dan (blokove, zadatke, belešku, ocenu)', bd.initialized === false && bd.blocks.length === 0 && bd.tasks.length === 0 && bd.note === '' && bd.rating === null && bd.templateId === null && bd.openBefore === 0, bd);
    bd = await expectOk('B: A-ov raniji datum', get(`/api/days/${DI1}`, asB));
    check('B: openBefore ne broji A-ove zadatke', bd.openBefore === 0 && bd.tasks.length === 0, bd);

    const is404 = (name, p) => expectStatus(`B: ${name} → 404`, p, 404);
    const is400 = (name, p) => expectStatus(`B: ${name} → 400`, p, 400);
    await is404('PATCH A-ovog bloka', patch(`/api/blocks/${ab1.id}`, { status: 'skipped' }, asB));
    await is404('DELETE A-ovog bloka', del(`/api/blocks/${ab1.id}`, asB));
    await is404('split A-ovog bloka', post(`/api/blocks/${ab1.id}/split`, { at: 540 }, asB));
    await is404('swap dva A-ova bloka', post(`/api/blocks/${ab1.id}/swap`, { with: ab2.id }, asB));
    bd = await expectOk('B: svoj blok na istom datumu', post(`/api/days/${DI}/blocks`, { start: 900, end: 960, title: 'B blok', categoryId: null }, asB));
    const bb = bd.blocks[0];
    check('B: njegov dan ima samo njegov blok (bez A-ovog šablona)', bd.initialized === true && bd.blocks.length === 1 && bb?.title === 'B blok' && bd.templateId === null && bd.note === '', bd);
    await is404('swap svog bloka sa A-ovim', post(`/api/blocks/${bb.id}/swap`, { with: ab1.id }, asB));
    await is404('swap A-ovog bloka sa svojim', post(`/api/blocks/${ab1.id}/swap`, { with: bb.id }, asB));
    await is404('čekiranje A-ovog zadatka', patch(`/api/tasks/${at1.id}`, { done: false }, asB));
    await is404('premeštanje A-ovog zadatka', patch(`/api/tasks/${at2.id}`, { date: DI }, asB));
    await is404('DELETE A-ovog zadatka', del(`/api/tasks/${at2.id}`, asB));
    await is404('PATCH A-ove kategorije', patch(`/api/categories/${catI.id}`, { name: 'B je promenio' }, asB));
    await is404('DELETE A-ove kategorije', del(`/api/categories/${catI.id}`, asB));
    await is404('PATCH A-ovog šablona', patch(`/api/templates/${tplI.id}`, { name: 'B je promenio' }, asB));
    await is404('DELETE A-ovog šablona', del(`/api/templates/${tplI.id}`, asB));
    await is404('PUT blokova A-ovog šablona', put(`/api/templates/${tplI.id}/blocks`, { blocks: [] }, asB));
    await is400('blok sa A-ovom kategorijom', post(`/api/days/${DI}/blocks`, { start: 1000, end: 1010, title: 'X', categoryId: catI.id }, asB));
    await is400('zadatak sa A-ovom kategorijom', post('/api/tasks', { date: DI, title: 'X', categoryId: catI.id }, asB));
    await is400('svoj blok u A-ovu kategoriju', patch(`/api/blocks/${bb.id}`, { categoryId: catI.id }, asB));
    await is400('kopija A-ovog šablona', post('/api/templates', { name: 'Kopija', copyFrom: tplI.id }, asB));
    await is400('A-ov šablon za dan u nedelji', put('/api/weekdays', { 1: tplI.id }, asB));
    await is400('dan iz A-ovog šablona', post(`/api/days/${DI1}/init`, { templateId: tplI.id }, asB));
    let bs = await expectOk('B: kategorija sa istim nazivom kao A-ova', post('/api/categories', { name: 'Izolacija', color: '#112233', counts: true }, asB));
    const bcat = bs.categories.find((c) => c.name === 'Izolacija');
    check('B: nazivi su jedinstveni samo unutar naloga', bs.categories.length === 1 && bcat && bcat.id !== catI.id, bs.categories);
    bs = await expectOk('B: šablon sa istim nazivom kao A-ov', post('/api/templates', { name: 'Izolacija šablon' }, asB));
    const btpl = bs.templates[0];
    check('B: vidi samo svoj šablon', bs.templates.length === 1 && btpl.id !== tplI.id && btpl.blocks.length === 0, bs.templates);
    await is400('blokovi svog šablona sa A-ovom kategorijom', put(`/api/templates/${btpl.id}/blocks`, { blocks: [{ start: 600, end: 660, title: 'X', categoryId: catI.id }] }, asB));
    bs = await expectOk('B: blok svog šablona', put(`/api/templates/${btpl.id}/blocks`, { blocks: [{ start: 600, end: 660, title: 'B šablon blok', categoryId: bcat.id }] }, asB));
    check('B: samo njegov blok šablona', same(bs.templates.flatMap((t) => t.blocks.map(shape)), [[600, 660, 'B šablon blok', bcat.id]]), bs.templates);
    await expectOk('B: beleška i ocena na A-ovom datumu', patch(`/api/days/${DI}`, { note: 'B beleška', rating: 1 }, asB));
    bd = await expectOk('B: prebaci nezavršene', post('/api/tasks/carry', { to: DI1 }, asB));
    check('B: carry ne dira A-ove zadatke', bd.tasks.length === 0 && bd.openBefore === 0, bd.tasks);
    await expectOk('B: zadatak', post('/api/tasks', { date: DI, title: 'B zadatak' }, asB));
    const bst = await expectOk('B: statistika', get(`/api/stats?from=${DI0}&to=${DI1}`, asB));
    check(
      'B: statistika samo njegova',
      bst.totals.daysTracked === 0 && bst.totals.tasksTotal === 1 && bst.totals.tasksDone === 0 && bst.days[1].rating === 1 && bst.days[1].summary === null && bst.days[0].tasksTotal === 0 && bst.streak === 0,
      bst,
    );
    const bj = await expectOk('B: dnevnik', get('/api/journal?limit=100', asB));
    check('B: dnevnik samo njegov', bj.length === 1 && bj[0].note === 'B beleška' && bj[0].rating === 1, bj);
    const bjq = await expectOk('B: pretraga dnevnika', get(`/api/journal?q=${encodeURIComponent('tajna')}`, asB));
    check('B: pretraga ne nalazi A-ovu belešku', bjq.length === 0, bjq);
    const bdone = await expectOk('B: završeni zadaci', get(`/api/tasks/done?from=${DI0}&to=${DI1}`, asB));
    check('B: nema A-ovih završenih zadataka', bdone.length === 0, bdone);
    await expectOk('B: podešavanja', patch('/api/settings', { dayStart: 120, streakThreshold: 0.5 }, asB));
    await expectOk('B: raspored ispočetka', post('/api/schedule/reset', { dayStart: true }, asB));
    const eb1 = await expectOk('B: izvoz', get('/api/export', asB));
    const aIds = (k) => new Set(ea0[k].map((r) => r.id));
    const disjoint = (e) => ['categories', 'templates', 'template_blocks', 'blocks', 'tasks'].every((k) => e[k].every((r) => !aIds(k).has(r.id)));
    check(
      'B: izvoz samo sa njegovim redovima',
      eb1.days.length === 1 && eb1.days[0].note === 'B beleška' && eb1.blocks.length === 1 && eb1.blocks[0].title === 'B blok' && eb1.tasks.length === 1 && eb1.tasks[0].title === 'B zadatak' && eb1.categories.length === 1 && eb1.categories[0].archived === 1 && eb1.templates.length === 0 && eb1.template_blocks.length === 0 && same(eb1.settings, { dayStart: 0, streakThreshold: 0.5 }) && disjoint(eb1),
      eb1,
    );

    // B uvozi A-ovu kopiju (isti id-jevi kao A-ovi redovi): dobija iste podatke pod svojim novim id-jevima.
    await expectStatus('B: neispravna kopija → 400', post('/api/import', { ...ea0, blocks: [...ea0.blocks, { ...ea0.blocks[0], id: 99999999, date: '2001-01-01' }] }, asB), 400);
    await expectStatus('B: kopija sa vezom ka nepostojećem šablonu → 400', post('/api/import', { ...ea0, weekday_templates: [{ weekday: 1, template_id: 99999999 }] }, asB), 400);
    await expectStatus('B: kopija sa duplim id-jem → 400', post('/api/import', { ...ea0, tasks: [...ea0.tasks, { ...ea0.tasks[0] }] }, asB), 400);
    check('B: odbijen uvoz ne menja njegove podatke', same(rawStamp(await expectOk('B: izvoz posle odbijenih', get('/api/export', asB))), rawStamp(eb1)));
    await expectOk('B: uvoz A-ove kopije', post('/api/import', ea0, asB));
    const eb2 = await expectOk('B: izvoz posle uvoza', get('/api/export', asB));
    check('B: isti sadržaj kao kopija', same(withoutStamp(eb2), withoutStamp(ea0)), eb2);
    check('B: uvezeni redovi imaju nove id-jeve (ne A-ove)', disjoint(eb2), eb2);
    await is404('posle uvoza: PATCH A-ovog bloka', patch(`/api/blocks/${ab1.id}`, { status: 'skipped' }, asB));
    await is404('posle uvoza: DELETE A-ovog zadatka', del(`/api/tasks/${at1.id}`, asB));
    const bDay = await expectOk('B: dan posle uvoza', get(`/api/days/${DI}`, asB));
    check('B: dan iz kopije (svoji id-jevi)', bDay.note === 'A tajna beleška' && bDay.blocks.length === 2 && bDay.blocks.every((b) => b.id !== ab1.id && b.id !== ab2.id), bDay);
    await expectOk('B: menja svoj uvezen blok', patch(`/api/blocks/${bDay.blocks[0].id}`, { status: 'skipped', note: 'B menja svoju kopiju' }, asB));
    await expectOk('B: briše svoj uvezen zadatak', del(`/api/tasks/${bDay.tasks[0].id}`, asB));

    // A: ništa se nije promenilo (i id-jevi su isti), a ni A ne vidi B-ove redove.
    const ea1 = await expectOk('A: izvoz posle', get('/api/export'));
    check('A: izvoz identičan, sa istim id-jevima', same(rawStamp(ea1), rawStamp(ea0)), ea1);
    const after = await aView();
    for (const k of Object.keys(before)) check(`A: ${k} isto posle svega što je B radio`, same(after[k], before[k]), after[k]);
    await expectStatus('A: B-ov blok → 404', patch(`/api/blocks/${bDay.blocks[0].id}`, { status: 'done' }), 404);
    await expectStatus('A: B-ova kategorija → 404', patch(`/api/categories/${bcat.id}`, { name: 'A je promenio' }), 404);

    const out = await rawReq('POST', '/api/auth/logout', { cookie: B.cookie });
    check('B: odjava', out.status === 200);
    // Uklanjanje podataka testa (A): šablon i kategorija; dani se vraćaju sa početnim snimkom (restore).
    await expectOk('A: obriši šablon (izolacija)', del(`/api/templates/${tplI.id}`));
    await expectOk('A: obriši kategoriju (izolacija)', del(`/api/categories/${catI.id}`));
  });
}

async function restore() {
  if (!snapshot) return;
  current = A;
  await section('restore', async () => {
    await expectOk('vrati početno stanje', post('/api/import', snapshot));
    const after = await expectOk('export posle vraćanja', get('/api/export'));
    check('baza vraćena na početno stanje', same(withoutStamp(after), withoutStamp(snapshot)));
  });
}

async function finish() {
  await section('logout A', async () => {
    if (!A.cookie) return;
    const r = await rawReq('POST', '/api/auth/logout', { cookie: A.cookie });
    const sc = (r.headers.getSetCookie?.() ?? []).find((x) => x.startsWith('ritam_refresh=')) ?? '';
    check('logout briše kolačić', r.status === 200 && /^ritam_refresh=;/.test(sc) && /Max-Age=0/i.test(sc), sc);
    const rr = await rawReq('POST', '/api/auth/refresh', { cookie: A.cookie });
    check('posle odjave A: refresh → 401', rr.status === 401, rr.text);
    A.cookie = '';
  });
}

try {
  await main();
  await isolationSection();
} catch (err) {
  check('smoke test se izvršio do kraja', false, err?.stack || String(err));
} finally {
  await restore().catch((err) => check('vraćanje stanja', false, String(err)));
  await finish().catch((err) => check('završne provere', false, String(err)));
}

console.log(`\nUkupno: ${passed} PASS, ${failed} FAIL${skipped ? `, ${skipped} SKIP` : ''}`);
process.exit(failed > 0 ? 1 : 0);
