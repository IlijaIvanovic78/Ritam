import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { fmtDateMedium } from '../../../../shared/time.ts';
import { useDebouncedCallback } from '../../lib/hooks.ts';
import {
  markNoteOpen,
  markNoteTyped,
  readNoteDraft,
  removeNoteDraft,
  writeNoteDraft,
  type NoteDraft,
} from '../../lib/noteDrafts.ts';
import { Card, RatingInput, TextArea, cx } from '../../ui/index.ts';
import type { NoteSaveResult } from './useDay.ts';

/** Koliko poslatih (još nepotvrđenih) tekstova pamtimo da bismo ih prepoznali u odgovoru servera. */
const SENT_MAX = 10;

/**
 * Beleške i misli + ocena dana. Komponenta se montira posebno za svaki datum (key = date),
 * pa se lokalni draft pri promeni dana resetuje, a nesačuvan tekst se pošalje pri unmount-u.
 *
 * `saved` = beleška sa servera nad kojom je draft pisan (šalje se kao `base`). Draft je "prljav"
 * kad se razlikuje od nje; tada se vrednost sa servera NE prepisuje preko onoga što korisnik kuca.
 * Ako server javi (ili osvežavanje pokaže) da je beleška u međuvremenu postala nešto treće (drugi
 * uređaj), ništa se ne šalje dok korisnik ne izabere: zadrži svoju ili uzmi tu verziju.
 *
 * Prljav draft se čuva i u localStorage-u: ako čuvanje ne uspe (nema mreže) pa se aplikacija
 * zatvori ili se pređe na drugi dan, tekst se vraća i šalje sledeći put. Neposlat tekst se šalje
 * ponovo i pri napuštanju, povratku u aplikaciju, kad se mreža vrati i kad server ponovo odgovori.
 */
