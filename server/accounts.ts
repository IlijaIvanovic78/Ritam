// Nalozi u bazi: korisnici, preuzimanje podataka iz verzije bez naloga i refresh tokeni (rotacija,
// opoziv familije, čišćenje). Kriptografija je u auth.ts, HTTP u authRoutes.ts.

import type { DatabaseSync, StatementSync } from 'node:sqlite';
import type { AuthUser, Lang } from '../shared/types.ts';
import { hashRefreshToken, newFamilyId, newRefreshToken } from './auth.ts';
import { statementCache, tx } from './db.ts';
import { DEFAULT_SETTINGS } from './defaults.ts';
import { Repo, parseSettings } from './repo.ts';
import { HttpError, num, str } from './util.ts';

export interface StoredUser extends AuthUser {
  passwordHash: string;
}

export type RotateResult =
  | { ok: true; user: AuthUser; token: string }
  | {
      ok: false;
      /** refresh_race = drugi tab je ovaj token upravo zamenio (kolačić u browseru je već nov). */
      code: 'invalid_refresh' | 'refresh_race';
      /** false samo za refresh_race: odgovor ne sme da obriše nov kolačić koji je postavio drugi zahtev. */
      clearCookie: boolean;
    };

export interface AccountsOptions {
  refreshTtlSec: number;
  /** Opozvan token pokazan u ovom roku posle rotacije = trka između tabova, ne krađa. */
  raceGraceSec: number;
}

/** Tabele sa user_id; redovi sa 0 su podaci iz verzije bez naloga ("bez vlasnika"). */
const OWNED_TABLES = ['categories', 'templates', 'tasks', 'weekday_templates', 'days'] as const;

const CLEANUP_EVERY_MS = 10 * 60 * 1000;

export class Accounts {
  db: DatabaseSync;
  q: (sql: string) => StatementSync;
  opts: AccountsOptions;
  private lastCleanup = 0;

  constructor(db: DatabaseSync, opts: AccountsOptions, q: (sql: string) => StatementSync = statementCache(db)) {
    this.db = db;
    this.opts = opts;
    this.q = q;
  }

  // ---- Korisnici ----

  userIds(): number[] {
    return this.q('SELECT id FROM users ORDER BY id')
      .all()
      .map((r) => num(r.id));
  }

  exists(id: number): boolean {
    return !!this.q('SELECT 1 FROM users WHERE id = ?').get(id);
  }

  getUser(id: number): AuthUser | undefined {
    const r = this.q('SELECT id, email FROM users WHERE id = ?').get(id);
    return r ? { id: num(r.id), email: str(r.email) } : undefined;
  }

  findById(id: number): StoredUser | undefined {
    const r = this.q('SELECT id, email, password_hash FROM users WHERE id = ?').get(id);
    return r ? { id: num(r.id), email: str(r.email), passwordHash: str(r.password_hash) } : undefined;
  }

  /** `email` je već normalizovan (normalizeEmail). */
  findByEmail(email: string): StoredUser | undefined {
    const r = this.q('SELECT id, email, password_hash FROM users WHERE email = ?').get(email);
    return r ? { id: num(r.id), email: str(r.email), passwordHash: str(r.password_hash) } : undefined;
  }

  /** Nalog koji je pri registraciji preuzeo podatke iz verzije bez naloga (meta 'legacy_owner'), ili null. */
  legacyOwnerId(): number | null {
    const v = this.q(`SELECT value FROM meta WHERE key = 'legacy_owner'`).get()?.value;
    const id = Number(v);
    return v != null && Number.isInteger(id) && id > 0 ? id : null;
  }

  /** Korisnik kako ga vidi klijent (odgovori naloga): uz `legacyOwner: true` za nalog iz legacyOwnerId. */
  publicUser(user: AuthUser): AuthUser {
    const base: AuthUser = { id: user.id, email: user.email };
    return this.legacyOwnerId() === user.id ? { ...base, legacyOwner: true } : base;
  }

