# Ritam — specifikacija

Aplikacija za planiranje dana u vremenskim blokovima. Nalozi (email + lozinka), svaki sa potpuno odvojenim
podacima; više uređaja po nalogu (telefon kao PWA + laptop u browseru), podaci na serveru (SQLite) da bi se
sinhronizovali.

Primer dana koji je korisnik jednom opisao je samo ilustracija: ništa se ne pravi niti ponaša prema njemu
(sekcija 4). Raspored (kategorije, šabloni, dani u nedelji, početak dana) korisnik pravi sam.

UI je dvojezičan: **engleski je podrazumevan**, a **srpski (latinica, obraćanje na "ti")** je dodatni jezik koji se bira u
Podešavanjima ili na ekranu prijave (sekcija 5, "Jezik"). Kratko i jasno, bez emodžija, bez uzvičnika (sekcija 7).
U aplikaciji se stavke dana zovu **Block / Blocks** (srpski **Blok / Blokovi**) — nikad "cube" / "kocka".

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
  Naslovni font EB Garamond 500 iz `@fontsource/eb-garamond` (devDependency, SIL OFL): `styles/fonts.css` ručno
  deklariše samo latin i latin-ext `.woff2` (nikad `index.css` paketa), Vite ih pakuje u `/assets/` — bez CDN-a.
- Typecheck: `npm run typecheck` (`tsconfig.web.json` za `web/src` + `shared`, `tsconfig.server.json` za `server` + `shared`).
- Build: `npm run build` → `vite build` → `dist/web`. Server servira `dist/web`.
- Dev: `npm run dev` (server na :3000 sa `--watch`, Vite na :5173 sa proxy `/api` → :3000).

```
shared/          types.ts, time.ts (datumi + formateri po jeziku), summary.ts, i18n.ts (jezici, množina,
                 formatiranje poruka) — VEĆ NAPISANO, deli se između servera i weba
server/          index.ts (ulaz), db.ts, defaults.ts, auth.ts (lozinke, JWT, refresh token, ograničenja),
                 accounts.ts (nalozi i refresh tokeni u bazi), authRoutes.ts (/api/auth/*, Bearer),
                 repo.ts (podaci korisnika), backup.ts, validate.ts, i18n.ts (poruke grešaka en/sr),
                 api.ts ... (agent: server)
web/index.html
web/public/      manifest.webmanifest, sw.js, icons/ (agent: shell)
web/src/
  main.tsx, App.tsx               (agent: shell)
  api.ts                          VEĆ NAPISANO — tipizovan API klijent (šalje X-Ritam-Lang)
  i18n/en.ts, sr.ts, index.ts     VEĆ NAPISANO — katalozi (en = izvor istine ključeva), t/useT/useLang, jezik
  lib/store.ts, router.tsx, hooks.ts   VEĆ NAPISANO
  ui/                             VEĆ NAPISANO — Button, IconButton, Icon, Sheet, Field, TextInput,
                                  TimeInput, Select, TextArea, PageHeader, Card, Empty, Spinner,
                                  PageLoader, ProgressBar, Ring, Segmented, CategoryDot,
                                  CategoryStroke, CategoryPicker, Toggle, RatingInput, RatingDots,
                                  toast, Toaster, confirmDialog, ConfirmHost, cx
  styles/fonts.css, tokens.css, base.css, ui.css  VEĆ NAPISANO
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

- Datum: ISO `'YYYY-MM-DD'`. Sve funkcije su u `shared/time.ts` (i formateri za prikaz, koji primaju jezik — sekcija 7).
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

Svaki red podataka pripada nalogu (`user_id` = `users.id`); blokovi šablona pripadaju nalogu preko svog šablona.
`user_id` nema strani ključ ka `users` (0 = "bez vlasnika", vidi preuzimanje ispod) — vlasništvo proverava server
(`server/repo.ts`: svaki upit je ograničen na nalog iz access tokena).

```sql
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  -- 'schema_version' → '4'; 'settings' → podešavanja iz verzije bez naloga (prvi nalog ih preuzima);
  -- 'legacy_owner' → id naloga koji je preuzeo podatke iz verzije bez naloga (nema ga dok to niko nije uradio)

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,      -- id se nikad ne dodeljuje ponovo (access token nosi id)
  email TEXT NOT NULL UNIQUE,                -- trim + mala slova
  password_hash TEXT NOT NULL,               -- 'scrypt$32768$8$1$<so base64url>$<heš base64url>'
  settings TEXT NOT NULL DEFAULT '{"dayStart":0,"streakThreshold":0.7}',  -- Settings (JSON): dayStart,
                                             --   streakThreshold, lang ('en' | 'sr'; bez njega = 'en')
  created_at TEXT NOT NULL);

CREATE TABLE refresh_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family TEXT NOT NULL,                      -- jedna prijava na jednom uređaju; rotacija ostaje u familiji
  token_hash TEXT NOT NULL UNIQUE,           -- SHA-256 (base64url); sam token je samo u kolačiću
  created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  revoked_at TEXT,                           -- zamenjen (rotacija), odjava, promena lozinke ili krađa
  user_agent TEXT);
CREATE INDEX refresh_tokens_user ON refresh_tokens(user_id);
CREATE INDEX refresh_tokens_family ON refresh_tokens(family);

CREATE TABLE categories (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, color TEXT NOT NULL,
  counts INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,       -- 1 = obrisana (vidi "Raspored" u sekciji 5)
  user_id INTEGER NOT NULL DEFAULT 0);
CREATE INDEX categories_user ON categories(user_id);

CREATE TABLE templates (id INTEGER PRIMARY KEY, name TEXT NOT NULL, sort INTEGER NOT NULL DEFAULT 0,
  user_id INTEGER NOT NULL DEFAULT 0);
CREATE INDEX templates_user ON templates(user_id);

CREATE TABLE template_blocks (               -- vlasnik = vlasnik šablona
  id INTEGER PRIMARY KEY,
  template_id INTEGER NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
  start_min INTEGER NOT NULL, end_min INTEGER NOT NULL, title TEXT NOT NULL,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL);

CREATE TABLE weekday_templates (
  user_id INTEGER NOT NULL DEFAULT 0,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  template_id INTEGER REFERENCES templates(id) ON DELETE SET NULL,
  PRIMARY KEY (user_id, weekday));

CREATE TABLE days (
  user_id INTEGER NOT NULL DEFAULT 0,
  date TEXT NOT NULL,
  initialized INTEGER NOT NULL DEFAULT 0,   -- 1 = blokovi su kopirani iz šablona
  template_id INTEGER REFERENCES templates(id) ON DELETE SET NULL,
  note TEXT NOT NULL DEFAULT '',
  rating INTEGER CHECK (rating BETWEEN 1 AND 5),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, date));

CREATE TABLE blocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL DEFAULT 0,
  date TEXT NOT NULL,
  start_min INTEGER NOT NULL, end_min INTEGER NOT NULL, title TEXT NOT NULL,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','partial','skipped')),
  actual_min INTEGER,
  note TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (user_id, date) REFERENCES days(user_id, date) ON DELETE CASCADE ON UPDATE CASCADE);
CREATE INDEX blocks_user_date ON blocks(user_id, date);

CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, title TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0, done_at TEXT,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  sort INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL,
  user_id INTEGER NOT NULL DEFAULT 0);
