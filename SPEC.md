# Ritam — specifikacija

Lična aplikacija za planiranje dana u vremenskim blokovima. Jedan korisnik, dva uređaja
(telefon kao PWA + laptop u browseru), podaci na serveru (SQLite) da bi se sinhronizovali.

Primer dana koji je korisnik jednom opisao je samo ilustracija: ništa se ne pravi niti ponaša prema njemu
(sekcija 4). Raspored (kategorije, šabloni, dani u nedelji, početak dana) korisnik pravi sam.

UI je **na srpskom (latinica)**, obraćanje na "ti", kratko i jasno. Bez emodžija, bez uzvičnika.

---

## 1. Stack i struktura

- Node 24, TypeScript. **Server se pokreće direktno kao `.ts`** (Node native type stripping):
  `node --disable-warning=ExperimentalWarning server/index.ts`. Zato u `server/` i `shared/`:
  - relativni importi MORAJU imati `.ts` ekstenziju (`import { x } from './db.ts'`);
  - samo "erasable" TS sintaksa: bez `enum`, `namespace`, parameter properties, `import x = require`;
  - type-only importi preko `import type`.
- Baza: **`node:sqlite`** (`import { DatabaseSync } from 'node:sqlite'`) — ugrađeno, bez native modula.
  - Bind vrednosti: samo number/string/null/bigint/Uint8Array. **Nikad `undefined` ni boolean** — boolean pretvori u 0/1, undefined u null.
  - Redovi koje vraća `.get()/.all()` su objekti sa null prototipom — mapiraj ih u čiste objekte.
  - Transakcije: helper `tx(fn)` sa `BEGIN`/`COMMIT`/`ROLLBACK`.
  - `PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;`
- HTTP: **Hono 4** + `@hono/node-server` 2 (`serve`, i `serveStatic` iz `@hono/node-server/serve-static`).
- Validacija: **zod 4** (`import { z } from 'zod'`).
- Web: React 19 + Vite 8, bez rutera/state biblioteka, ručno pisan CSS (bez Tailwind-a, bez UI biblioteka).
- Typecheck: `npm run typecheck` (`tsconfig.web.json` za `web/src` + `shared`, `tsconfig.server.json` za `server` + `shared`).
- Build: `npm run build` → `vite build` → `dist/web`. Server servira `dist/web`.
- Dev: `npm run dev` (server na :3000 sa `--watch`, Vite na :5173 sa proxy `/api` → :3000).

```
shared/          types.ts, time.ts, summary.ts — VEĆ NAPISANO, deli se između servera i weba
server/          index.ts (ulaz), db.ts, defaults.ts, auth.ts, repo.ts, api.ts ... (agent: server)
web/index.html
web/public/      manifest.webmanifest, sw.js, icons/ (agent: shell)
web/src/
  main.tsx, App.tsx               (agent: shell)
  api.ts                          VEĆ NAPISANO — tipizovan API klijent
  lib/store.ts, router.tsx, hooks.ts   VEĆ NAPISANO
  ui/                             VEĆ NAPISANO — Button, IconButton, Icon, Sheet, Field, TextInput,
                                  TimeInput, Select, TextArea, PageHeader, Card, Empty, Spinner,
                                  PageLoader, ProgressBar, Ring, Segmented, CategoryDot,
                                  CategoryPicker, Toggle, RatingInput, RatingDots, toast, Toaster,
                                  confirmDialog, ConfirmHost, cx
  styles/tokens.css, base.css, ui.css  VEĆ NAPISANO
  pages/DayPage.tsx (+ components/day/*, pages/day.css)          (agent: day)
  pages/ProgressPage.tsx (+ pages/progress.css)                  (agent: progress)
  pages/SchedulePage.tsx (+ components/schedule/*, pages/schedule.css) (agent: schedule)
  pages/JournalPage.tsx (+ pages/journal.css)                    (agent: journal)
  pages/SettingsPage.tsx, pages/LoginPage.tsx, shell.css         (agent: shell)
```

Fajlovi označeni "VEĆ NAPISANO" su zajednički temelj. Agenti ih **ne menjaju** osim ako nađu pravi bag
(tada minimalna izmena + napomena u izveštaju). Ako ti fali nešto generičko, napravi to u svom folderu.

---

## 2. Vreme i dani (najvažnije pravilo)

- Datum: ISO `'YYYY-MM-DD'`. Sve funkcije su u `shared/time.ts`.
- Vreme bloka: **minuti od 00:00 datuma kome blok pripada**. Vrednosti `>= 1440` = posle ponoći
  (npr. `00:00–01:00` na kraju dana = `1440–1500`).
- `settings.dayStart` (podrazumevano `0` = 00:00; korisnik bira 00:00–06:00): logički dan traje od `dayStart` do `dayStart + 1440`.
  Zidno vreme pre `dayStart` pripada kraju PRETHODNOG dana.
  - Konverzija zidnog vremena u minute dana: `normalizeRange(startClock, endClock, dayStart)`.
  - Prikaz: `fmtClock(min)` (radi i za ≥ 1440).
  - "Sada": `logicalNow(dayStart)` → `{ date, minute }` (u 00:30 je datum = juče, minute = 1470.5).
- Blok 01:00–09:00 (kad dan počinje u 00:00 ili 01:00) je na POČETKU dana (noć pre tog dana) — ujutru ga čekiraš u
  današnjem prikazu.
- Validan blok: `isValidRange(start, end)`: `0 <= start < 2880`, `start < end`, trajanje ≤ 1440.

---

## 3. Model podataka (SQLite)

```sql
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  -- 'schema_version' → '3'; 'settings' → JSON {"dayStart":0,"streakThreshold":0.7} (nova baza)

CREATE TABLE categories (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL,
  counts INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0);      -- 1 = obrisana (vidi "Raspored" u sekciji 5)

CREATE TABLE templates (id INTEGER PRIMARY KEY, name TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0);

CREATE TABLE template_blocks (
  id INTEGER PRIMARY KEY,
  template_id INTEGER NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  start_min INTEGER NOT NULL, end_min INTEGER NOT NULL, title TEXT NOT NULL,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL);

CREATE TABLE weekday_templates (
  weekday INTEGER PRIMARY KEY CHECK (weekday BETWEEN 1 AND 7),
  template_id INTEGER REFERENCES templates(id) ON DELETE SET NULL);

CREATE TABLE days (
  date TEXT PRIMARY KEY,
  initialized INTEGER NOT NULL DEFAULT 0,   -- 1 = blokovi su kopirani iz šablona
  template_id INTEGER REFERENCES templates(id) ON DELETE SET NULL,
  note TEXT NOT NULL DEFAULT '',
  rating INTEGER CHECK (rating BETWEEN 1 AND 5),
  updated_at TEXT NOT NULL);

CREATE TABLE blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL REFERENCES days(date) ON DELETE CASCADE,
  start_min INTEGER NOT NULL, end_min INTEGER NOT NULL, title TEXT NOT NULL,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','partial','skipped')),
  actual_min INTEGER,
  note TEXT NOT NULL DEFAULT '');
CREATE INDEX blocks_date ON blocks(date);

CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, title TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0, done_at TEXT,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  sort INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE INDEX tasks_date ON tasks(date);
CREATE INDEX tasks_open ON tasks(done, date);
```

Migracije: niz migracija, `meta.schema_version`; nova baza je prazna (sekcija 4).
Migracija 2 pravi `blocks` i `tasks` ponovo sa `AUTOINCREMENT`: id obrisanog bloka/zadatka se nikad ne dodeljuje
ponovo, pa zastareo zahtev sa drugog uređaja dobija 404 umesto da izmeni drugi red.
Migracija 3 dodaje `categories.archived` (brisanje kategorije je arhiviranje, pa se ni njen id ne dodeljuje ponovo).

### Inicijalizacija dana (lenja)
- Dan se **ne pravi unapred**. `GET /api/days/:date`:
  - ako dan postoji i `initialized = 1` → vrati sačuvane blokove;
  - ako nije inicijalizovan i `?ensure=1` → kopiraj blokove iz šablona (šablon = `weekday_templates[isoWeekday(date)]`),
    upiši `days.initialized = 1, template_id`, vrati;
  - ako nije inicijalizovan bez `ensure` → vrati **pregled**: blokovi iz šablona sa **negativnim id-jevima**
    (`-1, -2, …`), `status 'pending'`, `initialized: false`, ništa ne upisuj (osim što red u `days` može već postojati zbog beleške/ocene).
