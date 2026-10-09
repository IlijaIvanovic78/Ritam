// Niz blokova šablona ↔ server (uređivač šablona u Rasporedu). Isti StackController kao Danas, u režimu 'template':
// bez ocena, bez "sada" i bez sidrenja. Čuva se samo, kao i dan:
// - 700 ms posle poslednje izmene ceo raspored ide kroz zajednički red zahteva (`PUT /api/templates/:id/blocks`, telo
//   `toTemplateBlocks`, `base` = `templateBase` poslednje verzije sa servera, računat u trenutku slanja — drugi uređaj
//   je u međuvremenu sačuvao šablon → 409);
// - blok koji POČINJE posle kraja dana: server bi ga prebacio na početak dana, pa se takav raspored ne šalje dok ga
//   korisnik ne skrati ili obriše nešto (izmena čeka, "nazad" i zatvaranje taba pitaju);
// - greška: vraća se poslednja verzija koju je server potvrdio, istorija se briše, poruka (409 / 4xx: poruka servera),
//   a raspored se ponovo učita; posle zatvaranja uređivača greška ide kao toast sa nazivom šablona;
// - id-jevi blokova u nizu su lokalni (server pri svakom čuvanju daje nove), pa se odgovor ne preuzima: verzija sa
//   servera (osvežavanje, drugi uređaj) zamenjuje niz samo kad se SADRŽAJ razlikuje, i samo kad ništa ne čeka na
//   čuvanje i ništa nije u toku (gest, sheet).
// Čuvanje se ne odlaže preko sakrivanja stranice ni napuštanja uređivača.

import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { Category, Template, TemplateBlockInput } from '../../../../shared/types.ts';
import {
  fromBlocks,
  templateBase,
  toTemplateBlocks,
  type BlockFields,
  type Frame,
  type ItemId,
  type StackItem,
} from '../../../../shared/blockStack.ts';
import { api, ApiError, errorMessage } from '../../api.ts';
import type { Lang, TFunction } from '../../i18n/index.ts';
import { enqueue, whenQueueIdle } from '../../lib/queue.ts';
import { scheduleStore } from '../../lib/store.ts';
import { toast } from '../../ui/index.ts';
import { StackController, type CommitEvent } from './controller.ts';

/** Pauza posle poslednje izmene pre slanja rasporeda. */
const SAVE_DEBOUNCE_MS = 700;
/** Koliko dugo stoji "Sačuvano". */
const SAVED_MS = 2000;

const sameFrame = (a: Frame, b: Frame) => a.start === b.start && a.end === b.end;

/** Niz ima isti sadržaj (vreme, naziv, kategorija) kao blokovi šablona sa servera. */
const sameContent = (items: readonly StackItem[], frame: Frame, blocks: Template['blocks']) =>
  templateBase(toTemplateBlocks(items, frame).blocks) === templateBase(blocks);

const plain = (b: Template['blocks'][number]): TemplateBlockInput => ({ start: b.start, end: b.end, title: b.title, categoryId: b.categoryId });

interface SyncState {
  dayStart: number;
  /** Poslednja verzija šablona koju je server potvrdio (base za PUT, vraćanje posle greške). */
  base: Template | null;
  /** Poslednja verzija sa servera koja je preuzeta (ili proverena — isti sadržaj). */
  seen: Template | null;
  frame: Frame | null;
  /** Lokalna izmena koja još nije poslata (tajmer, ili čeka jer blok počinje posle kraja dana). */
  dirty: boolean;
  timer: number;
  /** Zahtevi ovog uređivača u redu / u toku. */
  inflight: number;
  savedTimer: number;
  overlaps: Array<{ a: number; b: number }>;
  /** Uređivač je zatvoren (greška čuvanja tada ide kao toast). */
  disposed: boolean;
}

