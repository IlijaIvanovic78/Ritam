/* Ritam service worker — ručno pisan, bez biblioteka.
 *
 * Strategije:
 *   /api/*        mreža prvo; uspešan GET odgovor se čuva u API kešu, bez mreže (ili kad
 *                 proksi javi 502–504) vraća se keširana kopija (sa headerom X-Ritam-Cached: 1,
 *                 da aplikacija zna da podaci možda nisu sveži) ili 503 JSON. Ako postoji kopija,
 *                 a mreža ne odgovori za API_TIMEOUT_MS (slab signal), odmah kopija; odgovor mreže
 *                 kad stigne samo osveži keš.
 *                 /api/auth/*, /api/export i /api/health se nikad ne keširaju (health je provera
 *                 nove verzije: kopija iz keša bi pogrešno javila da je server i dalje na staroj).
 *                 Nalozi: kopija pripada nalogu iz headera X-Ritam-User zahteva (aplikacija ga šalje
 *                 uz svaki GET; zahtev bez njega ide samo na mrežu) i vraća se samo zahtevu istog
 *                 naloga. Ključ u kešu je samo URL — Authorization (Bearer token) se nikad ne upisuje.
 *                 Aplikacija briše ceo API keš pri odjavi i kad se na uređaju prijavi drugi nalog;
 *                 odgovor GET zahteva koji je tada još bio u toku se više ne upisuje.
 *   navigacija    mreža prvo (svaka stranica je index.html), bez mreže keširani '/'. Ako mreža
 *                 ne odgovori za NAV_TIMEOUT_MS (slab signal), odmah keširani '/', a odgovor
 *                 mreže kad stigne samo osveži keš.
 *                 'Osveži' (nova verzija) pre ponovnog učitavanja šalje poruku 'refresh-shell':
 *                 keširani '/' se odmah osveži sa mreže, pa i spora navigacija dobija novi build.
 *   /assets/*     keš prvo (Vite fajlovi imaju heš u imenu i nikad se ne menjaju).
 *   ostalo        stale-while-revalidate (manifest, ikonice, favicon).
 *
 * Keš je samo pomoć: greška keša (pun disk, oštećen keš) nikad ne obara odgovor mreže.
 *
 * Kad menjaš ovaj fajl ili listu PRECACHE, povećaj VERSION — stari keševi statike se brišu pri
 * aktivaciji. API keš ima stalno ime (podaci za rad bez mreže preživljavaju novu verziju);
 * isto ime koristi i aplikacija (web/src/lib/pwa.ts), koja u njega upisuje odgovore izmena.
 */

const VERSION = 'v10';
const STATIC_CACHE = `ritam-static-${VERSION}`;
const ASSET_CACHE = `ritam-assets-${VERSION}`;
const API_CACHE = 'ritam-api';
const CURRENT = [STATIC_CACHE, ASSET_CACHE, API_CACHE];

/** Ikonice i manifest: poželjni, ali instalacija ne pada bez njih. */
const PRECACHE_OPTIONAL = [
  '/manifest.webmanifest',
  '/favicon.svg',
  '/theme-init.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/maskable-512.png',
  '/icons/apple-touch-icon.png',
];

/** API putanje koje se nikad ne čuvaju (prijava, izvoz cele baze, provera nove verzije). */
const NO_STORE = [/^\/api\/auth\//, /^\/api\/export\/?$/, /^\/api\/health\/?$/];

/** Koliko navigacija čeka mrežu pre nego što pokaže keširanu aplikaciju. */
const NAV_TIMEOUT_MS = 3500;
/** Koliko API zahtev čeka mrežu pre nego što vrati keširanu kopiju (samo ako kopija postoji). */
const API_TIMEOUT_MS = 4000;
/**
 * Kad mreža upravo nije stigla na vreme (slab signal, proksi koji visi), sledeći zahtevi sa kopijom
 * čekaju kraće — inače bi se roks sabirali (stranica, pa raspored, pa dan). Čim zakasneli odgovor
 * ipak stigne (mreža je spora, ali radi), zahtevi ponovo čekaju ceo rok.
 */
const API_TIMEOUT_SLOW_MS = 800;
const SLOW_WINDOW_MS = 30_000;
let slowUntil = 0;

/** Ograničenja broja stavki da keš ne raste bez kraja. */
const MAX_ASSETS = 80;
const MAX_API = 300;

/**
 * Kad je aplikacija poslednji put obrisala API keš (odjava, drugi nalog). Odgovor zahteva započetog pre
 * toga ne sme ponovo da napravi keš sa podacima odjavljenog naloga.
 */
let apiClearedAt = 0;

// ---- Instalacija: '/', njegovi /assets/* fajlovi i ikonice ----
//
// '/' i njegovi JS/CSS fajlovi moraju da stignu sa mreže, inače instalacija ne uspeva: stara
// verzija (i njen keš za rad bez mreže) ostaje, a browser pokušava ponovo pri sledećoj proveri.
// Upis u keš je i ovde samo pokušaj (pun disk ne sme da zaglavi staru verziju zauvek).

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await openCache(STATIC_CACHE);
      const res = await fetch(new Request('/', { cache: 'reload' }));
      if (!res.ok || !isHtml(res)) throw new Error(`Instalacija: '/' vratio ${res.status}`);
      await cacheAssetsFromHtml(await res.clone().text());
      await safePut(cache, '/', res);
      await Promise.all(
        PRECACHE_OPTIONAL.map(async (url) => {
          try {
            const r = await fetch(new Request(url, { cache: 'reload' }));
            if (isCacheable(r)) await safePut(cache, url, r);
          } catch {
            // nema mreže ili fajla — biće keširan kasnije
          }
        }),
      );
      await self.skipWaiting();
    })(),
  );
});

