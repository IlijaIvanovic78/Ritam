// Sklapanje Hono aplikacije: bezbednosni headeri, API, statika sa SPA fallback-om i greške.

import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { serveStatic } from '@hono/node-server/serve-static';
import { createApi } from './api.ts';
import type { ApiDeps } from './api.ts';
import { HttpError, isHttps } from './util.ts';

export interface AppOptions extends Omit<ApiDeps, 'build'> {
  /** Apsolutna putanja do build-a weba; null = samo API (razvoj preko Vite-a). */
  staticDir: string | null;
}

/**
 * Glavni JS fajl build-a iz `index.html` ("/assets/index-….js"). Čita se jednom, pri pokretanju:
 * novi deploy = novi proces. Isti `src` klijent čita iz svog `<script type="module">` (lib/pwa.ts).
 */
export function readBuildId(staticDir: string): string | undefined {
  try {
    const html = readFileSync(join(staticDir, 'index.html'), 'utf8');
    return /<script type="module"[^>]*\ssrc="(\/assets\/[^"]+)"/.exec(html)?.[1];
  } catch {
    return undefined;
  }
}

const CSP = [
  "default-src 'self'",
  "img-src 'self' data:",
  "style-src 'self' 'unsafe-inline'",
  "script-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "worker-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': CSP,
};

const IMMUTABLE = 'public, max-age=31536000, immutable';
/** Fajlovi koji moraju uvek da se proveravaju (nova verzija aplikacije). */
const NO_CACHE_PATHS = new Set(['/', '/index.html', '/sw.js', '/manifest.webmanifest']);

export function createApp(opts: AppOptions): Hono {
  const app = new Hono();

  // Bezbednosni headeri na svakom odgovoru (i na greškama — onError je unutar ovog lanca).
  app.use('*', async (c, next) => {
    await next();
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) c.header(k, v);
    // Preko HTTPS-a (Caddy, Railway): browser ubuduće ne pokušava običan HTTP za ovaj domen.
    if (isHttps(c)) c.header('Strict-Transport-Security', 'max-age=31536000');
    if (c.req.path.startsWith('/api/')) c.header('Cache-Control', 'no-store');
  });

  app.route('/api', createApi({ ...opts, build: opts.staticDir ? readBuildId(opts.staticDir) : undefined }));

  if (opts.staticDir) {
    const root = opts.staticDir;

    // Keširanje statike: heširani /assets/* zauvek, HTML/sw/manifest uvek proveri, ostalo kratko.
    app.use('*', async (c, next) => {
      await next();
      const p = c.req.path;
      const ok = c.res.status === 200 || c.res.status === 206;
      const isHtml = (c.res.headers.get('Content-Type') ?? '').startsWith('text/html');
      let cc: string;
      if (!ok) cc = 'no-store';
      else if (NO_CACHE_PATHS.has(p) || isHtml) cc = 'no-cache';
      else if (p.startsWith('/assets/')) cc = IMMUTABLE;
      else cc = 'public, max-age=86400';
      c.header('Cache-Control', cc);
    });

    app.get('*', serveStatic({ root }));

    // SPA fallback: svaka GET putanja koja nije fajl dobija index.html (ruter je na klijentu).
    app.get('*', async (c) => {
      // Nedostajući heširani fajl (stara verzija) ne sme da postane HTML.
      if (c.req.path.startsWith('/assets/')) return c.text('Ne postoji.', 404);
      try {
        return c.html(await readFile(join(root, 'index.html'), 'utf8'));
      } catch {
        return c.text('Ne postoji.', 404);
      }
    });
  } else {
    app.get('/', (c) =>
      c.text(
        'Ritam API radi. Web build (dist/web) ne postoji — za razvoj pokreni "npm run dev" i otvori http://localhost:5173, ' +
          'ili napravi build sa "npm run build".\n',
      ),
    );
  }

  app.notFound((c) =>
    c.req.path.startsWith('/api/') ? c.json({ error: 'Ne postoji.' }, 404) : c.text('Ne postoji.', 404),
  );

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    if (err instanceof HTTPException) {
      if (err.status === 413) return c.json({ error: 'Zahtev je prevelik.' }, 413);
      return c.json({ error: err.message || 'Zahtev nije uspeo.' }, err.status);
    }
    console.error('Greška u zahtevu', c.req.method, c.req.path, err);
    return c.json({ error: 'Greška na serveru. Pokušaj ponovo.' }, 500);
  });

  return app;
}