  /** Postoje li podaci bez vlasnika (baza iz verzije pre naloga) — samo za log. */
  hasUnclaimedData(): boolean {
    return ['categories', 'templates', 'tasks', 'days'].some((t) => !!this.q(`SELECT 1 FROM ${t} WHERE user_id = 0 LIMIT 1`).get());
  }

  /**
   * Pravi nalog. PRVI nalog (tabela users je bila prazna) u istoj transakciji preuzima sve podatke bez
   * vlasnika (user_id 0: baza iz verzije bez naloga, ili 7 praznih dana u nedelji nove baze) i podešavanja iz
   * meta 'settings' — ništa se ne briše ni ne kopira, redovi samo dobijaju vlasnika. Svaki sledeći nalog
   * počinje prazan (7 dana u nedelji bez šablona, podrazumevana podešavanja). 409 ako email već postoji.
   */
  /**
   * `adopted` = prvi nalog je preuzeo podatke (dane, zadatke, raspored) iz verzije bez naloga. `lang` = jezik
   * interfejsa novog naloga (izbor sa ekrana prijave ili jezik zahteva), i za prvi nalog.
   */
  createUser(email: string, passwordHash: string, lang: Lang): { user: AuthUser; adopted: boolean } {
    try {
      return tx(this.db, () => {
        if (this.findByEmail(email)) throw new HttpError(409, 'auth.emailTaken');
        const first = !this.q('SELECT 1 FROM users LIMIT 1').get();
        const hadData = first && this.hasUnclaimedData();
        const settings = {
          ...(first
            ? parseSettings(strOrUndefined(this.q(`SELECT value FROM meta WHERE key = 'settings'`).get()?.value))
            : DEFAULT_SETTINGS),
          lang,
        };
        const id = Number(
          this.q('INSERT INTO users (email, password_hash, settings, created_at) VALUES (?, ?, ?, ?)').run(
            email,
            passwordHash,
            JSON.stringify(settings),
            new Date().toISOString(),
          ).lastInsertRowid,
        );
        if (first) {
          // Blokovi prate svoj dan: FOREIGN KEY (user_id, date) … ON UPDATE CASCADE.
          for (const t of OWNED_TABLES) this.db.prepare(`UPDATE ${t} SET user_id = ? WHERE user_id = 0`).run(id);
          // Ovaj nalog je preuzeo podatke verzije bez naloga: samo njemu klijent daje i draftove beleški iz te
          // verzije (`ritam.note.<datum>` na uređaju) — `legacyOwner: true` uz korisnika (publicUser).
          if (hadData) {
            this.q(`INSERT OR REPLACE INTO meta (key, value) VALUES ('legacy_owner', ?)`).run(String(id));
          }
          // Isto pravilo kao pri pokretanju (no-op za podatke koje je prethodna verzija već normalizovala).
          new Repo(this.db, id, this.q).normalizeTemplateBlocks(settings.dayStart);
        } else {
          const ins = this.q('INSERT INTO weekday_templates (user_id, weekday, template_id) VALUES (?, ?, NULL)');
          for (let wd = 1; wd <= 7; wd++) ins.run(id, wd);
        }
        return { user: { id, email }, adopted: hadData };
      });
    } catch (err) {
      // Dve istovremene registracije istog emaila: druga pada na UNIQUE.
      if (err instanceof Error && /UNIQUE constraint failed: users\.email/.test(err.message)) {
        throw new HttpError(409, 'auth.emailTaken');
      }
      throw err;
    }
  }

  setPasswordHash(uid: number, passwordHash: string): void {
    this.q('UPDATE users SET password_hash = ? WHERE id = ?').run(passwordHash, uid);
  }

  // ---- Refresh tokeni ----

