// Početno stanje nove baze (SPEC, sekcija 4 "Prazan start"): bez kategorija i šablona —
// korisnik sam pravi svoje kategorije, šablone, dane u nedelji i početak dana.

import type { DatabaseSync } from 'node:sqlite';
import type { Settings } from '../shared/types.ts';

/** Podešavanja nove baze; i rezerva kad sačuvana podešavanja nedostaju ili nisu ispravna. */
export const DEFAULT_SETTINGS: Settings = { dayStart: 0, streakThreshold: 0.7 };

/**
 * Upisuje prazno početno stanje: svih 7 dana u nedelji bez šablona i podrazumevana podešavanja.
 * Poziva se samo za novu bazu (šema verzije 0), unutar transakcije migracije — postojeća baza
 * se nikad ne dira.
 */
export function initEmptyDatabase(db: DatabaseSync): void {
  const insWd = db.prepare('INSERT OR IGNORE INTO weekday_templates (weekday, template_id) VALUES (?, NULL)');
  for (let wd = 1; wd <= 7; wd++) insWd.run(wd);

  db.prepare(
    `INSERT INTO meta (key, value) VALUES ('settings', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(JSON.stringify(DEFAULT_SETTINGS));
}