/**
 * Prvo učitavanje stranice ide pre nego što SW postoji, pa JS/CSS iz index.html
 * nisu u kešu. Pročitaj ih iz HTML-a i keširaj, da aplikacija radi i bez mreže.
 * Baca grešku ako neki fajl ne stigne sa mreže (vidi instalaciju).
 *
 * Fontovi naslova (.woff2) se ne pominju u HTML-u nego u CSS-u (url(/assets/…)); i oni idu u keš,
 * da naslovi i bez mreže budu u svom pismu. Font je poželjan, ne obavezan: ako ne stigne,
 * instalacija ipak uspeva (naslov tada koristi rezervni serif, a font se kešira pri prvoj upotrebi).
 */
async function cacheAssetsFromHtml(html) {
  const urls = new Set();
  for (const m of html.matchAll(/(?:src|href)="(\/assets\/[^"?#]+)"/g)) urls.add(m[1]);
  if (urls.size === 0) return;
  const cache = await openCache(ASSET_CACHE);
  const fonts = new Set();
  await Promise.all(
    [...urls].map(async (url) => {
      let res = await safeMatch(cache, url);
      if (!res) {
        res = await fetch(url);
        if (!isCacheable(res)) throw new Error(`Instalacija: ${url} vratio ${res.status}`);
        await safePut(cache, url, res.clone());
      }
      if (url.endsWith('.css')) {
        const css = await res.text().catch(() => '');
        for (const m of css.matchAll(/url\(["']?(\/assets\/[^"')?#]+\.woff2)/g)) fonts.add(m[1]);
      }
    }),
  );
  await Promise.all(
    [...fonts].map(async (url) => {
      try {
        if (await safeMatch(cache, url)) return;
        const res = await fetch(url);
        if (isCacheable(res)) await safePut(cache, url, res);
      } catch {
        // nema mreže — font se kešira pri prvoj upotrebi (cacheFirst)
      }
    }),
  );
}

// ---- Aktivacija: obriši keševe starih verzija ----

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const names = await caches.keys();
        await Promise.all(
          names.filter((n) => n.startsWith('ritam-') && !CURRENT.includes(n)).map((n) => caches.delete(n)),
        );
      } catch {
        // keš nije dostupan — nema šta da se briše
      }
      await self.clients.claim();
    })(),
  );
});

// ---- Poruke iz aplikacije ----

self.addEventListener('message', (event) => {
  const data = event.data;
  if (data && data.type === 'clear-api-cache') {
    apiClearedAt = Date.now();
    event.waitUntil(caches.delete(API_CACHE).catch(() => {}));
  }
  // "Osveži" (nova verzija aplikacije): verzija koja čeka preuzima stranicu pre ponovnog učitavanja.
  // Instalacija ionako zove skipWaiting(), pa je ovo samo rezerva.
  if (data && data.type === 'skip-waiting') {
    event.waitUntil(self.skipWaiting());
  }
  // "Osveži": pre ponovnog učitavanja keširani '/' postaje nova verzija sa mreže. Inače bi na sporoj
  // mreži navigacija posle NAV_TIMEOUT_MS dobila keširani '/', a to je (kad se sw.js nije menjao)
  // i dalje stari build. Odgovor { ok } ide na port poruke; stranica se učitava i kad ovo ne uspe.
  if (data && data.type === 'refresh-shell') {
    const port = event.ports && event.ports[0];
    event.waitUntil(
      (async () => {
        let ok = false;
        try {
          const cache = await openCache(STATIC_CACHE);
          const res = await fetch(new Request('/', { cache: 'no-store' }));
          if (cache && res.ok && isHtml(res)) {
            await safePut(cache, '/', res);
            ok = true;
          }
        } catch {
          // nema mreže — stranica se ipak učitava (mreža prvo)
        }
        if (port) port.postMessage({ ok });
      })(),
    );
  }
});