- Klijent šalje `ensure=1` samo za logičko danas, i to samo kad za taj dan u nedelji postoji šablon (sekcija 6.1). Raniji neinicijalizovani dani i budući dani su pregled dok ih
  korisnik ne izmeni (samo gledanje ranijeg dana ga ne upisuje kao praćen dan sa 0%). Na pregledu ranijeg dana
  statusi su omogućeni: prva ocena bloka inicijalizuje dan (`api.initDay`) pa postavi status istom bloku (isti indeks ako se
  poklapa, inače jedini blok sa istim vremenom, naslovom i kategorijom; ako se plan u međuvremenu promenio — drugi šablon,
  izmena sa drugog uređaja — status se ne postavlja i toast kaže "Plan se u međuvremenu promenio — proveri blokove.").
- Svaka mutacija bloka na neinicijalizovanom danu (dodavanje bloka) prvo inicijalizuje dan iz šablona.
- `POST /api/days/:date/init { reset?: boolean, templateId?: number|null }`:
  inicijalizuje dan; ako je već inicijalizovan i `reset` nije true → 409. Sa `reset: true` briše postojeće blokove i kopira
  ponovo. `templateId` (ako je zadat) koristi taj šablon umesto dana u nedelji (`null` = prazan dan bez blokova).
- Ako nema šablona za taj dan u nedelji (i na novoj, praznoj bazi) → dan bez blokova: pregled ima `blocks: []`,
  `templateId/templateName: null`; `ensure=1` i `init` upisuju inicijalizovan dan bez blokova (kao i do sada).
  Šablon dodeljen danu u nedelji kasnije važi za dane koji još nisu inicijalizovani; upisan dan ga dobija sa
  `init { reset: true }` ("Vrati na šablon") ili izborom šablona.
- Upis beleške/ocene (`PATCH /api/days/:date`) radi upsert reda u `days` **bez** inicijalizacije blokova.

### Promena `settings.dayStart`
Kad se promeni, server premešta `template_blocks` koji ispadnu iz novog logičkog dana (zidno vreme ostaje isto):
blok koji se i dalje preklapa sa `[dayStart, dayStart + 1440)` ostaje gde je (npr. blok `01:00–09:00` = `60–540`
ostaje na početku dana za svaki dayStart 0..360); blok sa `start >= dayStart + 1440` dobija `−1440`
(npr. `00:00–01:00` `1440–1500` → `0–60` kad dan počinje u 00:00), blok sa `end <= dayStart` dobija `+1440`.
Sačuvani dani se ne diraju. Isto pravilo (`intoLogicalDay` u `server/repo.ts`) važi za blokove koji stignu kroz
`PUT /api/templates/:id/blocks` i uvoz, i jednom pri svakom pokretanju servera (blok šablona ceo van logičkog dana,
npr. sačuvan ranijom verzijom klijenta, bio bi skriven na traci i u danu; ponovljeno pokretanje ništa ne menja).

---

## 4. Prazan start

Aplikacija ne donosi nikakav unapred napravljen raspored: korisnik sam pravi **sve** — kategorije (bilo koji naziv
i boja, i da li se računaju u ispunjenost), šablone dana (bilo koji blokovi), koji šablon važi za koji dan u nedelji i
kada mu počinje dan. Nijedno ponašanje (server, klijent, statistika) ne zavisi od naziva kategorije ili šablona.

Nova baza (`server/defaults.ts`, upisuje se samo kad baza nema šemu, u istoj transakciji kao migracije):
- `categories`, `templates`, `template_blocks`, `days`, `blocks`, `tasks`: prazne;
- `weekday_templates`: redovi 1..7 sa `template_id = NULL` (nijedan dan nema šablon);
- `meta.settings`: `{ dayStart: 0, streakThreshold: 0.7 }` — dan podrazumevano počinje u **00:00**, prag niza 70%.
  Iste vrednosti se koriste i kad sačuvana podešavanja nedostaju ili nisu ispravna.

Postojeća baza se nikad ne prazni niti menja zbog ovoga: migracije samo menjaju šemu, a podaci (i oni iz ranije
verzije koja je novu bazu punila primerom rasporeda) ostaju kakvi jesu. Takav raspored korisnik uklanja sam, jednom
potvrđenom akcijom "Raspored ispočetka" (sekcija 6.5, `POST /api/schedule/reset` u sekciji 5). Aplikacija ga nikad
ne prepoznaje niti briše sama.

Dok raspored ne postoji, sve radi nad praznim podacima: dan bez šablona je dan bez blokova (pregled je prazan,
`ensure=1` i `init` upisuju prazan dan), blok i zadatak mogu biti bez kategorije (blok bez kategorije se računa u
ispunjenost), statistika, dnevnik, izvoz i uvoz rade i bez ijedne kategorije i šablona. Kopija bez redova
`weekday_templates` se uvozi kao "nijedan dan nema šablon".

---

## 5. API

Svi odgovori su JSON. Greške: `{ "error": "Poruka na srpskom" }` sa odgovarajućim statusom (400 validacija,
401 nije prijavljen, 403 CSRF, 404 ne postoji, 409 konflikt, 413 prevelik zahtev, 429 previše pokušaja).
Tipovi su u `shared/types.ts`; klijent je `web/src/api.ts` (izvor istine za putanje i oblike).

### Auth
- Env `APP_PASSWORD`. Ako je prazan → auth isključen (`authRequired: false`), loguj upozorenje. Bez lozinke server se
  **ne pokreće** (poruka + izlaz 1) kad bi slušao na adresi koja nije lokalna (`HOST` ≠ 127.x/::1/localhost, npr. Docker
  `HOST=0.0.0.0` bez `APP_PASSWORD` na Railway-u), osim uz `ALLOW_NO_AUTH=1`.
- `GET /api/auth/me` → `AuthState`. (bez auth)
- `POST /api/auth/login { password }` → `AuthState` + kolačić. Poređenje `crypto.timingSafeEqual` nad SHA-256 heševima.
  Ograničenje: 10 neuspelih pokušaja po IP (IPv6: po mreži /64) u 15 min → 429 "Previše pokušaja. Pokušaj ponovo za N minuta."
  (N = stvarno preostalo vreme, "1 minut" / "N minuta") i header `Retry-After` (sekunde); važi i za tačnu lozinku
  (plus 300 ukupno za sve klijente). Adresa je adresa konekcije; `X-Forwarded-For` se koristi samo uz env
  `TRUST_PROXY=n` (broj proxy-ja ispred aplikacije: klijent je n-ti unos od kraja; Caddy = 1; kraći lanac → adresa
  konekcije) ili kad konekcija dolazi sa iste mašine (127.0.0.0/8, ::1; poslednji unos).
  Pogrešna lozinka → 401 "Pogrešna lozinka." i log `Ritam: pogrešna lozinka (adresa …)` (provera TRUST_PROXY, README).
- `POST /api/auth/logout` → briše kolačić, vraća `AuthState`.
- Kolačić `ritam_session`: `v1.<issuedAtMs>.<base64url HMAC-SHA256(secret, 'v1.'+issuedAtMs)>`;
  `secret = HMAC-SHA256(key, 'ritam:' + APP_PASSWORD)`, `key` = `SESSION_SECRET` ili, ako nije postavljen, 32 nasumična
  bajta iz `DATA_DIR/session.key` (pravi se pri prvom pokretanju, mode 600) — ukraden kolačić tako ne omogućava
  pogađanje lozinke van servera. Promena lozinke, SESSION_SECRET ili brisanje `session.key` poništava sve sesije.
  HttpOnly, SameSite=Lax, Path=/, Max-Age 400 dana, `Secure` kad je zahtev HTTPS
  (`x-forwarded-proto === 'https'` ili URL https). Važi 400 dana od izdavanja; važeća sesija starija od 30 dana se
  obnavlja (novi kolačić) pri bilo kom zahtevu koji je proverava (i `/api/auth/me`), pa uređaj koji se koristi ostaje prijavljen.
