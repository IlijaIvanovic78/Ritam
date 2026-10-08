// Jedan zajednički red zahteva: dani (useDay, beleške, podsetnik za juče) i dani u nedelji
// (WeekdaysCard). Zahtevi idu jedan po jedan, pa odgovor kasnije poslatog zahteva uvek sadrži i efekat
// ranijih. "Osveži" (lib/pwa.ts) i odjava (lib/account.ts) čekaju prazan red (whenQueueIdle), da
// izmena koja još čeka u redu ne propadne.

const noop = () => {};

let chain: Promise<unknown> = Promise.resolve();
let pending = 0;

/** Stavi zahtev u red; sledeći kreće tek kad se prethodni završi (uspešno ili ne). */
export function enqueue<T>(fn: () => Promise<T>): Promise<T> {
  pending += 1;
  const p = chain.then(fn);
  const settled = p.then(noop, noop).then(() => {
    pending -= 1;
  });
  chain = settled;
  return p;
}

/** Broj zahteva koji čekaju ili su u toku. */
export function queuePending(): number {
  return pending;
}

/** Razreši se kad u redu više nema ničega (i kad se u međuvremenu dodaju novi zahtevi). */
export async function whenQueueIdle(): Promise<void> {
  for (;;) {
    const c = chain;
    await c;
    if (c === chain && pending === 0) return;
  }
}