// ---- Zahtevi ----

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith('/api/')) {
    // Prijava, izvoz i provera verzije idu direktno na mrežu, bez SW-a.
    if (NO_STORE.some((re) => re.test(url.pathname))) return;
    event.respondWith(apiNetworkFirst(req, event));
    return;
  }

  if (req.mode === 'navigate') {
    event.respondWith(navigationNetworkFirst(req, event));
    return;
  }

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirst(req));
    return;
  }

  // Sam sw.js browser uvek proverava mimo SW-a; ostalo je statika iz public/.
  event.respondWith(staleWhileRevalidate(req, event));
});

// ---- Keš kao pomoć: nijedna greška keša ne sme da obori odgovor ----

/** Otvoren keš ili null (Cache Storage nedostupan / oštećen). */
async function openCache(name) {
  try {
    return await caches.open(name);
  } catch {
    return null;
  }
}

async function safeMatch(cache, req, opts) {
  if (!cache) return null;
  try {
    return (await cache.match(req, opts)) || null;
  } catch {
    return null;
  }
}

async function safePut(cache, req, res) {
  if (!cache) return;
  try {
    await cache.put(req, res);
  } catch {
    // pun disk (QuotaExceededError) ili oštećen keš — odgovor mreže i dalje važi
  }
}

/**
 * Server za nepostojeće fajlove vraća index.html (SPA). Takav odgovor ne sme
 * da završi u kešu pod imenom .js/.png fajla.
 */
function isCacheable(res) {
  if (!res || !res.ok || res.type === 'opaque') return false;
  return !isHtml(res);
}

function isHtml(res) {
  return (res.headers.get('content-type') || '').includes('text/html');
}