- Sve ostale `/api/*` rute (osim `/api/health` i `/api/auth/*`) traže važeći kolačić kad je auth uključen → 401 `{error:'Nisi prijavljen.'}`.
- CSRF: svaki ne-GET/HEAD zahtev na `/api/*` mora imati header `X-Ritam: 1` → inače 403. (Klijent ga uvek šalje.)

### Zdravlje
- `GET /api/health` → `HealthPayload` `{ ok: true, build? }` (bez auth). `build` = `src` glavnog JS fajla iz
  `STATIC_DIR/index.html` (prvi `<script type="module" … src="/assets/…">`, npr. `"/assets/index-abc123.js"`), pročitan
  **jednom pri pokretanju** (novi deploy = novi proces); nema ga kad server ne servira build (razvoj preko Vite-a).
  Klijent (`lib/pwa.ts`) ga poredi sa `src` svog `<script type="module">` i posle deploy-a učita stranicu ponovo.

### Dan
- `GET /api/days/:date?ensure=1` → `DayPayload`
- `POST /api/days/:date/init { reset?, templateId? }` → `DayPayload`
- `PATCH /api/days/:date { note?: string (≤ 20000), baseNote?: string, rating?: 1..5 | null }` → `DayPayload`
  - `baseNote` (uz `note`) = beleška sa servera na koju se izmena oslanja. Ako je sačuvana beleška (`''` kad nema reda)
    različita i od `baseNote` i od novog `note` → 409 "Beleška je u međuvremenu promenjena na drugom uređaju." i ništa se
    ne upisuje (ni ocena). Isti tekst kao novi `note` je uspeh, pa je ponovljeno slanje bezbedno. Bez `baseNote` upis je
    bezuslovan; `baseNote` bez `note` se ignoriše. `baseNote` nema ograničenje dužine (samo se poredi; telo je do 1 MB).
- `POST /api/days/:date/blocks BlockInput` → `DayPayload` (inicijalizuje dan ako treba, pa doda blok)
- `PATCH /api/blocks/:id BlockPatch` → `DayPayload`
  - `status` promena: ako nova vrednost nije `done`/`partial`, postavi `actual_min = null` osim ako je `actualMin` eksplicitno poslat.
  - promena `start`/`end` mora dati validan opseg (proveri sa postojećom drugom vrednošću).
- `DELETE /api/blocks/:id` → `DayPayload`
- `POST /api/blocks/:id/split { at }` → `DayPayload`; `start < at < end`, oba dela ≥ 5 min i validan opseg (`at < 2880`). Prvi deo zadržava id/status/actual_min/note
  (actual_min = null ako bi bio veći od novog trajanja), drugi deo: isti naslov i kategorija, `pending`, prazna beleška.
- `POST /api/blocks/:id/swap { with: number }` → `DayPayload` tog dana. Dve aktivnosti menjaju termine (bilo koja dva
  bloka istog dana): u jednoj transakciji zameni **samo** `title` i `category_id` dva bloka; vreme, status, `actual_min` i beleška ostaju
  u svom terminu. Isti id → 400 "Blok ne može da se zameni sam sa sobom."; bilo koji od dva bloka ne postoji → 404;
  različiti datumi → 400 "Možeš da zameniš samo blokove istog dana."; `with` mora biti pozitivan ceo broj (pregled → 400).
- `DayPayload.openBefore` = broj zadataka `done = 0 AND date < :date`.
- `DayPayload.templateId/templateName`: za inicijalizovan dan `days.template_id`; za pregled šablon iz dana u nedelji.
- Blokovi sortirani po `start, end, id`. Zadaci: nezavršeni po `sort, id`, pa završeni po `done_at, id`.

### Zadaci
- `POST /api/tasks { date, title (1..300, trim), categoryId? }` → `DayPayload` za `date`. `sort = max(sort)+1` za taj datum.
- `PATCH /api/tasks/:id TaskPatch` → `DayPayload` za **stari** datum zadatka. `done: true` postavlja `done_at = now ISO`,
  `done: false` briše `done_at`. Promena `date` (premeštanje) stavlja zadatak na kraj liste ciljnog dana.
- `DELETE /api/tasks/:id` → `DayPayload` za datum zadatka.
- `POST /api/tasks/carry { to }` → svi nezavršeni sa `date < to` dobijaju `date = to` (zadržavaju redosled: po date, sort, id,
  dodaju se na kraj). Vraća `DayPayload` za `to`.
- `GET /api/tasks/done?from&to` → `Task[]` završeni zadaci sa datumom u opsegu, po `date DESC, done_at DESC`.

### Statistika i dnevnik
- `GET /api/stats?from&to&today?` → `StatsPayload`. Max opseg 400 dana. Svaki datum u opsegu je u `days`.
  `summary = summarizeBlocks(blocks, categories)` (iz `shared/summary.ts`) samo za **praćene** dane: inicijalizovan dan
  sa bar jednim blokom čiji status nije `pending`. Samo otvoren dan (svi blokovi `pending`) ima `summary: null` i ne ulazi
  u `daysTracked`, `avgScore` ni zbir po kategorijama.
  `streak = computeStreak(...)` preko CELE istorije do `to` (ne samo opsega), prag `settings.streakThreshold`.
  `today` (opciono, logičko danas klijenta): ako je `to < today`, period je završen i dan `to` prekida niz kao svaki drugi;
  bez `today` (ili `to >= today`) dan `to` još traje i ne prekida niz dok ne dostigne prag.
- `GET /api/journal?before&q&limit` → `JournalEntry[]`: dani sa nepraznom (trim) beleškom, `date < before` ako je zadat,
  `q` filtrira (case-insensitive, i za č ć š ž đ — filtriraj u JS sa `toLocaleLowerCase('sr')` ako treba), po `date DESC`,
  `limit` podrazumevano 20, max 100. `score` iz blokova ako je dan praćen (kao u statistici), inače `null`.

### Raspored
- `GET /api/schedule` → `SchedulePayload`: `categories` = kategorije za izbor (bez obrisanih), `archivedCategories` =
  obrisane kategorije koje sačuvani blokovi/zadaci i dalje imaju (naziv, boja, `counts` za prikaz i računanje ranijih dana).
- `POST /api/categories CategoryInput` / `PATCH /api/categories/:id` / `DELETE /api/categories/:id` → `SchedulePayload`
  (naziv 1..40, boja `#rrggbb`). Naziv je jedinstven među neobrisanim kategorijama (poređenje bez razlike velikih slova
  i razmaka na krajevima) → inače 409 "Kategorija sa tim nazivom već postoji."; PATCH proverava samo kad se naziv menja.
  **Brisanje = arhiviranje** (`archived = 1`): kategorija nestaje iz izbora, `template_blocks` dobijaju `category_id = NULL`
  (budući dani je ne dobijaju), a sačuvani blokovi i zadaci je zadržavaju — ispunjenost ranijih dana i niz se ne menjaju
  (blok bez kategorije bi se računao, pa bi brisanje kategorije koja se ne računa spustilo stare dane). Obrisana kategorija:
  PATCH/DELETE → 404; novi blok/zadatak ili promena kategorije na nju → 400 "Kategorija ne postoji." (izmena bloka/zadatka
  koji je već ima je u redu). Statistika i dnevnik računaju sa svim kategorijama.
- `POST /api/templates { name (1..60), copyFrom? }` / `PATCH /api/templates/:id { name?, sort? }` /
  `DELETE /api/templates/:id` → `SchedulePayload`. Naziv šablona je jedinstven (isto poređenje) → inače 409
  "Šablon sa tim nazivom već postoji." (i za kopiju — klijent bira slobodan naziv).
- `PUT /api/templates/:id/blocks { blocks: BlockInput[] }` (max 100, svaki validan opseg, naslov 1..120) → `SchedulePayload`.
  Zamenjuje sve blokove šablona. Blok ceo van logičkog dana prelazi na drugi kraj dana (pravilo iz sekcije 3).
