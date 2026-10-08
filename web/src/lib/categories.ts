// Nova kategorija napravljena u hodu (iz izbora kategorije u sheet-u bloka, zadatka ili šablona).

import type { Category, SchedulePayload } from '../../../shared/types.ts';
import { ApiError, api, isCachedPayload } from '../api.ts';
import { toast } from '../ui/index.ts';
import { nextFreeColor } from './palette.ts';
import { scheduleStore } from './store.ts';

const norm = (s: string) => s.trim().toLocaleLowerCase('sr');

/** Neobrisana kategorija sa tim nazivom (isto poređenje kao na serveru). */
const byName = (list: Category[], name: string) => list.find((c) => norm(c.name) === norm(name));

/** Id kategorije koja je u `after` nova (nije bila ni u izboru ni među obrisanima), ili po nazivu. */
function createdId(before: SchedulePayload | null, after: SchedulePayload, name: string): number | null {
  const known = new Set([...(before?.categories ?? []), ...(before?.archivedCategories ?? [])].map((c) => c.id));
  const fresh = after.categories.filter((c) => !known.has(c.id));
  return (byName(fresh, name) ?? fresh[0] ?? byName(after.categories, name))?.id ?? null;
}

/**
 * Napravi kategoriju sa datim nazivom i upiši odgovor u raspored. Boja je podrazumevano prva
 * slobodna iz palete, a kategorija se računa u ispunjenost. Vraća id nove kategorije. Greška
 * servera (npr. 409 "Kategorija sa tim nazivom već postoji.") se baca dalje, da je pozivalac
 * prikaže uz polje.
 *
 * `reuseExisting` (izbor kategorije u hodu, gde korisnik bira samo naziv): kategorija sa istim
 * nazivom koja već postoji — i ona koja je na serveru, a ovde je još nema (napravljena na drugom
 * uređaju, ili je zahtev kome je istekao rok ipak uspeo) — se samo izabere (`reused: true`).
 */
export async function createCategory(
  name: string,
  opts: { color?: string; counts?: boolean; reuseExisting?: boolean } = {},
): Promise<{ id: number | null; reused: boolean }> {
  const before = scheduleStore.get().data;
  if (opts.reuseExisting) {
    const known = byName(before?.categories ?? [], name);
    if (known) return { id: known.id, reused: true };
  }
  try {
    const payload = await api.addCategory({
      name: name.trim(),
      color: opts.color ?? nextFreeColor(before?.categories ?? [], before?.archivedCategories ?? []),
      counts: opts.counts ?? true,
    });
    scheduleStore.set(payload);
    return { id: createdId(before, payload, name), reused: false };
  } catch (e) {
    if (!opts.reuseExisting || !(e instanceof ApiError) || e.status !== 409) throw e;
    // Raspored ovde kasni: učitaj ga direktno (scheduleStore.refresh preskače dok se učitava i
    // ne prihvata kopiju iz keša), pa izaberi kategoriju sa tim nazivom.
    const fresh = await api.schedule().catch(() => null);
    if (!fresh || isCachedPayload(fresh)) throw e;
    scheduleStore.set(fresh);
    const found = byName(fresh.categories, name);
    if (!found) throw e;
    return { id: found.id, reused: true };
  }
}

/**
 * "+ Nova" u izboru kategorije (sheet bloka i zadatka): samo naziv, pa se kaže i da se nova
 * kategorija računa u ispunjenost (prekidač je u Rasporedu).
 */
export async function createInlineCategory(name: string): Promise<number | null> {
  const { id, reused } = await createCategory(name, { reuseExisting: true });
  toast(
    reused
      ? 'Kategorija sa tim nazivom već postoji — izabrana je ona.'
      : 'Kategorija je dodata i računa se u ispunjenost (menja se u Rasporedu).',
  );
  return id;
}