/** Keširan API odgovor označen kao takav (aplikacija prikaže da server nije dostupan). */
function markStale(res) {
  const headers = new Headers(res.headers);
  headers.set('X-Ritam-Cached', '1');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

function offlineJson() {
  return new Response(JSON.stringify({ error: 'Nema konekcije sa serverom.' }), {
    status: 503,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function offlineHtml() {
  const html =
    '<!doctype html><html lang="sr-Latn"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="color-scheme" content="dark">' +
    '<title>Ritam</title></head>' +
    '<body style="font-family:system-ui,sans-serif;padding:48px 16px;text-align:center;color:#a3a3a0;background:#0a0a0a">' +
    '<p>Nema konekcije sa serverom.</p><p>Otvori Ritam ponovo kad budeš na mreži.</p></body></html>';
  return new Response(html, {
    status: 503,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/** Zadrži samo poslednjih `max` stavki (keys() vraća redosled upisa). Nikad ne baca grešku. */
async function trimCache(name, max) {
  try {
    const cache = await caches.open(name);
    const keys = await cache.keys();
    if (keys.length <= max) return;
    await Promise.all(keys.slice(0, keys.length - max).map((k) => cache.delete(k)));
  } catch {
    // keš nije dostupan
  }
}

/** Proksi ispred servera javlja da server ne radi (npr. kontejner se restartuje). */
function isGatewayError(res) {
  return res.status === 502 || res.status === 503 || res.status === 504;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(() => resolve(null), ms));
}

/** Nalog kome pripada zahtev (header X-Ritam-User koji šalje aplikacija); '' = nepoznat. */
function requestUser(req) {
  const u = req.headers.get('X-Ritam-User') || '';
  return /^\d{1,15}$/.test(u) ? u : '';
}

/** Kopija iz API keša, samo ako pripada istom nalogu (kopija bez oznake naloga se nikad ne vraća). */
async function matchForUser(cache, key, user) {
  if (!user) return null;
  const hit = await safeMatch(cache, key, { ignoreVary: true });
  return hit && hit.headers.get('X-Ritam-User') === user ? hit : null;
}

/** Odgovor mreže sa oznakom naloga, za upis u API keš. */
function tagUser(res, user) {
  const headers = new Headers(res.headers);
  headers.set('X-Ritam-User', user);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

/**
 * Upiši odgovor mreže u API keš, osim ako je aplikacija u međuvremenu upisala noviji odgovor
 * izmene (header X-Ritam-Stored, vidi storeOfflineCopy u web/src/lib/pwa.ts) — kasan odgovor GET
 * zahteva poslatog pre te izmene je stariji od nje. Kopija drugog naloga pod istim URL-om se
 * prepisuje (drugi nalog ionako ne sme da je vidi). Ništa, ako je keš obrisan posle početka zahteva.
 */
async function putUnlessNewer(cache, key, user, res, startedAt) {
  if (startedAt <= apiClearedAt) return;
  const cur = await matchForUser(cache, key, user);
  const stored = Number(cur?.headers.get('X-Ritam-Stored') || 0);
  if (stored > startedAt) return;
  await safePut(cache, key, tagUser(res, user));
  await trimCache(API_CACHE, MAX_API);
}

async function apiNetworkFirst(req, event) {
  const startedAt = Date.now();
  const user = requestUser(req);
  // Bez oznake naloga nema ni kopije: samo mreža (Authorization prolazi nepromenjen).
  const cache = user ? await openCache(API_CACHE) : null;
  // Ključ je samo URL: token iz Authorization headera se ne upisuje na disk.
  const key = req.url;
  const network = fetch(req).then(
    (res) => {
      if (res.ok && cache) {
        // Upis u keš ne usporava odgovor, ali SW ostaje živ dok se ne završi.
        event.waitUntil(putUnlessNewer(cache, key, user, res.clone(), startedAt));
      }
      return res;
    },
    () => null,
  );
  event.waitUntil(network);

  const hit = await matchForUser(cache, key, user);
  // Bez kopije nema šta drugo da se pokaže — čeka se mreža (rok drži aplikacija).
  let res;
  if (hit) {
    const late = Symbol('late');
    const wait = Date.now() < slowUntil ? API_TIMEOUT_SLOW_MS : API_TIMEOUT_MS;
    res = await Promise.race([network, delay(wait).then(() => late)]);
    if (res === late) {
      slowUntil = Date.now() + SLOW_WINDOW_MS;
      // Odgovor koji ipak stigne znači da je mreža spora, ali radi: sledeći zahtev ponovo čeka
      // ceo rok (inače bi na vezi sporijoj od 0,8 s svaki odgovor bio kopija iz keša).
      network.then((r) => {
        if (r && !isGatewayError(r)) slowUntil = 0;
      });
      return markStale(hit);
    }
    if (res) slowUntil = 0;
  } else {
    res = await network;
  }
  if (!res) return hit ? markStale(hit) : offlineJson(); // nema mreže
  if (isGatewayError(res) && hit) return markStale(hit);
  return res;
}

async function navigationNetworkFirst(req, event) {
  const cache = await openCache(STATIC_CACHE);
  // Svaka ruta vraća isti index.html — čuvaj poslednju verziju pod '/'.
  const network = fetch(req).then(async (res) => {
    if (res.ok && isHtml(res)) await safePut(cache, '/', res.clone());
    return res;
  });
  // Odgovor mreže koji stigne posle isteka roka i dalje osveži keš.
  event.waitUntil(network.catch(() => {}));

  const cached = await safeMatch(cache, '/');
  let res;
  try {
    res = cached ? await Promise.race([network, delay(NAV_TIMEOUT_MS)]) : await network;
  } catch {
    return cached || offlineHtml();
  }
  if (!res) {
    // mreža nije stigla na vreme — i API zahtevi odmah posle ovoga čekaju kraće, dok mreža
    // ipak ne odgovori (spora, ali radi)
    slowUntil = Date.now() + SLOW_WINDOW_MS;
    network.then(
      (r) => {
        if (r.ok) slowUntil = 0;
      },
      () => {},
    );
    return cached;
  }
  if (isGatewayError(res)) return cached || res;
  return res;
}

async function cacheFirst(req) {
  const cache = await openCache(ASSET_CACHE);
  const hit = await safeMatch(cache, req);
  if (hit) return hit;
  const res = await fetch(req);
  if (cache && isCacheable(res)) {
    await safePut(cache, req, res.clone());
    void trimCache(ASSET_CACHE, MAX_ASSETS);
  }
  return res;
}

async function staleWhileRevalidate(req, event) {
  const cache = await openCache(STATIC_CACHE);
  const hit = await safeMatch(cache, req);
  const network = fetch(req)
    .then(async (res) => {
      if (isCacheable(res)) await safePut(cache, req, res.clone());
      return res;
    })
    .catch(() => null);
  if (hit) {
    event.waitUntil(network);
    return hit;
  }
  return (await network) || Response.error();
}