- `PUT /api/weekdays WeekdayMap` (ključevi "1".."7", vrednost id postojećeg šablona ili null) → `SchedulePayload`
- `PATCH /api/settings { dayStart? (0..360, ceo broj), streakThreshold? (0.1..1) }` → `SchedulePayload`
- `POST /api/schedule/reset { dayStart?: boolean }` (`ScheduleResetInput`) → `SchedulePayload` — "Raspored ispočetka".
  U jednoj transakciji briše sve šablone (`template_blocks` kaskadno; `weekday_templates.template_id` i
  `days.template_id` postaju NULL preko stranih ključeva, pa sačuvan dan gubi samo oznaku šablona) i briše sve
  kategorije kao pojedinačno brisanje (`archived = 1`: sačuvani blokovi i zadaci ih zadržavaju kroz
  `archivedCategories`, pa se ispunjenost ranijih dana, zbir po kategorijama i niz ne menjaju). Sa `dayStart: true`
  i `settings.dayStart = 0` (prag niza ostaje; šablona više nema, pa nema ni blokova za premeštanje). Dani, blokovi,
  zadaci, beleške i ocene se ne diraju. Ponovljen poziv ništa ne menja (osim `dayStart`).

### Rezervna kopija
- `GET /api/export` → `{ app: 'ritam', version: 1, exportedAt, settings, categories, templates, template_blocks,
  weekday_templates, days, blocks, tasks }` (sirovi redovi, snake_case kolone) uz
  `Content-Disposition: attachment; filename="ritam-backup-YYYY-MM-DD.json"`.
- `POST /api/import` (isti oblik) → u jednoj transakciji obriše sve i upiše redove; validiraj oblik (i `isValidRange` za
  `blocks`/`template_blocks`); max 20 MB → `{ ok: true }`. Ista ograničenja kao API (uvezen red mora moći da se izmeni):
  naslov bloka/bloka šablona 1..120 (trim), zadatak 1..300, kategorija 1..40, šablon 1..60, beleška dana ≤ 20000,
  beleška bloka ≤ 5000, `actual_min` 0..1440 ili null. `categories.archived` (0/1) je u kopiji; kopija bez te kolone
  (starija verzija) se uvozi sa 0. Blokovi šablona sa obrisanom kategorijom dobijaju `category_id = NULL`.

### Statika
- `dist/web` (ili `STATIC_DIR`): `/assets/*` sa `Cache-Control: public, max-age=31536000, immutable`;
  `index.html`, `sw.js`, `manifest.webmanifest` sa `Cache-Control: no-cache`.
- SPA fallback: svaki GET koji nije `/api/*` i nije postojeći fajl → `index.html`.
- Bezbednosni headeri na svim odgovorima: `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`,
  `X-Frame-Options: DENY`, CSP: `default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline';
  script-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`.
  Preko HTTPS-a (isto pravilo kao `Secure` kolačić) i `Strict-Transport-Security: max-age=31536000`.
- Env: `PORT` (3000), `HOST` (0.0.0.0; 127.0.0.1 kad je `APP_PASSWORD` prazan, da server bez prijave nije otvoren
  celoj mreži — Docker postavlja `HOST=0.0.0.0`, pa se bez `APP_PASSWORD` ne pokreće), `DATA_DIR` (`./data`, baza je
  `DATA_DIR/ritam.db`, ključ sesije `DATA_DIR/session.key`), `APP_PASSWORD`, `SESSION_SECRET` (opciono), `STATIC_DIR`
  (`dist/web`), `TRUST_PROXY` (broj reverse proxy-ja ispred aplikacije, `1` iza Caddy-ja; neispravna vrednost → izlaz 1),
  `ALLOW_NO_AUTH` (`1` = dozvoli rad bez lozinke i na mrežnoj adresi).
- Docker slika nema `VOLUME` instrukciju (Railway je ne dozvoljava); volumen se kači na `/data` spolja.
- Uredno gašenje na SIGTERM/SIGINT (zatvori server i bazu).

---

## 6. Ekrani

Rute (`web/src/lib/router.tsx`): `/` danas · `/dan/YYYY-MM-DD` · `/napredak` · `/dnevnik` · `/raspored` · `/podesavanja`.
Navigacija: telefon (< 860px) — donja traka sa 4 taba (Danas, Napredak, Dnevnik, Raspored); desktop — leva bočna traka
(isti tabovi + Podešavanja dole). Podešavanja na telefonu: ikonica u zaglavlju stranice Raspored.
Logo "Ritam" (`ui/Wordmark.tsx`, script SVG putanja, boja teksta) je link na Danas: na vrhu bočne trake (desktop) i u
tankoj traci iznad stranice (`.shell-top`, samo telefon). Ispod nje traka "Nema interneta / Server nije dostupan" kad treba.
Klik na tab/logo Danas dok je `/` već otvoren vraća na vrh i prikazuje logičko danas (i kad je prethodni dan zadržan).

**Rad bez servera (service worker, `public/sw.js`)**: GET `/api/*` mreža prvo; bez mreže, kad proksi javi 502–504 ili kad
mreža ne odgovori za ~4 s a kopija postoji (0,8 s ako je mreža upravo kasnila — dok zakasneli odgovor ipak ne stigne:
spora mreža koja radi ponovo dobija ceo rok), vraća se keširana kopija označena headerom
`X-Ritam-Cached: 1` (`/api/auth/*`, `/api/export` i `/api/health` se ne keširaju). Klijent (`api.ts` `isCachedPayload`) takvu kopiju
nikad ne primenjuje preko podataka koje već ima (dan, raspored); koristi je samo kad nema ničeg drugog. Odgovori izmena
(dan, raspored) se upisuju u isti keš (`ritam-api`, stalno ime, header `X-Ritam-Stored` = vreme upisa), da kopija za rad bez
mreže ne bude starija od izmena; kasan odgovor GET zahteva poslatog pre te izmene je ne prepisuje.
Traka "Server nije dostupan" se pali na keširan odgovor i gasi tek kad server stvarno odgovori (dok je upaljena, server se
proverava preko `/api/health` na 15 s, pri povratku u aplikaciju i fokusu prozora). Keš je samo pomoć: greška
keša (pun disk) nikad ne obara odgovor mreže; nova verzija SW-a se instalira tek kad '/' i njegovi JS/CSS stignu sa mreže.
Pri pokretanju se raspored učitava uporedo sa proverom prijave (`/api/auth/me` sa rokom od 4 s) i aplikacija se
prikazuje čim raspored stigne (401 u međuvremenu ostavlja prijavu na ekranu; raspored koji nije učitan nikad ne ostavlja
samo spinner, nego "Podaci nisu učitani." + "Pokušaj ponovo"). Dok je na ekranu dana kopija iz keša (ili poslednje
učitavanje dana nije dobilo odgovor servera), dan se tiho pokušava osvežiti na 15 s; čim server ponovo odgovori na bilo
koji zahtev (traka se gasi), dan se odmah osveži.
Raspored (izmene sa drugog uređaja) se tiho osvežava pri povratku u aplikaciju i fokusu prozora ako je stariji od 30 s, i na
minut dok je tab vidljiv a nijedan sheet nije otvoren; stanje se menja samo ako je server vratio nešto drugo. Provera nove
verzije aplikacije (`lib/pwa.ts`, najviše jednom u 10 min) ide pri povratku, fokusu i povremeno dok je tab vidljiv.

### 6.1 Dan (`DayPage`, glavni ekran)
- Zaglavlje: desktop "Utorak, 7. oktobar" (dan i mesec bez prelamanja), ispod oznaka "Danas" ili relativni dan + šablon.
  Telefon: naslov samo "7. oktobar" (jedan red pored dugmadi), a podnaslov preko cele širine u jednom redu:
  "Utorak · Danas · <naziv šablona>" / "Ponedeljak · pre 3 dana" + dugme "Danas". Strelice ‹ › za prethodni/sledeći dan,
  klik na naslov otvara izbor datuma (native `<input type="date">`), dugme "Danas" kad nije danas. Meni (⋯):
  "Primeni drugi šablon…" (onemogućeno dok nema nijednog šablona), "Vrati na šablon" (potvrda — briše statuse), "Dodaj blok".
  Izbor šablona (i "Prazan dan") zamenjuje sve blokove dana, pa pita (opasna potvrda) uvek osim kad dan nema ništa svoje:
  pregled, dan bez blokova, ili neizmenjena kopija svog šablona (isti broj blokova, isto vreme/naslov/kategorija, svi
  `pending` bez beleške). Ručno dodat, pomeren ili preimenovan blok, i dan bez šablona sa blokovima, uvek pitaju: sa
  ocenama/beleškama "Postojeći blokovi ovog dana, njihovi statusi i beleške biće obrisani.", inače "Blokovi ovog dana
  (N blokova) biće zamenjeni blokovima iz šablona." / "…biće obrisani." (prazan dan).