CREATE INDEX tasks_user_date ON tasks(user_id, date);
CREATE INDEX tasks_user_open ON tasks(user_id, done, date);
```

Migracije: niz migracija, `meta.schema_version`; nova baza je prazna (sekcija 4).
Migracija 2 pravi `blocks` i `tasks` ponovo sa `AUTOINCREMENT`: id obrisanog bloka/zadatka se nikad ne dodeljuje
ponovo, pa zastareo zahtev sa drugog uređaja dobija 404 umesto da izmeni drugi red.
Migracija 3 dodaje `categories.archived` (brisanje kategorije je arhiviranje, pa se ni njen id ne dodeljuje ponovo).
Migracija 4 (nalozi): `user_id` (podrazumevano 0) u `categories`, `templates`, `tasks`; `weekday_templates`, `days` i
`blocks` se prave ponovo sa ključevima iznad, `users` i `refresh_tokens` su nove. Strani ključevi kao u migraciji 2:
briše se samo tabela koju u tom trenutku niko ne referencira (nova `blocks` referencira novu `days` pre brisanja stare,
a RENAME prepravlja referencu), brojač `AUTOINCREMENT` blokova se prenosi. Postojeći redovi dobijaju `user_id = 0` i
ostaju potpuno isti.
Pre migracija postojeće baze (šema 1..N−1, ne nove) server napravi kopiju `<baza>.pre-v<stara šema>-<YYYYMMDD-HHmmss>.bak`
(`VACUUM INTO`, van transakcije migracija; log `Ritam: kopija baze pre nadogradnje šeme (vX → vY): …`). Neuspeh kopije
(npr. pun disk) je samo upozorenje — migracije su ionako u jednoj transakciji. Prethodna verzija aplikacije odbija bazu
novije šeme ("Baza ima noviju verziju šeme…"), pa se vraćanje na nju radi iz te kopije (ili iz JSON izvoza).

**Preuzimanje podataka iz verzije bez naloga**: kad se napravi PRVI nalog (tabela `users` je bila prazna), u istoj
transakciji svi redovi sa `user_id = 0` dobijaju njegov id (blokovi prate svoj dan preko `ON UPDATE CASCADE`), a
`meta.settings` postaje `users.settings`; id-jevi i sadržaj se ne menjaju (izvoz posle preuzimanja je isti kao izvoz
ranije verzije). Ako je baza imala podatke (kategorije, šabloni, zadaci ili dani bez vlasnika), upisuje se i
`meta.legacy_owner` = id tog naloga: odgovori naloga (registracija, prijava, osvežavanje, promena lozinke, `me`) mu uz
korisnika šalju `legacyOwner: true`, pa samo on na uređaju preuzima i draftove beleški iz te verzije (sekcija 6).
Svaki sledeći nalog počinje prazan: 7 redova `weekday_templates` bez šablona i podrazumevana podešavanja. Preuzimanje
ne zavisi od politike registracije: uz otvorenu registraciju (podrazumevano) podatke dobija prvi ko napravi nalog, pa
server pri pokretanju to glasno upozorava (sekcija 5, "Registracija"), a vlasnik pravi svoj nalog odmah posle
nadogradnje (README); uz `SIGNUP=code` i prvi nalog mora da zna kod.

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

Nova baza (`server/defaults.ts`, upisuje se samo kad baza nema šemu, u istoj transakciji kao migracije) — redovi su
"bez vlasnika" (`user_id = 0`), pa ih prvi nalog preuzima isto kao podatke iz verzije bez naloga (sekcija 3):
- `categories`, `templates`, `template_blocks`, `days`, `blocks`, `tasks`, `users`, `refresh_tokens`: prazne;
- `weekday_templates`: redovi 1..7 sa `template_id = NULL` (nijedan dan nema šablon);
- `meta.settings`: `{ dayStart: 0, streakThreshold: 0.7, lang: 'en' }` — dan podrazumevano počinje u **00:00**, prag
  niza 70%, jezik engleski. Iste vrednosti dobija svaki sledeći nalog (`users.settings`), osim jezika: nov nalog (i prvi)
  dobija jezik iz registracije (sekcija 5, "Jezik"). Koriste se i kad sačuvana podešavanja nedostaju ili nisu ispravna
  (nalog napravljen pre izbora jezika nema `lang` → `'en'`).

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

Svi odgovori su JSON. Greške: `{ "error": "Poruka na jeziku zahteva", "code"?: "…" }` sa odgovarajućim statusom (400
validacija, 401 nije prijavljen, 403 CSRF / registracija, 404 ne postoji, 409 konflikt, 413 prevelik zahtev, 429 previše
pokušaja). `code` (`AuthErrorCode` u `shared/types.ts`) imaju greške naloga i ne zavisi od jezika. Tipovi su u
`shared/types.ts`; klijent je `web/src/api.ts` (izvor istine za putanje i oblike). Poruke navedene ispod su srpske
(`X-Ritam-Lang: sr`); engleske su u `server/i18n.ts` (npr. 401 "You’re not signed in.", "Wrong email or password.").

### Jezik
- Jezici: `'en'` (podrazumevano) i `'sr'` (srpski, latinica) — `Lang` u `shared/types.ts`; pravila (množina, poruke) u
  `shared/i18n.ts`.
- **Jezik zahteva** (`server/i18n.ts` `requestLang`): header `X-Ritam-Lang: en|sr` (bez razlike velikih slova; klijent ga
  šalje uz svaki zahtev, `web/src/api.ts`), inače najbolji podržan jezik iz `Accept-Language` (po `q`, primarna oznaka
  `en`/`sr`), inače `'en'`. Na tom jeziku su SVE poruke za korisnika: greške validacije (zod šeme nose ključ kataloga,
  `validate.ts` `E('…')`; opšte poruke "Nedostaje vrednost (polje)." / "Missing value (field)." itd.), naloga,
  ograničenja (429 sa množinom: "1 minut" / "2 minuta" / "5 minuta", "1 minute" / "15 minutes"), 404, 413, 500 i
  tekstualni 404 statike. `HttpError` nosi ključ poruke (`server/i18n.ts`), a prevodi se tek u odgovoru (`app.ts`
  `onError`). Log pri pokretanju i upozorenja u logu ostaju na srpskom.
- **Jezik naloga**: `users.settings.lang` (`Settings.lang`, u `SchedulePayload.settings`). `PATCH /api/settings { lang }`
  ga menja (važi na svim uređajima naloga); nepoznata vrednost → 400 "Jezik mora biti "en" ili "sr".". Registracija prima
  opciono `lang` (jezik izabran na ekranu prijave); bez njega nalog dobija jezik zahteva. Nalog bez `lang` (napravljen
  pre jezika) je `'en'`. Izvoz ima `settings.lang`; uvoz kopije sa jezikom ga postavlja, a kopija bez jezika (ranija
  verzija) ili sa nepoznatim jezikom zadržava jezik naloga.
- **Klijent** (`web/src/i18n/`): jezik se pamti na uređaju (`localStorage 'ritam.lang'`, try/catch; bez njega `'en'`) i
  primenjuje pre prvog rendera. Posle prijave i obnove sesije jezik naloga ima prednost i upisuje se na uređaj (prvi
  raspored koji stigne sa servera, `syncAccountLang` u `lib/store.ts`); kasnije se primenjuje samo kad se jezik naloga
  promeni na serveru (drugi uređaj), pa zakasneo odgovor ne vraća upravo promenjen jezik. Odjava/odbijena sesija
  (`scheduleStore.clear`) to resetuje. Promena jezika menja `<html lang>` (`en` / `sr-Latn`), naslov dokumenta, ostale
  tabove (`storage`) i ponovo renderuje celu aplikaciju (`App` sluša jezik; forme i stanje stranica ostaju).
  Izbor: Podešavanja → prva kartica "Language · Jezik" (Segmented "English | Srpski"; odmah lokalno, pa
  `api.patchSettings({ lang })`; neuspeh vraća prethodni jezik uz toast na tom, vraćenom jeziku: "Jezik nije sačuvan.
  Pokušaj ponovo." / "Language wasn’t saved. Try again." — ne poruka servera ili SW-a, koja je već na novom jeziku)
  i tih red "English · Srpski" ispod forme prijave (samo uređaj; pri registraciji ide kao `lang`).
- Service worker: JSON greška bez mreže (`503 { error }`) je na jeziku zahteva (`X-Ritam-Lang`), a stranica "nema
  konekcije" (kad ni keširani '/' ne postoji) je dvojezična — engleski, pa srpski. `manifest.webmanifest` i meta opis u
  `index.html` su na engleskom (`lang: "en"`).

Sve rute podataka (dan, blokovi, zadaci, statistika, dnevnik, raspored, podešavanja, izvoz/uvoz) rade nad podacima
naloga iz access tokena, sa istim putanjama i oblicima kao pre naloga: svaki upit je ograničen na `user_id`, pa se
id (blok, zadatak, kategorija, šablon) ili datum drugog naloga ponaša tačno kao nepostojeći (404, 400 "… ne postoji."
za vezu u telu zahteva, prazan pregled dana). Jedinstvenost naziva, obrisane kategorije, dani u nedelji, podešavanja
(`users.settings`), statistika i niz, pretraga dnevnika, završeni zadaci, zamena/deljenje/prebacivanje, premeštanje
blokova šablona pri promeni dayStart i provera pri pokretanju — sve je po nalogu.
Id-jevi (`AUTOINCREMENT`/rowid blokova, zadataka, kategorija, šablona) su jedan brojač po tabeli za ceo server, zajednički
za sve naloge: po razmacima između svojih id-jeva nalog može da zaključi koliko i kada su drugi nalozi pravili redove (ne
i šta). Namerno prihvaćeno za mali (porodični) server; neprozirni id-jevi po nalogu bi menjali svaku rutu i izvoz/uvoz.

### Nalozi i prijava (`server/auth.ts`, `accounts.ts`, `authRoutes.ts`)
- **Lozinka**: 8..200 znakova. Heš: `node:crypto` scrypt (N=32768, r=8, p=1, so 16 nasumičnih bajtova, ključ 64 bajta,
  lozinka NFC), zapis `scrypt$32768$8$1$<so>$<heš>` (base64url); provera `timingSafeEqual`. Prijava sa nepostojećim
  email-om ipak radi jednu scrypt proveru (heš nasumične lozinke napravljen pri pokretanju) — vreme odgovora ne otkriva nalog.
- **Email**: trim + mala slova, `nešto@nešto.tld` (bez razmaka), najviše 254 znaka; bilo koji provajder.
- **Access token**: JWT HS256 `{ sub: "<id>", typ: "access", iat, exp }`, važi 15 min (env `ACCESS_TOKEN_TTL_SEC`,
  1..86400, za testove). Ključ potpisa = HMAC-SHA256(`sessionKey`, `'ritam:access-v1'`), `sessionKey` = `SESSION_SECRET`
  ili 32 nasumična bajta iz `DATA_DIR/session.key` (pravi se pri prvom pokretanju, mode 600). Prihvata se samo naš
  header (alg HS256; `none` i drugi algoritmi ne). Klijent ga drži samo u memoriji i šalje kao `Authorization: Bearer <token>`.
  `SESSION_SECRET` kraći od 32 znaka → upozorenje u logu (`Ritam: SESSION_SECRET je prekratak …`), server se ipak
  pokreće: svaki nalog dobija potpisan token, pa bi kratak ključ mogao offline da pogađa i lažira tokene za druge naloge.
- **Refresh token**: 32 nasumična bajta (base64url) u kolačiću `ritam_refresh` — HttpOnly, SameSite=Strict,
  Path=/api/auth, Max-Age = trajanje, `Secure` kad je zahtev HTTPS (`X-Forwarded-Proto: https` ili URL https). U bazi
  samo SHA-256 (`refresh_tokens`), važi 90 dana od izdavanja (env `REFRESH_TOKEN_TTL_SEC`, 60 s..400 dana).
  - Prijava i registracija prave novu familiju (jedan uređaj). Svako uspešno osvežavanje opoziva pokazan token i izdaje
    nov u istoj familiji (rok ponovo 90 dana), pa uređaj koji se koristi ostaje prijavljen.
  - Pokazan **opozvan** token: ako familija više nema aktivan token (odjava, promena lozinke, ranije otkrivena krađa) →
    401 `invalid_refresh`; ako je zamenjen pre manje od 30 s (env `REFRESH_RACE_GRACE_SEC`, 0..300; dva taba su
    istovremeno osvežavala) → 401 `refresh_race` bez ikakve izmene i bez brisanja kolačića (u browseru je već nov);
    inače (stari token upotrebljen ponovo = krađa) se opoziva cela familija, log `Ritam: ponovo upotrebljen zamenjen
    refresh token …` → 401 `invalid_refresh`. Istekao ili nepoznat → 401 `invalid_refresh`. Uz `invalid_refresh` se
    kolačić briše.
  - Istekli tokeni se brišu usput (najviše jednom u 10 min); opozvani ostaju do isteka (krađa se otkriva i kasnije).
- **Registracija** (env `SIGNUP` = `open` | `closed` | `code`, bez razlike velikih slova; neispravna vrednost → izlaz 1).
  Nema lozinke ni koda aplikacije: prijava je samo nalogom (email + lozinka).
  - `open` — **podrazumevano** (bez `SIGNUP` ili prazan): nalog pravi svako, samo email-om i lozinkom; `code` iz tela
    zahteva se ignoriše. Server se pokreće na bilo kojoj adresi (`HOST`), bez posebnog uslova. Prihvaćen kompromis:
    uz otvorenu registraciju svako može da koristi prostor na serveru (nema kvote po nalogu ni ograničenja broja
    naloga, osim ograničenja pokušaja registracije); kontrola za to je `SIGNUP=closed` ili `SIGNUP=code`.
  - `closed` — nove naloge niko ne pravi (403 `signup_closed`); postojeći nalozi se normalno prijavljuju. Vlasnik ga
    postavlja kad napravi svoje naloge (docker-compose.yml prosleđuje `SIGNUP` iz `.env`, podrazumevano `open`, i
    `SIGNUP_CODE`, podrazumevano prazan).
  - `code` — nalog pravi samo ko pošalje `SIGNUP_CODE` (i prvi nalog). Bez `SIGNUP_CODE` (ili samo razmaci) → izlaz 1:
    `Ritam: SIGNUP=code traži kod za registraciju — postavi SIGNUP_CODE, ili ukloni SIGNUP=code …`. Razmaci na krajevima
    koda se ne računaju (ni u env-u ni u zahtevu; klijent ih ionako skida). Kod se poredi u konstantnom vremenu
    (SHA-256 + `timingSafeEqual`).
  - `SIGNUP_CODE` uz politiku koja nije `code` se ne koristi → upozorenje `Ritam: SIGNUP_CODE je postavljen, ali se ne
    koristi (SIGNUP=…)`.
  - `APP_PASSWORD` (lozinka aplikacije pre naloga, pa kod za registraciju) se više ne čita ni za šta. Ako je postavljen →
    jedan informativni red `Ritam: APP_PASSWORD se više ne koristi i ignoriše se — …` (registraciju bira `SIGNUP`:
    `closed` je zatvara, `code` + `SIGNUP_CODE` traži kod).
  - Uz otvorenu registraciju i podatke bez vlasnika (nema naloga, sekcija 3) → upozorenje u logu da SVE te podatke dobija
    prvi ko napravi nalog (vidi "Log pri pokretanju" ispod); uz `closed` → upozorenje da ih niko ne može preuzeti dok je
    registracija zatvorena.
- **Ograničenja** (u memoriji procesa, prozor 15 min): neuspele prijave po adresi klijenta (IPv6: mreža /64) i po
  email-u, po 10, plus 300 ukupno. Pokušaj se broji pre provere (paralelni zahtevi ne zaobilaze ograničenje), a uspela
  prijava se posle provere poništava (samo taj pokušaj: adresa i ukupno) i briše neuspehe tog email-a — uspele prijave
  se ne računaju (više uređaja ili cela kuća iza jedne adrese ne dolazi do blokade), a raniji neuspesi sa adrese ostaju.
  Provera trenutne lozinke pri promeni lozinke: ograničenje po nalogu (`pw:<id>`, 10), ne po javnom email ključu (tuđe
  neuspele prijave ne blokiraju promenu lozinke prijavljenom vlasniku); neuspeh se upisuje i kao neuspela prijava tim
  email-om, uspeh briše oba i poništava pokušaj u ukupnom broju. Registracija: 10 pokušaja (i uspelih) po adresi
  (posebno brojanje). Prekoračenje → 429 `rate_limited`
  "Previše pokušaja. Pokušaj ponovo za N minuta." (N = stvarno preostalo vreme, "1 minut" / "N minuta") i
  `Retry-After` (sekunde). Adresa je adresa konekcije; `X-Forwarded-For` se koristi samo uz env `TRUST_PROXY=n`
  (broj proxy-ja ispred aplikacije: klijent je n-ti unos od kraja; Nginx/Caddy = 1; kraći lanac → adresa konekcije)
  ili kad konekcija dolazi sa iste mašine (127.0.0.0/8, ::1; poslednji unos). Neuspela prijava → log
  `Ritam: neuspela prijava (adresa …)` (provera TRUST_PROXY, README).

Rute (javne: `/api/health`, `config`, `register`, `login`, `refresh`, `logout`; ostale traže Bearer):
- `GET /api/auth/config` → `AuthConfig` `{ signup: 'open' | 'code' | 'closed' }`.
- `POST /api/auth/register { email, password, code?, lang? }` (`code` samo uz `SIGNUP=code`; uz `open` je dovoljno
  `{ email, password }`; `lang` = jezik naloga, bez njega jezik zahteva — "Jezik" iznad) → 201 `AuthResponse` `{ accessToken, expiresIn, user: { id, email,
  legacyOwner? } }` (`legacyOwner: true` samo za nalog iz `meta.legacy_owner`, sekcija 3; u svim odgovorima naloga)
  + kolačić. Redom: `closed` → 403 `signup_closed` "Registracija nije otvorena."; 400 "Unesi ispravnu email adresu." /
  "Lozinka mora imati bar 8 znakova." / "Lozinka može imati najviše 200 znakova."; 429; uz `SIGNUP=code` pogrešan ili
  nedostajući kod (`code`) → 403 `bad_code` "Pogrešan kod za registraciju."; email već postoji → 409 "Nalog sa tom email adresom već
  postoji." (i kad dve registracije stignu istovremeno). Prvi nalog preuzima podatke bez vlasnika (sekcija 3).
- `POST /api/auth/login { email, password }` → 200 `AuthResponse` + kolačić (nova familija); pogrešan email ili lozinka
  (i neispravan email) → 401 "Pogrešan email ili lozinka."; 429. Telo bez `email` (tab ili PWA iz verzije pre naloga
  šalje samo `{ password }`) → 400 `client_outdated` "Ritam je ažuriran. Osveži stranicu (ili zatvori i ponovo otvori
  aplikaciju), pa se prijavi email-om." (pre ograničenja i provere lozinke; stari klijent prikazuje `error`).
- `POST /api/auth/refresh` (kolačić) → 200 `AuthResponse` + rotiran kolačić; 401 `no_session` (nema kolačića) /
  `refresh_race` / `invalid_refresh`.
- `POST /api/auth/logout` → 200 `{ ok: true }`: opoziva familiju pokazanog tokena (ako postoji) i briše kolačić; radi i bez
  važećeg kolačića.
- `GET /api/auth/me` (Bearer) → `{ user: AuthUser }`.
- `POST /api/auth/password { currentPassword, newPassword }` (Bearer) → 200 `AuthResponse` + nov kolačić: nova lozinka,
  opozvane SVE familije naloga (ostali uređaji su odjavljeni; njihov access token važi još najviše 15 min), nova
  familija za ovaj uređaj. Pogrešna trenutna → 401 `bad_password` "Trenutna lozinka nije tačna."; nova lozinka kao
  pri registraciji (400); 429.
- Sve ostale `/api/*` rute traže važeći access token → 401 `{ error: 'Nisi prijavljen.', code: 'unauthorized' }`
  (nema, neispravan, nalog ne postoji) ili `code: 'token_expired'` (potpis važi, rok je istekao). I nepoznata `/api`
  putanja bez tokena je 401 (sa tokenom 404).
- Kolačić `ritam_session` (prijava iz verzije bez naloga) se ne prihvata; odgovori prijave, registracije, osvežavanja i
  odjave ga brišu (Path=/) ako ga browser još šalje.
- CSRF: svaki ne-GET/HEAD zahtev na `/api/*` (i auth rute) mora imati header `X-Ritam: 1` → inače 403. (Klijent ga uvek šalje.)

### Zdravlje
- `GET /api/health` → `HealthPayload` `{ ok: true, build? }` (bez auth). `build` = `src` glavnog JS fajla iz
  `STATIC_DIR/index.html` (prvi `<script type="module" … src="/assets/…">`, npr. `"/assets/index-abc123.js"`), pročitan
  **jednom pri pokretanju** (novi deploy = novi proces); nema ga kad server ne servira build (razvoj preko Vite-a).
  Klijent (`lib/pwa.ts`) ga poredi sa `src` svog `<script type="module">` i posle deploy-a ponudi novu verziju
  (traka "Dostupna je nova verzija.", sekcija 6) — stranicu nikad ne učitava sam.

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
- `PATCH /api/settings { dayStart? (0..360, ceo broj), streakThreshold? (0.1..1), lang? ('en' | 'sr') }` → `SchedulePayload`
  (polja koja nisu poslata ostaju; "Raspored ispočetka" ne menja jezik)
- `POST /api/schedule/reset { dayStart?: boolean }` (`ScheduleResetInput`) → `SchedulePayload` — "Raspored ispočetka".
  U jednoj transakciji briše sve šablone (`template_blocks` kaskadno; `weekday_templates.template_id` i
  `days.template_id` postaju NULL preko stranih ključeva, pa sačuvan dan gubi samo oznaku šablona) i briše sve
  kategorije kao pojedinačno brisanje (`archived = 1`: sačuvani blokovi i zadaci ih zadržavaju kroz
  `archivedCategories`, pa se ispunjenost ranijih dana, zbir po kategorijama i niz ne menjaju). Sa `dayStart: true`
  i `settings.dayStart = 0` (prag niza ostaje; šablona više nema, pa nema ni blokova za premeštanje). Dani, blokovi,
  zadaci, beleške i ocene se ne diraju. Ponovljen poziv ništa ne menja (osim `dayStart`).

### Rezervna kopija
- `GET /api/export` → podaci SAMO prijavljenog naloga, bez `user_id`: `{ app: 'ritam', version: 1, exportedAt, settings,
  categories, templates, template_blocks, weekday_templates, days, blocks, tasks }` (sirovi redovi, snake_case kolone,
  isti oblik kao pre naloga) uz `Content-Disposition: attachment; filename="ritam-backup-YYYY-MM-DD.json"`.
- `POST /api/import` (isti oblik; i kopija iz verzije bez naloga ili sa drugog naloga) → u jednoj transakciji obriše
  SVE podatke prijavljenog naloga i upiše redove iz kopije; drugi nalozi se ne diraju. Svi redovi (kategorije, šabloni,
  blokovi šablona, dani u nedelji, dani, blokovi, zadaci) dobijaju NOVE id-jeve (po rastućem id-ju iz kopije, pa
  redosled ostaje), a sve veze se prevode — kopija ne može da se sudari sa tuđim redovima ni da ih dotakne, kakve god
  id-jeve sadržala. Veza ka redu kog nema u kopiji, dupli id, dupli datum ili dan u nedelji → 400 "Kopija nije ispravna:
  podaci se međusobno ne slažu." i ništa se ne menja. Podešavanja iz kopije postaju `users.settings` (kopija bez
  `settings.lang` ili sa nepoznatim jezikom zadržava jezik naloga). Validiraj oblik (i
  `isValidRange` za `blocks`/`template_blocks`); max 20 MB → `{ ok: true }`. Ista ograničenja kao API (uvezen red mora
  moći da se izmeni): naslov bloka/bloka šablona 1..120 (trim), zadatak 1..300, kategorija 1..40, šablon 1..60, beleška
  dana ≤ 20000, beleška bloka ≤ 5000, `actual_min` 0..1440 ili null. `categories.archived` (0/1) je u kopiji; kopija bez
  te kolone (starija verzija) se uvozi sa 0. Blokovi šablona sa obrisanom kategorijom dobijaju `category_id = NULL`.

### Statika
- `dist/web` (ili `STATIC_DIR`): `/assets/*` sa `Cache-Control: public, max-age=31536000, immutable`;
  `index.html`, `sw.js`, `manifest.webmanifest` sa `Cache-Control: no-cache`.
- SPA fallback: svaki GET koji nije `/api/*` i nije postojeći fajl → `index.html`.
- Bezbednosni headeri na svim odgovorima: `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`,
  `X-Frame-Options: DENY`, CSP: `default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline';
  script-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'`.
  Preko HTTPS-a (isto pravilo kao `Secure` kolačić) i `Strict-Transport-Security: max-age=31536000`.
- Env: `PORT` (3000), `HOST` (`127.0.0.1` — bez njega server sluša samo na ovoj mašini; Docker slika postavlja
  `HOST=0.0.0.0`, a docker-compose.yml port na serveru vezuje za `127.0.0.1:3001` iza Nginx-a), `DATA_DIR` (`./data`,
  baza je `DATA_DIR/ritam.db`, ključ `DATA_DIR/session.key`), `STATIC_DIR` (`dist/web`), `TRUST_PROXY` (broj reverse
  proxy-ja ispred aplikacije, `1` iza Nginx-a/Caddy-ja; neispravna vrednost → izlaz 1), `SIGNUP` (`open` podrazumevano
  | `closed` | `code`), `SIGNUP_CODE` (kod za registraciju, samo uz `SIGNUP=code`), `SESSION_SECRET`
  (opciono za server, obavezno u docker-compose.yml; ključ potpisa access tokena, bar 32 znaka — kraći uz upozorenje),
  `ACCESS_TOKEN_TTL_SEC` (900), `REFRESH_TOKEN_TTL_SEC` (7776000),
  `REFRESH_RACE_GRACE_SEC` (30). Neispravan broj → izlaz 1. `APP_PASSWORD` i `ALLOW_NO_AUTH` se više ne koriste (samo
  red u logu).
- Log pri pokretanju: `Ritam: http://… (baza: …, registracija: otvorena|uz kod|zatvorena, nalozi: N)`. Ako nema naloga
  a postoje podaci bez vlasnika: `Ritam: baza ima podatke iz verzije bez naloga — prvi nalog koji se registruje ih
  preuzima.`, a uz otvorenu registraciju odmah i upozorenje `Ritam: PAŽNJA — registracija je otvorena, pa SVE te
  podatke dobija PRVI ko napravi nalog. Odmah otvori aplikaciju i napravi svoj nalog …` (uz `closed`: `Ritam:
  registracija je zatvorena (SIGNUP=closed), pa te podatke niko ne može da preuzme — …`). Otvorena registracija bez
  takvih podataka: `Ritam: registracija je otvorena — nalog (email + lozinka) može da napravi svako … SIGNUP=closed
  zatvara registraciju.` Nov nalog: `Ritam: nov nalog (id N)[ — preuzeo je postojeće podatke].` Uz to, po potrebi,
  kopija baze pre migracije (sekcija 3), `APP_PASSWORD`/`SIGNUP_CODE`/`ALLOW_NO_AUTH` koji se ne koriste ("Registracija")
  i prekratak `SESSION_SECRET`.
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
`X-Ritam-Cached: 1` (`/api/auth/*`, `/api/export` i `/api/health` se ne keširaju). Kopija pripada nalogu: klijent uz
svaki zahtev sa tokenom šalje `X-Ritam-User: <id naloga>` (SW ga koristi samo za GET), SW upisuje odgovor pod samim
URL-om (bez `Authorization` — token se nikad ne upisuje na disk) sa istim headerom i vraća ga samo zahtevu istog naloga
(zahtev bez `X-Ritam-User` ide samo na mrežu, kopija bez oznake se nikad ne vraća). Keš se uz to briše pri odjavi,
odbijenoj sesiji i prijavi drugog naloga na uređaju, i ostaje prazan: odgovor koji stigne posle toga (izmena ili GET
poslat pre odjave, spora mreža) se ne upisuje — klijent upisuje kopiju samo dok je nalog tog odgovora prijavljen u tabu
(i keš nije obrisan u međuvremenu), a SW ne upisuje odgovor zahteva započetog pre brisanja. Klijent (`api.ts` `isCachedPayload`) takvu kopiju
nikad ne primenjuje preko podataka koje već ima (dan, raspored); koristi je samo kad nema ničeg drugog. Odgovori izmena
(dan, raspored) se upisuju u isti keš (`ritam-api`, stalno ime, header `X-Ritam-Stored` = vreme upisa), da kopija za rad bez
mreže ne bude starija od izmena; kasan odgovor GET zahteva poslatog pre te izmene je ne prepisuje.
Traka "Server nije dostupan" se pali na keširan odgovor i gasi tek kad server stvarno odgovori (dok je upaljena, server se
proverava preko `/api/health` na 15 s, pri povratku u aplikaciju i fokusu prozora). Keš je samo pomoć: greška
keša (pun disk) nikad ne obara odgovor mreže; nova verzija SW-a se instalira tek kad '/' i njegovi JS/CSS stignu sa mreže.
Fontovi naslova (`/assets/*.woff2` koje pominje CSS) se pri instalaciji keširaju ako stignu; nisu uslov instalacije
(bez njih je naslov u rezervnom serifu, a font se kešira pri prvoj upotrebi). Izmena `sw.js` = novi `VERSION`.
Nova verzija SW-a se aktivira sama čim se instalira (`skipWaiting` + `clients.claim`); poruka `{ type: 'skip-waiting' }`
je rezerva za verziju koja ipak čeka ("Osveži", ispod). Poruka `{ type: 'refresh-shell' }` (uz `MessageChannel` port,
odgovor `{ ok }`) odmah osveži keširani '/' sa mreže (`cache: 'no-store'`; samo uspešan HTML) — "Osveži", ispod.
Pri pokretanju se sesija obnavlja (`/api/auth/refresh`, kolačić), pa se učita raspored i prikaže aplikacija; 401 →
Prijava. Bez mreže, kad server ne odgovara (502–504, 5xx) ili obnova ne stigne za 4 s: aplikacija poslednjeg naloga ovog
uređaja (`localStorage 'ritam.lastUser'` = `{ id, email, signedOut? }`) iz keša SW-a, a obnova se završava u pozadini
(odbijena → Prijava, drugi nalog → stranica se učitava ponovo); uređaj bez poslednjeg naloga — i nalog koji se odjavio ili
mu je sesija odbijena (`signedOut: true`; id i email ostaju radi prepoznavanja promene naloga) — čeka odgovor, pa Prijava.
Raspored koji nije učitan nikad ne ostavlja samo spinner, nego "Podaci nisu učitani." + "Pokušaj ponovo" (i sam pokuša
ponovo kad se mreža vrati, događaj `online`). Dok je na ekranu dana kopija iz keša (ili poslednje
učitavanje dana nije dobilo odgovor servera), dan se tiho pokušava osvežiti na 15 s; čim server ponovo odgovori na bilo
koji zahtev (traka se gasi), dan se odmah osveži.
Raspored (izmene sa drugog uređaja) se tiho osvežava pri povratku u aplikaciju i fokusu prozora ako je stariji od 30 s, i na
minut dok je tab vidljiv a nijedan sheet nije otvoren; stanje se menja samo ako je server vratio nešto drugo.

**Nova verzija aplikacije (`lib/pwa.ts`, traka u `App.tsx`)**: stranica se nikad ne učitava sama.
- Provera = `build` iz `/api/health` različit od `src` glavnog `<script type="module">` ove stranice (u razvoju preko Vite-a
  nema build-a, pa ni provere). Ide pri pokretanju, pri povratku u aplikaciju i fokusu prozora (najviše jednom u 5 min), na
  30 min dok je tab vidljiv, na `online` (najviše jednom u 15 s), posle `updatefound`/`controllerchange` service worker-a i
  na zahtev (Podešavanja). Automatske provere idu samo dok je tab vidljiv, a istovremene dele jedan zahtev. Uz svaku i
  `reg.update()` (nov `sw.js`). Bez konekcije, sa odgovorom 5xx/502–504 ili sa kopijom iz keša (`/api/health` je u
  `NO_STORE` u `sw.js`, `isCachedPayload` je ionako odbacuje) provera ne zaključuje ništa — nikad "nova verzija".
- Nova verzija → store (`useUpdateState`, `useSyncExternalStore`) `available: true` → tiha traka "Dostupna je nova
  verzija." + dugme "Osveži" + × (`.shell-update`, `role="status"`, dugmad iz tastature: posle sadržaja stranice, pre donje
  trake). Telefon: odmah iznad donje trake (bez preklapanja; puna širina, visina 40px, `env(safe-area-inset-*)`); desktop:
  na dnu sadržaja (desno od bočne trake, 32px); Prijava i ekran greške: na dnu ekrana. Visina trake ide u `--update-h`
  na `<html>`: stranica (`.page`, `.login`) dobija toliko prostora na dnu, a toast-ovi stoje iznad trake. Dok je otvoren
  sheet ili dijalog, traka se ne prikazuje (čeka da se zatvori — "Osveži" bi prekinuo formu, a van modalnog dijaloga ionako
  ne prima dodir), pa nikad ne pokriva dugmad sheet-a. Traka ostaje dok se ne osveži ili sakrije.
- × sakrije traku za taj build do sledećeg drugačijeg build-a na serveru ili do sledećeg pokretanja aplikacije (pamti se
  samo u memoriji); ručna provera u Podešavanjima je ponovo prikazuje.
- "Osveži" (`applyUpdate`): dugme odmah pokazuje "Osvežava se…" sa malim spinerom (`aria-disabled`, × onemogućen);
  otvorena kartica beleške šalje nesačuvan tekst odmah (`NOTES_FLUSH_EVENT` iz `lib/noteDrafts.ts` → isto što i
  `pagehide`, bez čekanja debounce-a; draft je ionako u `localStorage` od svakog otkucanog znaka dok server ne potvrdi
  tekst), pa se čeka prazan red zahteva (`whenQueueIdle`, najviše 8 s; kroz zajednički red `lib/queue.ts` idu izmene
  dana, beleške i dani u nedelji). Zatim još jedna provera: bez konekcije (`navigator.onLine` je false) → toast
  "Nema konekcije.", server ne odgovara (uređaj je na mreži: odbijena konekcija, istek roka od 12 s, 5xx/502–504) →
  "Server nije dostupan. Pokušaj ponovo.", server je ponovo na ovoj verziji → traka nestaje; u tim slučajevima se
  stranica ne učitava (service worker bi vratio istu, keširanu verziju). Ako postoji SW koji čeka, dobija `skip-waiting`
  (najviše 3 s čekanja na `controllerchange`). Zatim SW koji kontroliše stranicu dobija `refresh-shell` i keširani '/'
  postaje nova verzija sa mreže (čeka se odgovor najviše 12 s, ili dok stranicu ne preuzme nova verzija SW-a; stranica se
  učitava i kad to ne uspe) — inače bi na sporoj mreži navigacija posle 3,5 s dobila keširani '/', a to je (kad se `sw.js`
  nije menjao) i dalje stari build. Ako se za vreme čekanja otvori sheet ili dijalog (traka se tada ne vidi), stranica
  se ne učitava: forma se nikad ne prekida, dugme se vraća na "Osveži", a traka se ponovo pojavi kad se sheet zatvori
  (sledeći dodir učitava). Inače `location.reload()`, a dok se stranica ne zameni, `body` je `inert` (ništa novo se ne
  otvara; ako browser ipak ostane na stranici, posle 10 s sve ponovo radi). Ništa od ovoga se ne pokreće samo, pa nema
  petlje učitavanja (posle učitavanja nova provera vidi isti build i traka se ne pojavljuje).

**Sesija na klijentu (`web/src/api.ts`, `lib/account.ts`)**:
- Access token (JWT) je samo u memoriji taba (nikad u storage-u) i ide uz svaki zahtev kao `Authorization: Bearer …`
  (osim `/api/health` i javnih ruta naloga). Refresh token je HttpOnly kolačić koji klijent ne vidi.
- 401 sa `code` `token_expired`/`unauthorized` (ili bez koda) → JEDNO zajedničko osvežavanje (`/api/auth/refresh`): u
  tabu svi zahtevi čekaju isto, a između tabova idu jedno po jedno (`navigator.locks.request('ritam-refresh')`, kad
  postoji — kolačić je zajednički, pa tab koji dođe na red šalje već rotiran token); zatim se zahtev ponovi jednom.
  `refresh_race` (sesija važi, drugi tab je upravo zamenio token) nikad nije odjava: novi pokušaji posle nasumične pauze
  0,3–1,2 s (tabovi ne pokušavaju u isti mah) dok ne prođe ~8 s; ako trka ne prestane, ne uspeva samo taj zahtev (kao
  greška mreže). Odbijeno osvežavanje (401 `no_session`/`invalid_refresh`) → token se briše i šalje se
  `ritam:unauthorized` (App → Prijava). Greška mreže ili 5xx pri osvežavanju = rad bez servera (greška tog zahteva), ne odjava.
- Token se osvežava unapred pri sledećem zahtevu kad mu je ostalo manje od 60 s (najviše četvrtina trajanja); token
  kome je ostalo bar 10 s se koristi odmah dok osvežavanje traje. Stranica koja se gasi (`pagehide` — u Chrome-u stiže
  pre nego što je stranica sakrivena; keepalive čuvanje beleške) ili sakrivena stranica šalje odmah, bez osvežavanja, sa
  tokenom kome je ostalo bar 1 s; ako ne uspe, draft ostaje u `localStorage` kao i do sada.
- Stranica pripada jednom nalogu (`pageOwner`: prvi nalog sesije u tabu; isti nalog = isti id i isti email) i nijedan
  njen zahtev ne ide sa tokenom drugog naloga. Osvežavanje (kolačić je zajednički) koje vrati drugi nalog (prijava u
  drugom tabu): njegov token se ne uzima, sesija u tabu se završava (zahtevi koji čekaju dobijaju 401 `user_changed`, bez
  slanja; draftovi ostaju pod ključem prethodnog naloga) → `ritam:user-changed` → stranica se učitava ponovo i obnovi
  sesiju novog naloga. Prijava drugog naloga dok su u memoriji stranice podaci prethodnog (sesija istekla, pa se
  prijavio neko drugi) učitava stranicu ponovo, a do tada se ništa ne šalje.
- Prijava, registracija i obnova sesije pri pokretanju upisuju `ritam.lastUser`; ako je pre toga na uređaju bio drugi
  nalog (drugi id, ili isti id sa drugim email-om — email se ne menja, pa je to druga baza na istoj adresi), brišu se API
  keš SW-a i draftovi beleški tog naloga (`ritam.note.<id>.*`). Draftove iz verzije bez naloga (`ritam.note.<datum>`)
  preuzima samo nalog koji je na serveru preuzeo podatke te verzije — korisnik u odgovoru prijave/osvežavanja označen
  sa `legacyOwner: true` (pri svakoj prijavi tog naloga, ne samo prvoj na uređaju); bez te oznake ostaju netaknuti.
  Odjava i odbijena sesija upisuju `signedOut: true` u `ritam.lastUser`.
- Tabovi istog browser-a se obaveštavaju preko `localStorage 'ritam.authEvent'` (događaj `storage`): odjava u jednom
  tabu odjavljuje i ostale; prijava drugog naloga učitava ostale tabove ponovo; tab na ekranu Prijava posle prijave u
  drugom tabu sam obnovi sesiju.

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
  šablon „X“, a ovaj dan je napravljen bez šablona." (dan u akuzativu, `weekdayNameAcc`: "Za subotu…", "Za sredu…"; en
  "The template for Saturday is “X”, but this day was created without a template.") + dugme "Primeni" (isto pravilo potvrde kao izbor šablona).
  Raniji dani je nemaju (istorija).
- Desktop: dve kolone (levo vremenska linija ~1.35fr, desno Pregled + Zadaci + Beleške). Telefon: jedna kolona:
  "Sada" kartica → vremenska linija → Pregled → Zadaci → Beleške.
- **"Sada" kartica** (samo za danas, kad dan ima blokove): trenutni blok + koliko je ostalo ("još 1h 12m"), sledeći blok
  ("Sledeće: <naslov> u 19:00").
  Ako nema trenutnog bloka: "Slobodno vreme" + sledeći. Do 12:00 se gleda i juče (isti zahtev kao podsetnik "Juče: …"):
  jučerašnji blok koji traje i posle početka ovog dana (npr. 23:30–07:00 kad dan počinje u 00:00) je trenutni dok traje
  ("23:30–07:00 · <kategorija> · od juče"; današnji blok koji je počeo kasnije ima prednost). Tada kartica postoji i
  kad današnji dan nema blokova.
- **Vremenska linija**: red po bloku: vreme početka/kraja (tabular), crta u boji kategorije (sekcija 7), naslov,
  "Kategorija · trajanje" (uz done/partial sa stvarnim vremenom i "· stvarno 1h 35m"; red se prelama samo pre "·", pa se
  trajanje ne cepa i tačka ne visi na kraju reda) (+ ikonica ako ima belešku), desno **kontrola statusa**: 3 dugmeta
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
  Nesačuvan draft se čuva i u `localStorage` (`ritam.note.<id naloga>.<datum>`, `{ base, text }`; posle uspelog čuvanja dok se kucalo
  dalje, `base` postaje upravo sačuvan tekst) dok server ne potvrdi isti tekst;
  neuspelo čuvanje se ponavlja pri napuštanju, povratku u aplikaciju, `online` i kad server ponovo odgovori (svež odgovor
  za dan) ("Pokušaj ponovo" ne šalje isti tekst dvaput; ako se čeka svež odgovor servera, odmah ga traži). Čuvanje koje
  čeka svež odgovor (polje popunjeno iz keša) samo zatraži osvežavanje dana. Pri otvaranju dana draft se vraća ako je
  server i dalje na `base` — odlučuje se tek po svežem odgovoru servera,
  nikad po kopiji iz keša; inače se nudi "Vrati je / Odbaci".
  Svako čuvanje šalje `baseNote` = belešku sa servera nad kojom je tekst pisan (čita se kad zahtev krene iz reda). Ako je
  beleška u međuvremenu promenjena na drugom uređaju (409, ili osvežavanje pokaže treći tekst dok postoje nesačuvane
  izmene), ništa se ne šalje: tekst ostaje u polju i u `localStorage`, a traka "Beleška je u međuvremenu promenjena na
  drugom uređaju." nudi "Sačuvaj ovu" (prepiše tu verziju) / "Uzmi tu verziju" (odbaci lokalni tekst); en "Save this
  version" / "Use the other version". Ako svež odgovor
  pokaže naš ranije poslat tekst (čuvanje kome je istekao rok ipak je stiglo, pa je sledeće dobilo 409), to nije sukob:
  traka se ne prikazuje (ili nestaje), a ostatak teksta se šalje nad tim tekstom. Fokus u polju
  osveži dan ako poslednji odgovor nije skorašnji.
  Draftovi drugih dana (čuvanje nije uspelo pa se prešlo na drugi dan / aplikacija zatvorena) šalju se sami pri otvaranju
  stranice, povratku u aplikaciju, `online` i kad server ponovo odgovori, ako je server i dalje na `base`; inače kartica pokazuje
  "Nesačuvana beleška za <datum>" sa linkom na taj dan (više dana: "Nesačuvane beleške za" / "Unsaved notes for" i do
  tri linka).
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
- **Dani u nedelji** (en "Days of the week" — ne "Weekdays", jer to je na engleskom samo pon–pet): 7 redova
  (Ponedeljak…Nedelja) sa Select-om šablona (ili "Bez šablona"; `title` sa nazivom izabranog
  šablona) → `api.putWeekdays` sa samo promenjenim danom (ostali dani ostaju kako su na serveru; zahtevi idu jedan za
  drugim kroz zajednički red zahteva `lib/queue.ts`, pa ih "Osveži" i odjava čekaju). Bez ijednog šablona redovi su
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
  ima diskretnu napomenu "Preko ponoći, do 07:00 sutra." / "Posle ponoći, na kraju ovog dana." (en "Past midnight,
  until 07:00 the next day." — šablon nema datum, pa ne "tomorrow"; isto "23:30–01:00 the next day" u upozorenju).
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
- Rezervna kopija (samo podaci prijavljenog naloga): "Preuzmi kopiju" (JSON fajl) i "Vrati iz kopije" (dugme "Izaberi
  fajl…", input file, potvrda
  "Svi podaci ovog naloga biće zamenjeni…", `api.importData`, pa reload).
- "Raspored ispočetka" (kartica posle Rezervne kopije): objašnjenje da se brišu sve kategorije, šabloni i dodela
  šablona danima u nedelji (da raspored napraviš od nule — npr. primer koji je ranija verzija upisala u novu bazu),
  a sačuvani dani, zadaci i beleške ostaju i napredak ranijih dana se ne menja. Kad "Dan počinje u" nije 00:00,
  prekidač "Vrati i početak dana na 00:00" (uključen). Dugme "Obriši raspored…" → `confirmDialog({ danger: true, … })` sa istim
  objašnjenjem → `api.resetSchedule({ dayStart })` (`POST /api/schedule/reset`) → `scheduleStore.set(payload)` +
  toast. Ništa se ne briše bez ove potvrde. Kad nema ničeg za brisanje (nijedna kategorija, šablon ni dodela — npr.
  nova instalacija), kartica se ne prikazuje (sam "Dan počinje u" se menja u kartici Dan).
- Kartica "Nalog": email naloga ("Prijavljen si ovim nalogom."; dugačka adresa se prelama posle "@"), "Lozinka" → dugme "Promeni lozinku" (mali
  sheet: "Trenutna lozinka" `current-password` + "Nova lozinka" `new-password`, bar 8 znakova; skriveno polje
  `username` sa email-om za menadžer lozinki; `api.changePassword` → nova sesija ovog uređaja, toast "Lozinka je
  promenjena."; pogrešna trenutna → greška ispod tog polja; ostali uređaji moraju ponovo da se prijave), "Odjava" (en
  "This device") → "Odjavi se" / "Sign out": sačeka izmene iz reda (najviše 5 s), pa ako ima lokalnih nesačuvanih
  beleški ovog naloga prvo potvrda "Imaš nesačuvanu belešku" sa datumom (više: "Imaš nesačuvane beleške", datumi
  nabrojani kratko — "6. okt i 8. okt" / "Oct 6 and Oct 8"); zatim `POST /api/auth/logout` (bez servera odjava ne uspeva — kolačić je
  HttpOnly — i toast kaže zašto), odmah završava sesiju u tabu (izmena koja stigne kasnije ne upisuje ništa na uređaj),
  briše draftove ovog naloga i keš API odgovora, označava `ritam.lastUser` kao odjavljen (pokretanje bez mreže zatim
  prikazuje Prijavu), javlja ostalim tabovima i vraća na Prijavu (sledeća prijava otvara Danas). Istekla sesija (401) draftove ne briše — šalju se posle ponovne prijave istog naloga.
- Kartica "Verzija" (poslednja, i u instaliranoj aplikaciji): jedan red sa verzijom "Ritam 1.0.0 · <oznaka build-a>"
  (oznaka = heš iz imena glavnog JS fajla, npr. `/assets/index-TP9-XS6p.js` → "TP9-XS6p", isti fajl koji server javlja u
  `/api/health`; u razvoju "razvoj"), objašnjenje "Nova verzija se proverava sama i nudi se trakom na dnu ekrana." i dugme
  "Proveri ažuriranje" (učitavanje dok traje) → ručna provera (sekcija 6): ista verzija → toast "Imaš najnoviju verziju.";
  nova → pojavi se traka (i ako je bila sakrivena); bez konekcije → toast "Nema konekcije."; server ne odgovara (uređaj
  je na mreži) → "Server nije dostupan. Pokušaj ponovo.".
- Kartica sa jednim redom (Izgled, Instalacija, Verzija) nema naziv reda, samo objašnjenje i kontrolu (naslov kartice je
  naziv); red kartice Verzija pokazuje samu verziju (kao email u kartici Nalog).

### 6.6 Prijava (`LoginPage`)
- Crno i mirno kao ostatak: centrirano, logo "Ritam" (Wordmark u `<h1>`), jedna rečenica ispod (`.login-sub`,
  naslovni serif 19px u `--text-2` — jedini serif na ekranu; bez akcenta osim fokusa, bez linija i ukrasa). Dva režima na istom
  ekranu: "Prijava" ("Prijavi se da nastaviš.", dugme "Prijavi se") i "Napravi nalog" ("Napravi nalog da počneš.",
  dugme "Napravi nalog"); prelaz je tih tekst-link ispod dugmeta ("Nemaš nalog? Napravi nalog" / "Već imaš nalog?
  Prijavi se"). Ponuda registracije se prikazuje tek kad `GET /api/auth/config` kaže `open` ili `code` (`closed` ili
  bez odgovora → samo prijava; bez mreže se proverava ponovo na `online`).
- Polja: "Email" (`type="email"`, `autocomplete="username"`, autoFocus), "Lozinka" (`current-password` /
  `new-password`, u registraciji hint "Bar 8 znakova."), i samo u registraciji kad je `signup: 'code'` "Kod za
  registraciju" (hint "Kod postavlja onaj ko vodi server."). Enter šalje formu, dugme pokazuje učitavanje.
- Greške stoje ispod polja na koje se odnose (provera na klijentu: "Unesi ispravnu email adresu.", "Unesi lozinku.",
  "Lozinka mora imati bar 8 znakova.", "Unesi kod za registraciju."; sa servera: 409 → email, 401 "Pogrešan email ili
  lozinka." → lozinka, `bad_code` → kod (polje se pojavi i ako ga ekran nije tražio), `signup_closed` → nazad na
  prijavu); 429 i greška mreže iznad dugmeta. Fokus ide na polje sa greškom.
- Nema drugih ekrana: bez resetovanja lozinke i dvostepene provere. Uspešna registracija vodi pravo u aplikaciju (novi
  nalog je prazan, pa Danas pokazuje "Napravi svoj raspored").

---

## 7. Dizajn (obavezno)

Cilj: čisto, mirno, kao dobro napravljen alat — **ne "AI generisan" izgled**. Uz logo (script Wordmark): knjiški
serif samo za naslove, sve ostalo sistemski sans, jedan prigušen akcenat po temi, fine linije.
- Koristi tokene iz `styles/tokens.css` (nikad hardkodovane boje osim boja kategorija iz podataka).
- Zabranjeno: gradijenti (jedini izuzetak je isprekidan uzorak oznake "prag za niz" u legendi Napretka),
  glassmorphism/blur, sjaj, emodžiji, ikone-u-krugu dekoracije, ornamenti, script pismo van Wordmark-a, šareni hero
  naslovi, marketinški tekst, senke na karticama (senka samo na sheet/toast), preterano zaobljeni uglovi (max 12px;
  gornji uglovi sheet-a na telefonu 14px), verzal van "oznake sekcije" (ispod).
- **Pisma** (uloge važe za svaki postojeći i budući ekran):
  - **Naslovni serif** `--font-display`: EB Garamond 500 (`styles/fonts.css`; dok ne stigne, `'EB Garamond Fallback'` =
    Georgia podešena na njegovu meru, pa se naslov ne pomera), bez razmaka slova, lining + proporcionalni brojevi,
    `font-synthesis: none` (učitana je samo težina 500). Samo naslovi, jednim grupnim pravilom u `base.css`: `.page-title`
    (30px, desktop 34px; i datum na Danas — na telefonu užem od 360px 26px, da "28. septembar ⌄" stane u jedan red pored
    ‹ › ⋯), `.sheet-title` (24px, i u dijalozima), `.empty-title` (22px),
    `.day-welcome-title` (26px), `.prog-period-title` (22px), `.jr-date` (datumi u Dnevniku, 21px) i `.login-sub` (19px).
    Novi naslov dobija serif dodavanjem klase u to pravilo, nikad sopstvenim `font-family`.
  - **Nikad serif** za: nazive blokova (ni u kartici "Sada"), vremena, odbrojavanje, KPI vrednosti, oznake grafika,
    nedeljne zbirove, zadatke, beleške, polja, dugmad, linkove, tabove i bočnu traku, toast, oznake polja, email naloga.
  - **Sadržaj**: sistemski sans (`--font`), 15px za tekst i redove, težine 400/550/600. Brojevi i vremena
    `font-variant-numeric: tabular-nums`.
  - **Oznaka sekcije**: 12px / 600 / visina reda 1.3 / razmak slova 0.08em / verzal / `--text-2` — samo `.card-title`,
    "Sada" (`.day-now-label`, u `--now`) i mesec u Dnevniku (`.jr-month-title`). KPI oznake, oznake ("Danas"), čipovi,
    oznake polja i podnaslovi u sheet-u ostaju obična rečenica; ništa u verzalu ispod 12px.
- **Jedan akcenat po temi** (`--now`, `--focus` je ista boja): tamna tema prigušena "šampanj" `#cbbd9f`, svetla tamno
  "mastilo" plavo `#3a5f8f` (`--now-bg` = blaga podloga trenutnog reda). Samo za: trenutno vreme (red "sada", njegova
  linija napretka, kartica "Sada"), danas (oznaka "Danas", dan u nedelji u Rasporedu, danas u grafiku, kalendaru i
  heatmapi Napretka), aktivnu navigaciju i fokus. Aktivan tab donje trake: crta 24×2px na njenoj gornjoj liniji + tekst
  600; aktivna stavka bočne trake: crta 2×16px uz levu ivicu + tekst `--text` 600, bez sive podloge (hover ostaje
  `--surface-2`). Nikad za status, kategorije, primarna dugmad, velike površine ni gradijente; Prijava nema akcenat
  (osim fokusa). Oznaka "trenutni" u izboru šablona je neutralna (`.day-tpl-current`: `--surface-3`, `--text-2`) —
  `.day-tag` u akcentu je samo "Danas". Traka nove verzije (`.shell-update`) je neutralna kao traka "nema interneta" (`--surface-2`, tanka linija,
  13px `--text-2`, bez tačke i akcenta; "Osveži" je podvučeno dugme-tekst u `--text` 600, × u `--text-3`).
- **Uglovi**: `--radius-sm` 5px, `--radius` 7px, `--radius-lg` 10px. Kontrola statusa (vidljiv krug 32px u dodirnoj
  površini 40px, na desktopu 30/34px), ocena dana i krug zadatka su krugovi.
- **Linije**: okvir kartice i polja je `1px solid var(--border)` / `var(--border-strong)`. Razdelnici UNUTAR kartica i
  traka (redovi lista, podnožje sheet-a, donja traka, ivica bočne trake, trake "nema interneta" i nove verzije, redovi Podešavanja,
  unosi Dnevnika, zbirovi) su `var(--hairline) solid var(--divider)`: na ekranima gustine 2x+ jedan fizički piksel
  (0.5px) u malo tamnijoj boji. Razdelnici redova u karticama (Danas, šabloni, kategorije) su `::before` uvučen 16px od
  ivica kartice, u ravni sa naslovom kartice (prvi red ga nema); redovi počinju na istih 16px.
- Hijerarhija tipografijom i razmakom, ne bojom. Prigušen sadržaj (npr. kategorije koje se ne računaju u Napretku) je
  prigušen bojom teksta (`--text-2`/`--text-3`), nikad providnošću teksta (kontrast ≥ 4.5:1).
- Boja kategorije: tačka 8px ili, uz red bloka (vremenska linija Danas, kartica "Sada", redovi editora šablona), crta u
  obliku blagog integrala ∫ (`ui/CategoryStroke.tsx`: uspravna crta 2px cele visine reda čiji se vrh savija desno, a dno
  levo; kuke 10×14px se nikad ne razvlače, pa su iste u svakom redu); svetla pozadina kategorije samo kroz
  `color-mix(in srgb, <boja> 10–14%, var(--surface))`.
- Status: done = `--done`, partial = `--partial`, skipped = `--skipped`; ikona uvek uz boju (ne samo boja).
- Dodirne površine ≥ 40px na telefonu (sitan link ili dugme dobija veću površinu preko `::after`, bez pomeranja
  rasporeda — npr. datumi u "Završeni zadaci"; × toast-a se ne skuplja ni kad se poruka prelomi). Izuzetak su samo
  ćelije gustih grafika Napretka: heatmapa poslednjih 12 nedelja (~20px) i kalendar meseca na telefonu užem od 360px
  (od 360px ćelija ima bar 40px, razmak 2px) — isti dani se otvaraju i iz grafika nedelje, kalendara i liste.
  Inputi `font-size: 16px` (iOS zoom). Onemogućeno polje/izbor: tekst `--text-3` na `--surface-2` (ne samo providnost
  browser-a). Izbor (`.select`) skraćuje dugačak naziv sa "…". Poštuj `env(safe-area-inset-*)`.
- Animacije kratke (120–220ms), poštuj `prefers-reduced-motion`.
- CSS klase po stranici sa prefiksom: `day-`, `prog-`, `sched-`, `jr-`, `set-`, `shell-`/`login-` (Prijava i Napravi nalog). CSS fajl po stranici,
  importovan iz te stranice. Zajedničke klase već postoje: `.page`, `.card`, `.btn`, `.input`, `.chip`, `.seg`, `.stack`, `.row`…
- Svaka stranica je `<div className="page">…</div>` i počinje sa `<PageHeader …/>` (osim ako spec kaže drugačije).
- Pristupačnost: ikonice-dugmad imaju `label`; kontrola statusa (i ocena dana) je grupa prekidača (`role="group"` sa
  `aria-label`, dugmad sa `aria-pressed`, jer klik na aktivno poništava izbor); Segmented i CategoryPicker su radio
  grupe sa strelicama (roving tabindex; "+ Nova" u CategoryPicker-u je obično dugme, strelice rade samo na čipovima); fokus vidljiv.
- Tekstovi i placeholderi ne pominju konkretne kategorije, šablone ni nečiji primer dana ("Naziv bloka", "Naziv
  kategorije", "Naziv šablona" / "Block name", "Category name", "Template name").
- Forme u sheet-u (blok, zadatak, kategorija, šablon) pitaju "Odbaci izmene?" pre zatvaranja sa nesačuvanim izmenama
  (X, Esc, "nazad" na Androidu, klik na pozadinu, "nazad" u browseru — miš, Alt+← — i zatvaranje/osvežavanje taba;
  `lib/useUnsavedGuard.ts`). Klik na pozadinu zatvara samo ako je i počeo na pozadini; dodir pored otvorene
  tastature je samo skloni. Zatvaranje sheet-a vraća fokus na element koji ga je otvorio.
- Toast dok je otvoren sheet ide unutar njegovog dijaloga (vidljiv i dodirljiv), na vrh ekrana, sa kraćom senkom
  (`--shadow-toast-top`, da ne zatamni naslov sheet-a ispod). Dodir na samu poruku
  prolazi do sadržaja ispod (samo × je dugme). Na desktopu je toast po sredini sadržaja (desno od bočne trake). Bez
  sheet-a toast stoji na dnu, iznad donje trake i iznad trake nove verzije (`--update-h`).
- Zaglavlje stranice (`.page-head`) je visoko bar 40px, a akcije su poravnate po sredini sa naslovom (zaglavlje dana na
  desktopu: uz vrh, jer ima i podnaslov).
- Tamna tema: izabrana stavka Segmented i dugme prekidača su svetliji od staze (`--raised`, `--toggle-knob`,
  uključen prekidač `--toggle-knob-on`);
  tekst na `--danger` je `--danger-contrast` (taman u tamnoj temi).
- **Tekst i jezici**: sav tekst interfejsa je u katalozima `web/src/i18n/en.ts` (engleski, izvor istine ključeva) i
  `sr.ts` (isti ključevi — TypeScript proverava; smoke test proverava i iste {parametre} i oblike množine). Ključevi
  su ravni, sa oblašću na početku (`common.*`, `status.*`, `error.*`, `day.*`, `tasks.*`, `notes.*`, `progress.*`,
  `journal.*`, `schedule.*`, `settings.*`, `login.*`, `shell.*`, `ui.*`, `update.*`); pravila su na vrhu `en.ts`.
  Komponenta koristi `useT()` (`t('day.now.next', { title, time })`, množina `t('common.blocks', { n })`), kod van
  Reacta `t()`; tekst iz useMemo ima jezik u zavisnostima. Nijedan tekst za korisnika nije zakucan u komponenti.
  - **Engleski** (podrazumevan): kratko, jasno, sentence case ("Add block", ne "Add Block"), bez uzvičnika i emodžija,
    bez marketinškog tona, obraćanje sa "you"; tipografski apostrof i navodnici (’ “ ”), tri tačke kao jedan znak (…).
    Stavke dana su **Block / Blocks**. Pojmovi: Template, Category, Today, Progress, Journal, Schedule, Settings,
    Tasks, Notes, Now, Overview, Free time, Days of the week (ne "Weekdays" — to je samo pon–pet), "Day starts at",
    completion (ispunjenost), streak (niz dana), Done / Partial / Not done / Pending, Backup, Account, Sign in,
    Create account, Sign out (cela lista u `en.ts`). Kraj bloka posle ponoći je "the next day", ne "tomorrow" (šablon
    nema datum, a prošli ili budući dan nije danas).
  - **Srpski**: latinica, obraćanje na "ti", kratko; isti tekst kao pre prevoda (pregledan) — "Blok / Blokovi",
    navodnici „…“, množina one/few/other ("1 blok", "2 bloka", "5 blokova", "21 blok").
  - **Datumi i brojevi** (`shared/time.ts`, uvek sa jezikom iz `useLang()`; podrazumevano `'en'`): `fmtDateLong` en
    "Thursday, October 8" (sa godinom ", 2026") / sr "Četvrtak, 8. oktobar" (" 2026."); `fmtDateMedium` "Thu, Oct 8" /
    "čet, 8. okt"; `fmtDateShort` "Oct 8" / "8. okt"; `fmtMonthYear` "October 2026" / "Oktobar 2026."; `fmtDayMonth`
    "October 8" / "8. oktobar" (bez prelamanja); `fmtDateRange` "Oct 6–12", "Sep 29 – Oct 5", "Dec 29, 2025 – Jan 4,
    2026" / "6–12. okt", "29. sep – 5. okt", "29. dec 2025. – 4. jan 2026." (unutar datuma nerazdvojivi razmaci, pa se
    prelama samo oko " – "); `weekdayName` / `weekdayShort` / `monthName` / `monthShort`; posle srpskog "za"
    `weekdayNameAcc` ("za subotu"); nabrajanje `joinAnd` (`i18n/index.ts`) "a, b and c" / "a, b i c"; `fmtDecimal` "4.3" / "4,3". U oba
    jezika: vreme 24h "09:15" (`fmtClock`), trajanje "4h 45m" (`fmtDuration`), procenat "73%" (`fmtPercent`).

## 8. Podaci u komponentama
- `useScheduleData()` → kategorije, šabloni, mapiranje, podešavanja (App garantuje da su učitani).
- Posle mutacije rasporeda: `scheduleStore.set(payload)`.
- `useLogicalNow()` → `{ date, minute }` (osvežava se na 30s i pri povratku u aplikaciju).
- Greške: `toast.error(errorMessage(e))`. Opasne akcije: `await confirmDialog({ title, body, confirmText, danger: true })`.
- Navigacija: `navigate(paths.day(date))`, `<Link to={paths.progress}>`.