  /** Nov refresh token u familiji (nova prijava = nova familija). Vraća token (u bazi je samo heš). */
  issueRefresh(uid: number, family: string = newFamilyId(), userAgent: string | null = null, nowMs = Date.now()): string {
    const token = newRefreshToken();
    this.q(
      `INSERT INTO refresh_tokens (user_id, family, token_hash, created_at, expires_at, revoked_at, user_agent)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`,
    ).run(
      uid,
      family,
      hashRefreshToken(token),
      new Date(nowMs).toISOString(),
      new Date(nowMs + this.opts.refreshTtlSec * 1000).toISOString(),
      userAgent,
    );
    return token;
  }

  /**
   * Rotacija: važeći token se opoziva i izdaje se nov u istoj familiji. Opozvan token:
   * - familija više nema aktivan token (odjava, promena lozinke, ranije otkrivena krađa) → invalid_refresh;
   * - opozvan rotacijom pre manje od `raceGraceSec` → refresh_race (dva taba su istovremeno obnavljala sesiju),
   *   bez ikakve izmene;
   * - inače neko koristi stari token (krađa) → opoziva se cela familija → invalid_refresh.
   * Istekao ili nepoznat token → invalid_refresh.
   */
  rotateRefresh(token: string, userAgent: string | null, nowMs = Date.now()): RotateResult {
    return tx(this.db, () => {
      const invalid = { ok: false, code: 'invalid_refresh', clearCookie: true } as const;
      const nowIso = new Date(nowMs).toISOString();
      const row = this.q('SELECT id, user_id, family, expires_at, revoked_at FROM refresh_tokens WHERE token_hash = ?').get(
        hashRefreshToken(token),
      );
      if (!row) return invalid;
      const family = str(row.family);
      const uid = num(row.user_id);
      if (row.revoked_at != null) {
        const active = this.q(
          'SELECT 1 FROM refresh_tokens WHERE family = ? AND revoked_at IS NULL AND expires_at > ? LIMIT 1',
        ).get(family, nowIso);
        if (!active) return invalid;
        if (nowMs - Date.parse(str(row.revoked_at)) < this.opts.raceGraceSec * 1000) {
          return { ok: false, code: 'refresh_race', clearCookie: false } as const;
        }
        this.revokeFamily(family, nowIso);
        console.warn(`Ritam: ponovo upotrebljen zamenjen refresh token — sesija tog uređaja je opozvana (nalog ${uid}).`);
        return invalid;
      }
      if (str(row.expires_at) <= nowIso) return invalid;
      const user = this.getUser(uid);
      if (!user) return invalid;
      this.q('UPDATE refresh_tokens SET revoked_at = ? WHERE id = ?').run(nowIso, num(row.id));
      return { ok: true, user, token: this.issueRefresh(uid, family, userAgent, nowMs) } as const;
    });
  }

  private revokeFamily(family: string, nowIso: string): void {
    this.q('UPDATE refresh_tokens SET revoked_at = ? WHERE family = ? AND revoked_at IS NULL').run(nowIso, family);
  }

  /** Odjava: opoziva familiju kojoj token pripada (nepoznat token se ignoriše). */
  revokeByToken(token: string, nowMs = Date.now()): void {
    const row = this.q('SELECT family FROM refresh_tokens WHERE token_hash = ?').get(hashRefreshToken(token));
    if (row) this.revokeFamily(str(row.family), new Date(nowMs).toISOString());
  }

  /** Promena lozinke: odjavljuje sve uređaje korisnika. */
  revokeAllForUser(uid: number, nowMs = Date.now()): void {
    this.q('UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL').run(
      new Date(nowMs).toISOString(),
      uid,
    );
  }

  /**
   * Briše istekle tokene (najviše jednom u 10 min). Opozvani tokeni ostaju do isteka: pokazan stari token
   * (krađa) tako i kasnije opoziva svoju familiju.
   */
  cleanup(nowMs = Date.now()): void {
    if (nowMs - this.lastCleanup < CLEANUP_EVERY_MS) return;
    this.lastCleanup = nowMs;
    this.q('DELETE FROM refresh_tokens WHERE expires_at <= ?').run(new Date(nowMs).toISOString());
  }
}

function strOrUndefined(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