- **Prvo pokretanje** (nijedan dan u nedelji nema šablon, a prikazani dan nema blokova): iznad prazne vremenske linije
  mirna kartica (`WelcomeCard`, bez logotipa, ilustracija i primera): naslov "Napravi svoj raspored", jedna rečenica
  ("Opiši jednom kako izgleda tvoj dan, a Ritam će ga sam postaviti za svaki dan.") i tri numerisana koraka —
  "Kategorije: stvari koje radiš i njihove boje", "Šablon: plan dana sa blokovima i vremenima", "Dani u nedelji: koji
  šablon važi kog dana" (prvi korak dobija ✓ čim postoji kategorija, drugi čim postoji šablon). Primarno dugme "Podesi
  raspored" (→ `/raspored`), sporedno "Dodaj blok samo za danas" (na drugom danu "…samo za ovaj dan") otvara sheet novog
  bloka. Kartica nestaje čim bar jedan dan u nedelji ima šablon (ili čim taj dan dobije blok) — šablon koji još nije
  dodeljen nijednom danu ne popunjava nijedan dan, pa treći korak ostaje vidljiv. Nema "učitaj primer" ni unapred
  zadatih kategorija/šablona.
- Danas se pri otvaranju upisuje iz šablona (`ensure=1`) samo kad za taj dan u nedelji postoji šablon (ili kad server u
  pregledu ipak vrati blokove — šablon dodeljen na drugom uređaju): dan otvoren pre nego što je raspored napravljen ostaje
  pregled bez blokova, pa šablon dodeljen kasnije istog dana odmah popuni i današnji dan.
- Upisan dan bez šablona (npr. blok dodat sa "Dodaj blok samo za danas" pre nego što je raspored napravljen), a za
  njegov dan u nedelji sada važi šablon: danas i budući dani u kartici Blokovi imaju traku "Za <dan u nedelji> važi
  šablon „X“, a ovaj dan je napravljen bez šablona." + dugme "Primeni" (isto pravilo potvrde kao izbor šablona).
  Raniji dani je nemaju (istorija).
- Desktop: dve kolone (levo vremenska linija ~1.35fr, desno Pregled + Zadaci + Beleške). Telefon: jedna kolona:
  "Sada" kartica → vremenska linija → Pregled → Zadaci → Beleške.
- **"Sada" kartica** (samo za danas, kad dan ima blokove): trenutni blok + koliko je ostalo ("još 1h 12m"), sledeći blok
  ("Sledeće: <naslov> u 19:00").
  Ako nema trenutnog bloka: "Slobodno vreme" + sledeći. Do 12:00 se gleda i juče (isti zahtev kao podsetnik "Juče: …"):
  jučerašnji blok koji traje i posle početka ovog dana (npr. 23:30–07:00 kad dan počinje u 00:00) je trenutni dok traje
  ("23:30–07:00 · <kategorija> · od juče"; današnji blok koji je počeo kasnije ima prednost). Tada kartica postoji i
  kad današnji dan nema blokova.