export function useTemplateBlocks(o: {
  template: Template;
  dayStart: number;
  catMap: Map<number, Category>;
  /** Nazivi blokova van ovog šablona (drugi šabloni, dan) za predloge — samo korisnikovi podaci. */
  extraNames: ReadonlyArray<{ title: string; categoryId: number | null }>;
  t: TFunction;
  lang: Lang;
  /** Uređivač se zatvara, a izmena nije sačuvana (blok počinje posle kraja dana). */
  onLostChanges?: () => void;
}) {
  const id = o.template.id;
  const s = useRef<SyncState>({
    dayStart: o.dayStart,
    base: null,
    seen: null,
    frame: null,
    dirty: false,
    timer: 0,
    inflight: 0,
    savedTimer: 0,
    overlaps: [],
    disposed: false,
  }).current;
  const optsRef = useRef(o);
  optsRef.current = o;

  const ctlRef = useRef<StackController | null>(null);
  const onCommitRef = useRef<(e: CommitEvent) => void>(() => {});
  const onPatchRef = useRef<(id: ItemId, f: BlockFields) => void>(() => {});
  const cfg = {
    mode: 'template' as const,
    now: null,
    pastDay: false,
    locked: s.overlaps.length > 0,
    catMap: o.catMap,
    t: o.t,
    lang: o.lang,
    extraNames: o.extraNames,
    onCommit: (e: CommitEvent) => onCommitRef.current(e),
    onPatchFields: (bid: ItemId, f: BlockFields) => onPatchRef.current(bid, f),
  };
  if (!ctlRef.current) ctlRef.current = new StackController(cfg, [], o.dayStart);
  const ctl = ctlRef.current;
  ctl.cfg = cfg;

  /** Izmena čeka jer neki blok počinje posle kraja dana. */
  const held = () => s.dirty && ctl.M.overflowing(ctl.items).length > 0;

  const showSaving = () => {
    window.clearTimeout(s.savedTimer);
    ctl.setSaveState((s.dirty && !held()) || s.inflight > 0 ? 'saving' : 'idle');
  };

  const showSaved = () => {
    if (s.dirty || s.inflight > 0) return;
    ctl.setSaveState('saved');
    window.clearTimeout(s.savedTimer);
    s.savedTimer = window.setTimeout(() => ctl.setSaveState('idle'), SAVED_MS);
  };

  /** Verzija sa servera → niz (samo ako se sadržaj razlikuje; bez obaveštavanja tokom crtanja). */
  const adopt = (tpl: Template, silent: boolean) => {
    const r = fromBlocks(tpl.blocks, s.dayStart);
    s.seen = tpl;
    s.base = tpl;
    s.overlaps = r.overlaps;
    ctl.cfg = { ...ctl.cfg, locked: r.overlaps.length > 0 };
    const frameChanged = !s.frame || !sameFrame(s.frame, r.frame);
    s.frame = r.frame;
    if (!frameChanged && ctl.items.length > 0 && r.overlaps.length === 0 && sameContent(ctl.items, r.frame, tpl.blocks)) return;
    const hadItems = ctl.items.length > 0;
    ctl.replace(r.items, r.frame, { resetHistory: hadItems, silent });
  };

  /** Poruka greške čuvanja: 409 (drugi uređaj), 404 (šablon obrisan), 400 (npr. kategorija obrisana) = poruka servera. */
  const failText = (e: unknown) => {
    const { t } = optsRef.current;
    if (e instanceof ApiError && e.status >= 400 && e.status < 500) return errorMessage(e);
    return navigator.onLine ? t('blocks.msg.saveFailed') : t('shell.offline');
  };

  /** Čuvanje nije uspelo: vrati poslednju potvrđenu verziju i učitaj raspored ponovo. */
  const rollback = (e: unknown) => {
    window.clearTimeout(s.timer);
    s.timer = 0;
    s.dirty = false;
    const base = s.base;
    if (base && s.inflight === 0) {
      const r = fromBlocks(base.blocks, s.dayStart);
      s.seen = base;
      s.frame = r.frame;
      s.overlaps = r.overlaps;
      ctl.cfg = { ...ctl.cfg, locked: r.overlaps.length > 0 };
      ctl.replace(r.items, r.frame, { resetHistory: true });
    }
    showSaving();
    // Greška servera (4xx): poruka servera i sveža verzija.
    ctl.message(failText(e));
    if (e instanceof ApiError && e.status >= 400 && e.status < 500) void scheduleStore.refresh();
  };

  /**
   * Pošalji ceo raspored kroz red. Telo (`body`) i base se računaju kad zahtev krene, posle odgovora na prethodne
   * zahteve iz reda.
   */
  const send = (body: () => TemplateBlockInput[]) => {
    s.inflight += 1;
    showSaving();
    let failure: unknown = null;
    void enqueue(async () => {
      const p = await api.putTemplateBlocks(id, body(), s.base ? templateBase(s.base.blocks) : undefined);
      const tpl = p.templates.find((x) => x.id === id);
      if (tpl) s.base = tpl;
      return p;
    })
      .catch((e: unknown) => {
        failure = e ?? new Error('save failed');
        return null;
      })
      .then((p) => {
        s.inflight -= 1;
        if (!p && s.disposed) {
          // Uređivač je zatvoren: niz više nije na ekranu, pa greška ide kao toast (inače bi izmena nestala bez reči).
          const { t, template } = optsRef.current;
          toast.error(t('blocks.msg.failedFor', { what: template.name, msg: failText(failure) }));
          if (failure instanceof ApiError && failure.status >= 400 && failure.status < 500) void scheduleStore.refresh();
          return;
        }
        if (!p) {
          rollback(failure);
          return;
        }
        // Raspored sa servera (Šabloni, Dani u nedelji, Danas); crtanje uređivača proverava sadržaj.
        scheduleStore.set(p);
        showSaved();
      });
  };

  /** Pošalji raspored odmah (ako ima izmena i ako sme). false = izmena i dalje čeka. */
  const sendPut = (): boolean => {
    window.clearTimeout(s.timer);
    s.timer = 0;
    if (!s.dirty) return true;
    const frame = s.frame;
    if (!frame) return false;
    if (held()) {
      showSaving();
      return false;
    }
    const { blocks, invalid } = toTemplateBlocks(ctl.items, frame);
    s.dirty = false;
    if (invalid.length) {
      rollback(null);
      return false;
    }
    send(() => blocks);
    return true;
  };

  const schedule = () => {
    s.dirty = true;
    window.clearTimeout(s.timer);
    s.timer = window.setTimeout(() => sendPut(), SAVE_DEBOUNCE_MS);
    showSaving();
  };

  onCommitRef.current = () => schedule();

  /**
   * Dok je raspored zaključan (preklapanja iz starijih podataka): naziv i kategorija jednog bloka se menjaju u
   * sačuvanoj verziji (vremena ostaju kakva jesu), i ona se šalje cela.
   */
  onPatchRef.current = (bid: ItemId, f: BlockFields) => {
    const at = s.base?.blocks.findIndex((b) => b.id === bid) ?? -1;
    if (at < 0) return;
    // Po mestu u sačuvanoj verziji (odgovor prethodne izmene daje nove id-jeve, a redosled ostaje isti).
    send(() =>
      (s.base?.blocks ?? []).map((b, k) =>
        k === at ? { ...plain(b), title: f.title ?? b.title, categoryId: f.categoryId !== undefined ? f.categoryId : b.categoryId } : plain(b),
      ),
    );
  };

  // ---- Verzija sa servera → niz (u toku crtanja, da BlockStack odmah crta pravi šablon) ----
  if (s.dayStart !== o.dayStart) {
    s.dayStart = o.dayStart;
    s.seen = null;
    s.frame = null;
  }
  if (s.seen !== o.template && !s.dirty && s.inflight === 0 && !ctl.isBusy()) adopt(o.template, true);

  // Ponovno crtanje kad se niz promeni, kad se završi gest / zatvori sheet (tada se preuzima verzija koja je čekala)
  // i kad izmena počne ili prestane da čeka (blok posle kraja dana).
  useSyncExternalStore(ctl.subscribe, () => ctl.items);
  useSyncExternalStore(ctl.subscribe, () => ctl.isBusy());
  const isHeld = useSyncExternalStore(ctl.subscribe, held);

  // Sakrivanje stranice i napuštanje uređivača: pošalji odmah.
  useEffect(() => {
    s.disposed = false;
    const flush = () => {
      if (s.dirty) sendPut();
    };
    const onVis = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pagehide', flush);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pagehide', flush);
      window.clearTimeout(s.savedTimer);
      s.disposed = true;
      if (s.dirty && !sendPut()) optsRef.current.onLostChanges?.();
      ctl.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const extra = useMemo(
    () => ({
      /** "Popravi": raspored bez preklapanja (kasniji blok iza ranijeg) postaje raspored šablona. */
      fixOverlaps: () => {
        s.overlaps = [];
        ctl.cfg = { ...ctl.cfg, locked: false };
        ctl.commitAll();
      },
      /** Pošalji nesačuvan raspored odmah i sačekaj prazan red (pre dupliranja). */
      settle: async () => {
        sendPut();
        await whenQueueIdle();
      },
      /** Odbaci izmenu koja nije poslata (brisanje šablona, potvrđeno "Odbaci izmene"). */
      discard: () => {
        window.clearTimeout(s.timer);
        s.timer = 0;
        s.dirty = false;
        showSaving();
        ctl.emit();
      },
      /** Izmena čeka jer blok počinje posle kraja dana (čita se u trenutku poziva). */
      isHeld: held,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ctl],
  );

  return { ctl, overlaps: s.overlaps, held: isHeld, ...extra };
}