export function NotesCard({
  date,
  note,
  fresh,
  settled,
  syncs,
  rating,
  otherDrafts,
  onSaveNote,
  onRate,
  onFocusNotes,
  onNeedFresh,
  onOpenDay,
}: {
  date: string;
  /** Beleška sa servera (poslednji primenjen odgovor). */
  note: string;
  /** `note` je stigla sa servera u ovom prikazu (ne iz keša). */
  fresh: boolean;
  /** Učitavanje dana je završeno (uspešno ili ne). */
  settled: boolean;
  /** Raste sa svakim svežim odgovorom servera za dan (server je ponovo dostupan). */
  syncs: number;
  rating: number | null;
  /** Drugi dani sa beleškom koja je ostala samo na ovom uređaju. */
  otherDrafts: string[];
  onSaveNote: (date: string, note: string, base: () => string | null, onSaved: () => void) => Promise<NoteSaveResult>;
  onRate: (rating: number | null) => void;
  onFocusNotes: () => void;
  /** Čuvanje čeka svež odgovor servera — zatraži ga (urgent = korisnik je kliknuo "Pokušaj ponovo"). */
  onNeedFresh: (urgent: boolean) => void;
  onOpenDay: (date: string) => void;
}) {
  const [draft, setDraft] = useState(note);
  const [saved, setSaved] = useState(note);
  const [inflight, setInflight] = useState(0);
  const [error, setErrorState] = useState(false);
  const errorRef = useRef(false);
  const setError = useCallback((v: boolean) => {
    errorRef.current = v;
    setErrorState(v);
  }, []);
  const [conflict, setConflict] = useState(false);
  const [touched, setTouched] = useState(false);
  // Nesačuvan tekst sa ovog uređaja iz ranije sesije (još nije vraćen u polje).
  const [stored, setStored] = useState<NoteDraft | null>(() => readNoteDraft(date));

  const draftRef = useRef(note);
  const savedRef = useRef(note);
  /** Poslednja beleška za koju se pouzdano zna da je na serveru (sveži odgovor ili naše čuvanje). */
  const serverRef = useRef<string | null>(fresh ? note : null);
  const inflightRef = useRef(0);
  const conflictRef = useRef(false);
  /** Tekst poslednjeg poslatog čuvanja. */
  const sentRef = useRef<string | null>(null);
  /** Poslati tekstovi: ako je zahtev istekao a ipak stigao do servera, to je i dalje naš tekst. */
  const sentTexts = useRef(new Set<string>());
  const scheduledRef = useRef(false);
  /** Čuvanje čeka prvi svež odgovor servera (do tada se ne zna nad čim se piše). */
  const waitFreshRef = useRef(false);
  const settledRef = useRef(settled);
  settledRef.current = settled;

  useEffect(() => markNoteOpen(date), [date]);

  const enterConflict = useCallback(() => {
    conflictRef.current = true;
    setConflict(true);
    setError(false);
  }, [setError]);

  const leaveConflict = useCallback(() => {
    conflictRef.current = false;
    setConflict(false);
  }, []);

  const save = useCallback(
    async (d: string, text: string) => {
      scheduledRef.current = false;
      // Beleška je promenjena na drugom uređaju: čeka se odluka korisnika.
      if (conflictRef.current) return;
      // Polje je popunjeno iz keša (nema servera ili još stiže): pošalji tek kad stigne sveža
      // beleška, da se ne piše preko izmene sa drugog uređaja.
      if (serverRef.current == null) {
        waitFreshRef.current = true;
        if (settledRef.current) setError(true);
        // Bez ovoga bi čuvanje čekalo sledeće povremeno osvežavanje (ili zauvek, dok traje kopija).
        onNeedFresh(false);
        return;
      }
      inflightRef.current += 1;
      sentRef.current = text;
      sentTexts.current.add(text);
      if (sentTexts.current.size > SENT_MAX) {
        const oldest = sentTexts.current.values().next().value;
        if (oldest !== undefined) sentTexts.current.delete(oldest);
      }
      setInflight((n) => n + 1);
      const res = await onSaveNote(
        d,
        text,
        () => {
          // Osvežavanje je već pokazalo da je server na nečem trećem — ne šalji naslepo.
          const server = serverRef.current;
          if (server != null && server !== savedRef.current && server !== text) return null;
          return savedRef.current;
        },
        () => {
          savedRef.current = text;
          serverRef.current = text;
          sentTexts.current.delete(text);
        },
      );
      inflightRef.current -= 1;
      setInflight((n) => n - 1);
      if (res === 'ok') {
        setSaved(savedRef.current);
        setError(false);
        if (text === draftRef.current) removeNoteDraft(d);
        else if (!conflictRef.current) {
          // U međuvremenu je dopisano: lokalna kopija sad nastaje nad upravo sačuvanim tekstom
          // (inače bi se posle zatvaranja aplikacije samo nudila, umesto da se sama vrati i pošalje).
          const s = readNoteDraft(d);
          if (s && s.text === draftRef.current && s.base !== text) writeNoteDraft(d, { base: text, text: s.text });
        }
      } else if (res === 'conflict') {
        enterConflict();
      } else {
        setError(true); // poruku o grešci već prikazuje toast iz useDay
      }
    },
    [onSaveNote, onNeedFresh, enterConflict, setError],
  );

  const { call: schedule, flush, cancel } = useDebouncedCallback(save, 700);

  /**
   * Pošalji ono što nije na serveru: zakazano čuvanje odmah, a posle neuspelog ponovo
   * (flush je tada prazan, jer je zakazani poziv već potrošen).
   */
  const saveIfDirty = useCallback(() => {
    if (conflictRef.current) return;
    if (scheduledRef.current) {
      flush();
      return;
    }
    const text = draftRef.current;
    if (text === savedRef.current) return;
    if (inflightRef.current > 0 && sentRef.current === text) return;
    void save(date, text);
  }, [flush, save, date]);
  const saveIfDirtyRef = useRef(saveIfDirty);
  saveIfDirtyRef.current = saveIfDirty;

  /** Vrati lokalno sačuvan tekst u polje (nad beleškom `base` sa servera) i zakaži čuvanje. */
  const applyStored = useCallback(
    (text: string, base: string) => {
      savedRef.current = base;
      setSaved(base);
      draftRef.current = text;
      setDraft(text);
      setTouched(true);
      setError(false);
      setStored(null);
      writeNoteDraft(date, { base, text });
      scheduledRef.current = true;
      schedule(date, text);
    },
    [date, schedule],
  );

  // Lokalna kopija iz ranije: ako je server i dalje na beleški nad kojom je pisana, vrati je
  // i sačuvaj. Ako se beleška u međuvremenu promenila (drugi uređaj), samo ponudi da se vrati.
  // Odluka se donosi tek po svežem odgovoru servera — kopija iz keša može biti stara.
  useLayoutEffect(() => {
    if (!stored || !fresh) return;
    if (stored.text === note) {
      removeNoteDraft(date);
      setStored(null);
    } else if (stored.base === note && draftRef.current === savedRef.current) {
      applyStored(stored.text, note);
    }
  }, [stored, note, fresh, date, applyStored]);

  // Nova vrednost sa servera (osvežavanje, drugi uređaj).
  useEffect(() => {
    if (fresh) serverRef.current = note;
    if (note === savedRef.current) return;
    if (note === draftRef.current) {
      // Server ima baš ovaj tekst (npr. čuvanje kome je istekao rok ipak je stiglo).
      cancel();
      scheduledRef.current = false;
      savedRef.current = note;
      setSaved(note);
      setError(false);
      if (conflictRef.current) leaveConflict();
      if (!stored) removeNoteDraft(date);
      return;
    }
    const clean = draftRef.current === savedRef.current && inflightRef.current === 0 && !scheduledRef.current;
    if (clean) {
      cancel();
      draftRef.current = note;
      savedRef.current = note;
      setDraft(note);
      setSaved(note);
      if (conflictRef.current) {
        leaveConflict();
        removeNoteDraft(date);
      }
      return;
    }
    if (!fresh) return;
    if (sentTexts.current.has(note)) {
      // Naš raniji tekst je na serveru (npr. čuvanje kome je istekao rok ipak je stiglo) — nastavi
      // nad njim. Sledeće čuvanje je zato možda dobilo 409 iako drugog uređaja nema: to nije sukob.
      savedRef.current = note;
      setSaved(note);
      const resume = conflictRef.current || errorRef.current;
      if (conflictRef.current) leaveConflict();
      setError(false);
      if (draftRef.current !== note) writeNoteDraft(date, { base: note, text: draftRef.current });
      // Ostatak teksta (dopisan posle tog čuvanja) se šalje odmah, ako je čuvanje ranije zapelo.
      if (resume) saveIfDirtyRef.current();
      return;
    }
    // Korisnik ima nesačuvane izmene, a beleška na serveru je u međuvremenu postala nešto treće.
    cancel();
    scheduledRef.current = false;
    enterConflict();
  }, [note, fresh, stored, date, cancel, enterConflict, leaveConflict, setError]);

  // Čuvanje koje je čekalo prvi svež odgovor servera (posle provere sukoba iznad).
  useEffect(() => {
    if (!fresh || !waitFreshRef.current) return;
    waitFreshRef.current = false;
    saveIfDirty();
  }, [fresh, note, saveIfDirty]);

  // Učitavanje nije uspelo (nema servera): čuvanje koje čeka se prikazuje kao nesačuvano.
  useEffect(() => {
    if (settled && !fresh && waitFreshRef.current) setError(true);
  }, [settled, fresh, setError]);

  // Server je ponovo odgovorio (svež odgovor za dan, npr. povremeno osvežavanje posle restarta
  // servera): pošalji ono čije čuvanje nije uspelo — mreža se nije menjala, pa 'online' ne stiže.
  const firstSync = useRef(true);
  useEffect(() => {
    if (firstSync.current) {
      firstSync.current = false;
      return;
    }
    const leftBehind =
      draftRef.current !== savedRef.current && !scheduledRef.current && inflightRef.current === 0;
    if (errorRef.current || leftBehind) saveIfDirtyRef.current();
  }, [syncs]);

  // Napuštanje stranice / prelazak u pozadinu: sačuvaj odmah. Povratak i povratak mreže:
  // pošalji ponovo ono što ranije nije prošlo.
  useEffect(() => {
    document.addEventListener('visibilitychange', saveIfDirty);
    window.addEventListener('pagehide', saveIfDirty);
    window.addEventListener('online', saveIfDirty);
    return () => {
      document.removeEventListener('visibilitychange', saveIfDirty);
      window.removeEventListener('pagehide', saveIfDirty);
      window.removeEventListener('online', saveIfDirty);
    };
  }, [saveIfDirty]);

  // Unmount (prelazak na drugi dan): pošalji i tekst čije čuvanje nije uspelo.
  useEffect(() => saveIfDirty, [saveIfDirty]);

  const onChange = (v: string) => {
    markNoteTyped();
    draftRef.current = v;
    setDraft(v);
    setTouched(true);
    setError(false);
    if (stored) setStored(null);
    if (conflictRef.current) {
      const server = serverRef.current ?? note;
      if (v === server) {
        // Isti tekst kao na serveru — sukob je rešen.
        savedRef.current = server;
        setSaved(server);
        leaveConflict();
        removeNoteDraft(date);
      } else {
        // `base` ostaje stara beleška: draft se pri sledećem otvaranju samo nudi, ne vraća sam.
        writeNoteDraft(date, { base: savedRef.current, text: v });
      }
      return;
    }
    if (v === savedRef.current) removeNoteDraft(date);
    else writeNoteDraft(date, { base: savedRef.current, text: v });
    scheduledRef.current = true;
    schedule(date, v);
  };

  /** Sukob: sačuvaj ovaj tekst preko beleške sa drugog uređaja. */
  const keepMine = () => {
    const server = serverRef.current ?? note;
    savedRef.current = server;
    setSaved(server);
    leaveConflict();
    const text = draftRef.current;
    if (text === server) {
      removeNoteDraft(date);
      return;
    }
    writeNoteDraft(date, { base: server, text });
    cancel();
    void save(date, text);
  };

  /** Sukob: odbaci ovaj tekst i prikaži belešku sa drugog uređaja. */
  const takeTheirs = () => {
    const server = serverRef.current ?? note;
    cancel();
    scheduledRef.current = false;
    draftRef.current = server;
    savedRef.current = server;
    setDraft(server);
    setSaved(server);
    setError(false);
    leaveConflict();
    removeNoteDraft(date);
  };

  /** "Pokušaj ponovo": pošalji odmah; ako se čeka svež odgovor servera, zatraži ga odmah. */
  const retry = () => {
    if (serverRef.current == null) onNeedFresh(true);
    saveIfDirty();
  };

  const discardStored = () => {
    removeNoteDraft(date);
    setStored(null);
  };

  const dirty = draft !== saved;
  const status = conflict
    ? 'conflict'
    : error
      ? 'error'
      : dirty || inflight > 0
        ? 'saving'
        : touched
          ? 'saved'
          : null;
  const others = otherDrafts.filter((d) => d !== date);

  return (
    <Card
      title="Beleške i misli"
      className="day-notes"
      actions={
        <span
          className={cx('day-save-state', (status === 'error' || status === 'conflict') && 'is-error')}
          role="status"
          aria-live="polite"
        >
          {status === 'saving' && 'Čuva se…'}
          {status === 'saved' && 'Sačuvano'}
          {status === 'conflict' && 'Nije sačuvano'}
          {status === 'error' && (
            <>
              Nije sačuvano{' '}
              <button type="button" className="day-link-btn" onClick={retry}>
                Pokušaj ponovo
              </button>
            </>
          )}
        </span>
      }
    >
      {others.length > 0 && (
        <p className="day-notes-restore">
          <span>Nesačuvana beleška za</span>
          {others.slice(0, 3).map((d) => (
            <button key={d} type="button" className="day-link-btn" onClick={() => onOpenDay(d)}>
              {fmtDateMedium(d)}
            </button>
          ))}
        </p>
      )}
      {conflict ? (
        <p className="day-notes-restore" role="alert">
          <span>Beleška je u međuvremenu promenjena na drugom uređaju.</span>
          <button type="button" className="day-link-btn" onClick={keepMine}>
            Sačuvaj ovu
          </button>
          <button type="button" className="day-link-btn" onClick={takeTheirs}>
            Uzmi tu verziju
          </button>
        </p>
      ) : (
        stored &&
        (fresh || settled) && (
          <p className="day-notes-restore">
            <span>Na ovom uređaju je ostala nesačuvana verzija beleške.</span>
            <button type="button" className="day-link-btn" onClick={() => applyStored(stored.text, savedRef.current)}>
              Vrati je
            </button>
            <button type="button" className="day-link-btn" onClick={discardStored}>
              Odbaci
            </button>
          </p>
        )
      )}
      <TextArea
        value={draft}
        onChange={(e) => onChange(e.target.value)}
        onFocus={onFocusNotes}
        onBlur={saveIfDirty}
        placeholder="Kako je prošao dan, šta ti je na umu…"
        aria-label="Beleške i misli"
        minRows={4}
        maxLength={20000}
        className="day-notes-input"
      />
      <div className="day-rating">
        <span className="day-rating-label">Kakav je bio dan?</span>
        <RatingInput value={rating} onChange={onRate} />
      </div>
    </Card>
  );
}