- **Vremenska linija**: red po bloku: vreme početka/kraja (tabular), traka u boji kategorije, naslov,
  "Kategorija · trajanje" (+ ikonica ako ima belešku), desno **kontrola statusa**: 3 dugmeta
  (✓ Urađeno = `done`, ◐ Delimično = `partial`, ✕ Nije = `skipped`); klik na aktivno vraća na `pending`.
  - Trenutni blok: istaknut (pozadina `--now-bg`, oznaka "sada" — na telefonu samo za čitače ekrana, tanka linija
    napretka kroz blok).
  - Prošli blokovi danas koji su još `pending` i čija se kategorija računa u ispunjenost: diskretno naglašeni
    ("čeka ocenu"; na telefonu u svom redu). Isto pravilo važi za "N blokova čeka ocenu" i "Juče: …" u kartici "Sada".
  - Praznine između blokova: tanak red "slobodno · 1h".
  - Klik na red → sheet za izmenu: naslov, kategorija (CategoryPicker), od/do (TimeInput; novi blok preko
    normalizeRange, postojeći ostaje na svom kraju dana — `normalizeNear` u `lib/timeRange.ts`: početak se bira bliže
    dosadašnjem, npr. blok 01:00–09:00 pomeren na 00:30 ostaje ujutru (dan počinje u 01:00), ali samo ako se blok i dalje
    preklapa sa logičkim danom `[dayStart, dayStart + 1440)`; inače važi normalizeRange, pa isto vreme uvek završi na
    istom mestu (dan počinje u 00:00: 23:30–07:00 promenjen na 00:30–09:00 postaje 30–540, ne 1470–1980 ceo u sledećem
    danu). Ako se početak postojećeg bloka pomeri za 12h+ — npr. 01:00 → 23:30 postaje 23:30–09:00 sutra — upozorenje
    "Blok prelazi na kraj ovog dana (…). Vreme pre <dan počinje u> pripada prethodnom danu."; obrnuto "Blok prelazi na
    početak ovog dana (…): dan počinje u <vreme>. Za blok posle ponoći na kraju dana pomeri „Dan počinje u“ (Podešavanja)."),
    status, "stvarno vreme" u minutima (za done/partial, opciono, najviše trajanje bloka: "Najviše N min (trajanje
    bloka)."), beleška za blok, akcije u podnožju: "Obriši",
    "Podeli" (izbor vremena; `at < 2880`, inače "Neispravno mesto deljenja."), "Zameni sa…", "Sačuvaj".
    Forma se poredi sa blokom kakav je bio pri otvaranju: ako osvežavanje u pozadini donese izmenu sa drugog uređaja,
    piše "Blok je u međuvremenu promenjen na drugom uređaju…", a čuvanje (i deljenje/zamena) šalje samo polja koja je
    korisnik stvarno menjao. Ako svež odgovor servera više nema taj blok: "Blok je u međuvremenu obrisan na drugom
    uređaju.", akcije su onemogućene, a zatvaranje ne pita. Otvaranje bloka osveži dan ako poslednji odgovor nije
    skorašnji (> 15 s). "Otkaži" (novi blok) pita kao i X.
  - Naslov novog bloka ima placeholder "Naziv bloka". Kategorija se bira čipovima (`CategoryPicker`) sa čipom "+ Nova" na
    kraju: otvara malo polje u redu sa čipovima ("Naziv kategorije"; Enter/✓ pravi, Esc/✕ odustaje — Esc ne zatvara
    sheet, Enter ne šalje formu). Kategorija se pravi odmah (`api.addCategory`, boja = prva boja palete koju nijedna
    kategorija ne koristi, računa se u ispunjenost), raspored se upiše (`scheduleStore.set`), nova kategorija je izabrana
    i toast kaže "Kategorija je dodata i računa se u ispunjenost (menja se u Rasporedu).". Kategorija sa istim nazivom koja
    već postoji se samo izabere ("Kategorija sa tim nazivom već postoji — izabrana je ona."), i kad je server javi (409), a
    ovde je još nema (napravljena na drugom uređaju, ili je zahtev kome je istekao rok ipak uspeo): tada se raspored učita
    direktno (`api.schedule()`). Druga greška stoji ispod polja.
    Upisan, a nepotvrđen naziv (bez Enter/✓, npr. "Gotovo" na iOS tastaturi pa "Dodaj blok") se ne gubi: čuvanje (i
    Podeli/Zameni sa…) ga prvo napravi i koristi kao kategoriju bloka; ako to ne uspe, ništa se ne čuva i greška stoji
    ispod polja. Takav naziv je i nesačuvana izmena (X/Esc/"nazad" pitaju "Odbaci izmene?"). Napuštanje polja ne pravi
    kategoriju (to je i klik na ✕ ili Otkaži). Isto i u sheet-u zadatka.
  - Predlog vremena novog bloka (najviše 1h, nikad preko sledećeg bloka ni kraja dana): danas prva slobodna praznina
    (≥ 15 min) od sledećeg punog ili polovine sata, ne prošlo vreme; inače od kraja poslednjeg bloka koji se završava pre
    kraja dana (blok koji traje preko kraja dana, npr. noćni do jutra, se preskače); pa prva praznina od početka dana;
    prazan dan (osim danas) i pun dan: 09:00–10:00.
  - **"Zameni sa…"** (brza zamena dva bloka): izgleda kao dugme, a ispod je native `<select>` sa ostalim
    sačuvanim blokovima dana ("16:00–18:00 · <naslov>"). Izbor odmah zove `api.swapBlocks(id, withId)` (naslov i kategorija
    menjaju mesta, optimistički uz vraćanje pri grešci), zatvara sheet i pokazuje toast "Zamenjeno.". Nesačuvane izmene
    forme se prvo sačuvaju (kao kod deljenja). Strelice/slova na zatvorenom izboru otvaraju listu umesto da odmah zamene.
    Za blok iz pregleda (dan još nije upisan) se ne nudi.
  - "+ Dodaj blok" na kraju liste (kad dan ima blokove).
  - **Prazan dan** (nema blokova): u kartici Blokovi "Nema plana za ovaj dan." + "Dodaj blok" i, ako postoji bar jedan
    šablon, "Primeni šablon…" (otvara izbor šablona). Traka pregleda ("Plan iz šablona…", "Za ovaj dan u nedelji nema
    šablona…") se tada ne prikazuje, a ni kartica Pregled (nema šta da sabere).
  - Optimistička promena statusa (odmah u UI, pa zamena odgovorom servera; greška → vrati + toast).
  - Budući dan (pregled, negativni id): statusi onemogućeni, traka "Plan iz šablona „X“"; klik na blok otvara editor bez
    upisa (samo gledanje ne zamrzava dan — kasnije izmene šablona i dalje važe za njega). Dan se upisuje tek pri prvoj
    izmeni iz sheet-a (Sačuvaj/Podeli/Obriši): `api.initDay(date)`, pa izmena odgovarajućeg bloka (isto pravilo kao u
    sekciji 3; ako se plan u međuvremenu promenio, toast iz sekcije 3). "Dodaj blok" ne upisuje dan unapred — server ga
    inicijalizuje kad se blok stvarno doda. Raniji dan koji
    nije praćen: traka "Dan nije praćen. Plan iz šablona „X“ — oceni neki blok i dan počinje da se prati.", statusi su
    omogućeni (vidi sekciju 3).
  - Greška izmene: vraća se poslednje stanje koje je server potvrdio (ne samo stanje pre te izmene — i ranija neuspela
    optimistička izmena nestaje, i kad je posle nje krenulo osvežavanje koje server nije poslužio), pa se dan tiho ponovo
    učita. Odgovor izmene zadatka za drugi datum (zadatak je u
    međuvremenu premešten na drugom uređaju) takođe ponovo učita dan na ekranu.
  - Osvežavanje dana: povratak u aplikaciju, fokus prozora (> 30 s), `online`, i na minut dok je tab vidljiv a ništa nije u
    toku (laptop koji sve vreme stoji otvoren).
- **Pregled**: Ring sa `score` (%), "Urađeno 5 / 11 blokova" (samo `done`; delimični se vide u redu ✓ ◐ ✕ ispod);
  broj zadataka je samo u kartici Zadaci; po kategoriji (samo one koje se računaju, planirano > 0):
  tačka + naziv, traka napretka u boji kategorije, "2h 15m / 3h".
- **Zadaci**: polje "Dodaj zadatak" (Enter dodaje), lista sa checkbox-om, završeni precrtani na dnu, klik na zadatak →
  sheet (naslov, kategorija, premesti na datum, obriši). Sheet se, kao i sheet bloka, poredi sa zadatkom kakav je bio pri
  otvaranju i šalje samo izmenjena polja ("Zadatak je u međuvremenu promenjen na drugom uređaju…"); ako svež odgovor
  servera više nema zadatak (obrisan/premešten negde drugde), sheet se zatvara uz toast "Zadatak je u međuvremenu
  promenjen ili obrisan na drugom uređaju.". Ako je danas i `openBefore > 0`: traka
  "Imaš N nezavršenih zadataka od ranije" + dugme "Prebaci u danas".
- **Beleške i misli**: TextArea, autosave (debounce ~700ms) uz indikator "Čuva se…/Sačuvano"; flush pri promeni dana i
  napuštanju (`visibilitychange`/`pagehide`). Lokalni draft se NE prepisuje odgovorom servera dok korisnik kuca.
  Nesačuvan draft se čuva i u `localStorage` (`ritam.note.<datum>`, `{ base, text }`; posle uspelog čuvanja dok se kucalo
  dalje, `base` postaje upravo sačuvan tekst) dok server ne potvrdi isti tekst;
  neuspelo čuvanje se ponavlja pri napuštanju, povratku u aplikaciju, `online` i kad server ponovo odgovori (svež odgovor
  za dan) ("Pokušaj ponovo" ne šalje isti tekst dvaput; ako se čeka svež odgovor servera, odmah ga traži). Čuvanje koje
  čeka svež odgovor (polje popunjeno iz keša) samo zatraži osvežavanje dana. Pri otvaranju dana draft se vraća ako je
  server i dalje na `base` — odlučuje se tek po svežem odgovoru servera,
  nikad po kopiji iz keša; inače se nudi "Vrati je / Odbaci".
  Svako čuvanje šalje `baseNote` = belešku sa servera nad kojom je tekst pisan (čita se kad zahtev krene iz reda). Ako je
  beleška u međuvremenu promenjena na drugom uređaju (409, ili osvežavanje pokaže treći tekst dok postoje nesačuvane
  izmene), ništa se ne šalje: tekst ostaje u polju i u `localStorage`, a traka "Beleška je u međuvremenu promenjena na
  drugom uređaju." nudi "Sačuvaj ovu" (prepiše tu verziju) / "Uzmi tu verziju" (odbaci lokalni tekst). Ako svež odgovor
  pokaže naš ranije poslat tekst (čuvanje kome je istekao rok ipak je stiglo, pa je sledeće dobilo 409), to nije sukob:
  traka se ne prikazuje (ili nestaje), a ostatak teksta se šalje nad tim tekstom. Fokus u polju
  osveži dan ako poslednji odgovor nije skorašnji.
  Draftovi drugih dana (čuvanje nije uspelo pa se prešlo na drugi dan / aplikacija zatvorena) šalju se sami pri otvaranju
  stranice, povratku u aplikaciju, `online` i kad server ponovo odgovori, ako je server i dalje na `base`; inače kartica pokazuje
  "Nesačuvana beleška za <datum>" sa linkom na taj dan.
  Ispod: "Kakav je bio dan?" + RatingInput.
- Prečice na desktopu: ← / → prethodni/sledeći dan, `t` danas (ne kad je fokus u polju za unos).
- Telefon: brzo prevlačenje levo/desno = sledeći/prethodni dan (`useSwipeNav`); ne dok je otvoren sheet ili potvrda,
  ne iz polja za unos ili menija ⋯ i ne od same ivice ekrana (to je sistemski gest "nazad").
- Kad je ruta `/` i logički datum se promeni (ponoć/dayStart), automatski prikaži novi dan — kad ništa nije otvoreno
  (sheet bloka/zadatka/šablona); do tada ostaje prethodni dan ("Dan je završen"). Kucanje beleške zadržava prethodni dan
  samo ako je fokus u polju beleške, u njemu se kucalo u poslednja 2 min i od granice dana ("dan počinje u") nije prošlo
  10 min — meri se od same granice, pa telefon/laptop probuđen ujutru uvek otvara novi dan.
- Linkovi na današnji dan (Napredak, Dnevnik) vode na `/`, ne na `/dan/<danas>`.
- "Sada" kartica do 12:00 podseća na neocenjene blokove od juče ("Juče: N blokova čeka ocenu", bez inicijalizacije juče;
  samo blokovi koji su se već završili); broj se osvežava uz svako osvežavanje dana. Kad današnji dan nema blokova (npr.
  dan u nedelji bez šablona), umesto kartice "Sada" stoji mala kartica samo sa tim podsetnikom.

### 6.2 Napredak (`ProgressPage`)
- Prekidač Nedelja / Mesec (Segmented), strelice za prethodni/sledeći period, naslov perioda
  ("6–12. okt" / "Oktobar 2026."). Nedelja počinje ponedeljkom. Podrazumevano: tekuća nedelja.
- Statistika se uvek traži sa logičkim danas: `api.stats(from, to, today)` (završen period nema "grace" za poslednji dan niza).
- KPI red (4 pločice): Prosečna ispunjenost (%), Niz dana (streak, "dana"), Zadaci (urađeno / ukupno),
  Prosečna ocena dana (ili "—").
- **Danas u toku**: dok je današnji score ispod praga za niz, danas ne ulazi u prosek ispunjenosti (računa se na klijentu
  iz `days`, isto kao `avgScore`, bez tog dana; ako je samo danas praćen: "—" / "danas je u toku"), a njegov stub/ćelija je
  neutralan "u toku" (samo obris, bez boje ocene; tooltip "… · u toku"; legenda dobija stavku "u toku"). Kad dostigne prag,
  prikazuje se normalno.
- Nedelja: stubičasti grafik ispunjenosti po danu (7 stubova, oznake pon…ned, vrednost iznad); Mesec: kalendar-heatmap
  (ćelija = dan, intenzitet po score-u u 5 nivoa — koraci po temi u tokenima `--heat-0…3`; procenat u ćeliji i na
  telefonu; neinicijalizovani prazni; danas "u toku" ima samo obris, bez drugog prstena; klik → `/dan/:date`).
- Povratak sa stranice dana ("nazad") odmah prikazuje isti period i iste podatke (poslednji podaci ostaju u memoriji,
  pa se vraća i položaj skrolovanja), a sadržaj se tiho osveži.
- Po kategoriji: tabela/lista — naziv, planirano, urađeno, %, i broj blokova (npr. "3 / 4 puta"). Obrisana kategorija
  (i svuda drugde gde je prikazuju sačuvani dani i zadaci) ima oznaku "<naziv> (obrisana)" — nova kategorija može imati
  isti naziv.
- Prazno stanje (nema praćenih dana ni zadataka u periodu): "Još nema praćenih dana u ovom periodu." + "Oceni blokove na
  stranici Danas i napredak će se pojaviti ovde."; nova instalacija (nema nijednog šablona ni praćenog dana u poslednjih
  12 nedelja): "Još nema praćenih dana." + "Napravi raspored, pa oceni blokove na stranici Danas — napredak će se pojaviti
  ovde." i link "Podesi raspored". Ko radi bez šablona (blokovi po danu) i ima praćene dane dobija tekst za period.
- Završeni zadaci u periodu, grupisani po danu (`api.doneTasks`).
- Poslednjih 12 nedelja: kompaktna heatmapa (kolone = nedelje, redovi = pon…ned).
- Grafici ručno u SVG/HTML, bez biblioteka; boje statusa/teme iz tokena; tooltip preko `title`.

### 6.3 Dnevnik (`JournalPage`)
- Pretraga (debounce), lista unosa: datum (`fmtDateLong`, godina ako nije tekuća) kao link na dan, RatingDots, ispunjenost %,
  tekst beleške sa očuvanim novim redovima (skraćen na ~6 redova sa "Prikaži više"). "Učitaj još" preko `before`.
  Prazno stanje: "Još nema beležaka. Piši ih na stranici Danas."

### 6.4 Raspored (`SchedulePage`)
- Ništa ne zavisi od naziva kategorije ili šablona; nema podrazumevanih kategorija ni šablona.
- Redosled kartica: dok nema nijednog šablona (prvo podešavanje) — Kategorije, Šabloni, pa Dani u nedelji (isto kao
  koraci na stranici Danas; desktop: kategorije i šabloni levo, dani desno); posle toga Dani u nedelji i Planirano
  nedeljno levo, Šabloni i Kategorije desno. Šablon otvoren u editoru drži stranica (kartica menja mesto baš kad
  nastane prvi šablon, a editor se tada otvara).
- **Dani u nedelji**: 7 redova (Ponedeljak…Nedelja) sa Select-om šablona (ili "Bez šablona") → `api.putWeekdays` sa samo
  promenjenim danom (ostali dani ostaju kako su na serveru; zahtevi idu jedan za drugim). Bez ijednog šablona redovi su
  onemogućeni, a iznad piše "Prvo napravi šablon.".
- **Planirano nedeljno** (samo kad je nešto planirano — bar jedan dan ima šablon sa blokovima): ukupno za kategorije
  koje se računaju u ispunjenost ("računa se u ispunjenost"; blok bez kategorije se računa) i za one koje se ne računaju
  ("ne računa se", "—" kad ih nema), pa red po kategoriji: naziv, zbir za nedelju, "≈ X dnevno" (prosek po danu sa
  šablonom) i traka. Ništa nije vezano za naziv kategorije.
- **Šabloni**: kartica po šablonu — naziv, mini 24h traka (blokovi obojeni po kategoriji, od dayStart do dayStart+24h),
  broj blokova i dani u nedelji koji ga koriste. Klik → editor (sheet `lg` ili cela sekcija): naziv, lista blokova
  (od, do, naslov, kategorija, obriši), "+ Dodaj blok", Sačuvaj (`api.putTemplateBlocks` + `api.patchTemplate` za naziv,
  samo ako je naziv ovde promenjen), "Dupliraj", "Obriši" (potvrda). "+ Novi šablon" ("Kopiraj iz": hint "Šablon počinje
  bez blokova." / "Novi šablon dobija iste blokove kao izabrani."; placeholder naziva "Naziv šablona").
  Vreme reda: novi red preko normalizeRange, postojeći preko `normalizeNear` (isto pravilo kao sheet bloka u 6.1 — blok
  nikad ne završi van logičkog dana, gde bi bio skriven na traci i pomeren pri promeni "Dan počinje u"); kad izmena
  prebaci blok na suprotni kraj dana, ispod reda stoji isto upozorenje kao u sheet-u bloka. Red koji traje posle ponoći
  ima diskretnu napomenu "Preko ponoći, do 07:00 sutra." / "Posle ponoći, na kraju ovog dana.".
  Kolona kategorije je šira (telefon do 45% reda, desktop 9–14rem), a izbor ima `title` sa celim nazivom.
  Izbor kategorije u redu editora ima poslednju stavku "+ Nova kategorija…": otvara mali sheet (`sm`, naziv, boja i
  prekidač "Računa se u ispunjenost dana") pored editora (ne u njemu, da Esc i klikovi ne stignu do editora); napravljena
  kategorija se izabere u tom redu, a izbor do tada ostaje na dosadašnjoj vrednosti. Strelice i Home/End na zatvorenom
  izboru otvaraju listu (`ui/selectKeys.ts`, isto kao "Zameni sa…"), pa sheet otvara samo stvaran izbor te stavke.
  Kategorija sa istim nazivom koja već postoji se u malom sheet-u samo izabere ("Kategorija sa tim nazivom već postoji —
  izabrana je ona."); u običnom sheet-u kategorije naziv koji već postoji (409) je greška ispod polja Naziv.
  Bez ijednog šablona kartica pokazuje samo "Šablon je plan dana koji se ponavlja." + "Novi šablon".
  Čuvanje zamenjuje ceo šablon, pa se pre slanja (`api.schedule()`) proverava da ga drugi uređaj u međuvremenu nije
  promenio (naziv i blokovi, bez obzira na redosled): ako jeste, ništa se ne šalje, u podnožju piše "Šablon je u
  međuvremenu promenjen na drugom uređaju. Sačuvaj ponovo da ga zameniš ovom verzijom, ili zatvori bez čuvanja.", a ta
  verzija postaje osnova. Editor u kom ništa nije menjano prikazuje novu verziju čim raspored stigne; šablon obrisan
  negde drugde ostaje u editoru dok se ne zatvori (čuvanje javlja grešku servera).
- **Kategorije**: lista (boja, naziv, prekidač "Računa se u ispunjenost"), izmena u sheet-u (naziv, boja iz palete od
  ~10 prigušenih boja, `lib/palette.ts`, nova kategorija dobija prvu boju koju nijedna ne koristi — boje obrisanih
  kategorija tek kad nema potpuno slobodne; prekidač; čuvanje šalje samo izmenjena polja; placeholder "Naziv
  kategorije"), "+ Nova kategorija", brisanje uz potvrdu. Bez ijedne kategorije: "Kategorija daje boju bloku i sabira
  vreme u Napretku." + "Nova kategorija".
  Ispod prekidača: "Isključi za ono što ne želiš da ocenjuješ. Važi i za ranije dane: procenat i niz se preračunavaju."
  Uključivanje postojeće kategorije prvo pita ("Uključi u ispunjenost?" — raniji dani sa neocenjenim blokovima te
  kategorije dobiće niži procenat, a niz može da se prekine).
  Potvrda brisanja: "Kategorija nestaje iz izbora. … Sačuvani dani je zadržavaju, pa se njihova ispunjenost ne menja.";
  ako je koriste blokovi šablona: "Blokovi u šablonima sa njom (N blokova) ostaju bez kategorije." — a za kategoriju
  koja se ne računa i "…i od sada se računaju u ispunjenost budućih dana. Ako to ne želiš, prvo im promeni kategoriju."
  Otvaranje editora šablona ili sheet-a kategorije tiho osveži raspored (ako je stariji od 5 s).
- Zaglavlje: ikonica Podešavanja (link na `/podesavanja`) — samo na telefonu (na desktopu su u bočnoj traci).

### 6.5 Podešavanja (`SettingsPage`)
- Tema: Tamna / Svetla / Sistem. **Podrazumevano tamna (crna)**: `index.html` ima `data-theme="dark"`, a
  `lib/theme.ts` pre prvog rendera primeni izbor iz `localStorage 'ritam.theme'` (tamna se ne čuva — to je podrazumevano;
  "Sistem" uklanja `data-theme`). Menja i `<meta name="theme-color">`.
- "Dan počinje u" (TimeInput, 00:00–06:00, podrazumevano 00:00) → `api.patchSettings({ dayStart })`; objašnjenje: "Sve
  između ponoći i ovog vremena računa se u prethodni dan — korisno ako ležeš posle ponoći."
- "Prag za niz dana" (Segmented 50/60/70/80/90%).
- Instalacija: dugme "Instaliraj aplikaciju" ako je dostupan `beforeinstallprompt`; inače uputstvo za iPhone
  (Safari → Podeli → Dodaj na početni ekran) i Android (Chrome meni → Instaliraj aplikaciju).
- Rezervna kopija: "Preuzmi kopiju (JSON)" i "Vrati iz kopije…" (input file, potvrda, `api.importData`, pa reload).
- "Raspored ispočetka" (kartica posle Rezervne kopije): objašnjenje da se brišu sve kategorije, šabloni i dodela
  šablona danima u nedelji (da raspored napraviš od nule — npr. primer koji je ranija verzija upisala u novu bazu),
  a sačuvani dani, zadaci i beleške ostaju i napredak ranijih dana se ne menja. Kad "Dan počinje u" nije 00:00,
  prekidač "Vrati i početak dana na 00:00" (uključen). Dugme "Obriši raspored…" → `confirmDialog({ danger: true, … })` sa istim
  objašnjenjem → `api.resetSchedule({ dayStart })` (`POST /api/schedule/reset`) → `scheduleStore.set(payload)` +
  toast. Ništa se ne briše bez ove potvrde. Kad nema ničeg za brisanje (nijedna kategorija, šablon ni dodela — npr.
  nova instalacija), kartica se ne prikazuje (sam "Dan počinje u" se menja u kartici Dan).
- "Odjavi se" (ako je auth uključen): briše keš API odgovora i lokalne nesačuvane beleške (`ritam.note.*`); ako ih
  ima, prvo potvrda "Imaš nesačuvanu belešku" sa datumima. Istekla sesija (401) ih ne briše — šalju se posle ponovne prijave.
- Kartica sa jednim redom (Izgled, Instalacija, Nalog) nema naziv reda, samo objašnjenje i kontrolu (naslov kartice je naziv).
- Verzija aplikacije.

### 6.6 Prijava (`LoginPage`)
- Centrirano: logo "Ritam" (Wordmark u `<h1>`), polje za lozinku (autoFocus, `autocomplete="current-password"`), dugme "Uđi",
  poruka greške.

---

## 7. Dizajn (obavezno)

Cilj: čisto, mirno, kao dobro napravljen alat — **ne "AI generisan" izgled**.
- Koristi tokene iz `styles/tokens.css` (nikad hardkodovane boje osim boja kategorija iz podataka).
- Zabranjeno: gradijenti, glassmorphism/blur, emodžiji, ikone-u-krugu dekoracije, šareni hero naslovi,
  marketinški tekst, senke na karticama (senka samo na sheet/toast), preterano zaobljeni uglovi (max 12px), UPPERCASE svuda.
- Hijerarhija tipografijom i razmakom, ne bojom. Brojevi i vremena `font-variant-numeric: tabular-nums`.
- Boja kategorije: tanka vertikalna traka (3px) ili tačka 8px; svetla pozadina kategorije samo kroz
  `color-mix(in srgb, <boja> 10–14%, var(--surface))`.
- Status: done = `--done`, partial = `--partial`, skipped = `--skipped`; ikona uvek uz boju (ne samo boja).
- Dodirne površine ≥ 40px na telefonu. Inputi `font-size: 16px` (iOS zoom). Poštuj `env(safe-area-inset-*)`.
- Animacije kratke (120–220ms), poštuj `prefers-reduced-motion`.
- CSS klase po stranici sa prefiksom: `day-`, `prog-`, `sched-`, `jr-`, `set-`, `shell-`/`login-`. CSS fajl po stranici,
  importovan iz te stranice. Zajedničke klase već postoje: `.page`, `.card`, `.btn`, `.input`, `.chip`, `.seg`, `.stack`, `.row`…
- Svaka stranica je `<div className="page">…</div>` i počinje sa `<PageHeader …/>` (osim ako spec kaže drugačije).
- Pristupačnost: ikonice-dugmad imaju `label`; kontrola statusa (i ocena dana) je grupa prekidača (`role="group"` sa
  `aria-label`, dugmad sa `aria-pressed`, jer klik na aktivno poništava izbor); Segmented i CategoryPicker su radio
  grupe sa strelicama (roving tabindex; "+ Nova" u CategoryPicker-u je obično dugme, strelice rade samo na čipovima); fokus vidljiv.
- Tekstovi i placeholderi ne pominju konkretne kategorije, šablone ni nečiji primer dana ("Naziv bloka", "Naziv
  kategorije", "Naziv šablona").
- Forme u sheet-u (blok, zadatak, kategorija, šablon) pitaju "Odbaci izmene?" pre zatvaranja sa nesačuvanim izmenama
  (X, Esc, "nazad" na Androidu, klik na pozadinu, "nazad" u browseru — miš, Alt+← — i zatvaranje/osvežavanje taba;
  `lib/useUnsavedGuard.ts`). Klik na pozadinu zatvara samo ako je i počeo na pozadini; dodir pored otvorene
  tastature je samo skloni. Zatvaranje sheet-a vraća fokus na element koji ga je otvorio.
- Toast dok je otvoren sheet ide unutar njegovog dijaloga (vidljiv i dodirljiv), na vrh ekrana. Dodir na samu poruku
  prolazi do sadržaja ispod (samo × je dugme). Na desktopu je toast po sredini sadržaja (desno od bočne trake).
- Zaglavlje stranice (`.page-head`) je visoko bar 40px, a akcije su poravnate po sredini sa naslovom (zaglavlje dana na
  desktopu: uz vrh, jer ima i podnaslov).
- Tamna tema: izabrana stavka Segmented i dugme prekidača su svetliji od staze (`--raised`, `--toggle-knob`,
  uključen prekidač `--toggle-knob-on`);
  tekst na `--danger` je `--danger-contrast` (taman u tamnoj temi).
- Sav tekst na srpskom latinici, kratak; vreme "09:15", trajanje "4h 45m" (`fmtDuration`), procenat "73%" (`fmtPercent`).

## 8. Podaci u komponentama
- `useScheduleData()` → kategorije, šabloni, mapiranje, podešavanja (App garantuje da su učitani).
- Posle mutacije rasporeda: `scheduleStore.set(payload)`.
- `useLogicalNow()` → `{ date, minute }` (osvežava se na 30s i pri povratku u aplikaciju).
- Greške: `toast.error(errorMessage(e))`. Opasne akcije: `await confirmDialog({ title, body, confirmText, danger: true })`.
- Navigacija: `navigate(paths.day(date))`, `<Link to={paths.progress}>`.
