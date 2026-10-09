// Dnevnik: beleške po danima, najnovije prve, sa pretragom i učitavanjem starijih.

import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import type { JournalEntry } from '../../../shared/types.ts';
import type { Lang } from '../../../shared/types.ts';
import { fmtDateLong, fmtMonthYear, fmtPercent, logicalNow } from '../../../shared/time.ts';
import { useLang, useT } from '../i18n/index.ts';
import { api, errorMessage } from '../api.ts';
import { Link, dayPath, paths } from '../lib/router.tsx';
import { useSettings } from '../lib/store.ts';
import {
  Button,
  Empty,
  Icon,
  IconButton,
  PageHeader,
  PageLoader,
  RatingDots,
  Spinner,
  TextInput,
  cx,
  toast,
} from '../ui/index.ts';
import './journal.css';

const PAGE = 20;
/** Server vraća najviše 100 unosa po zahtevu (jedan ide na proveru "ima li još"). */
const MAX_SIZE = 99;
const SEARCH_DELAY = 300;

interface ListState {
  /** Upit za koji važe ovi unosi ('' = svi). */
  q: string;
  entries: JournalEntry[];
  hasMore: boolean;
}

// Poslednji spisak ostaje u memoriji dok je aplikacija otvorena: povratak sa stranice
// dana odmah prikaže isti spisak i pretragu, a sadržaj se tiho osveži u pozadini.
let memo: { input: string; list: ListState } | null = null;

/**
 * Jedna strana dnevnika. Traži se jedan unos više nego što se prikazuje, da bi se
 * pouzdano znalo postoji li još (bez dugmeta "Učitaj još" koje ne donese ništa).
 */
async function fetchPage(q: string, size: number, before?: string): Promise<Omit<ListState, 'q'>> {
  const n = Math.min(Math.max(size, 1), MAX_SIZE);
  const page = await api.journal({ q: q || undefined, before, limit: n + 1 });
  return { entries: page.slice(0, n), hasMore: page.length > n };
}

export default function JournalPage() {
  const lang = useLang();
  const t = useT();
  const { dayStart } = useSettings();
  const [input, setInput] = useState(() => memo?.input ?? '');
  const [q, setQ] = useState(() => memo?.list.q ?? '');
  const [list, setList] = useState<ListState | null>(() => memo?.list ?? null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Svako novo učitavanje prve strane dobija novi broj; odgovori sa starijim brojem se odbacuju.
  const seq = useRef(0);
  const listRef = useRef(list);
  listRef.current = list;

  useEffect(() => {
    if (list) memo = { input, list };
  }, [input, list]);

  // Debounce pretrage; brisanje upita važi odmah.
  useEffect(() => {
    const next = input.trim();
    if (next === q) return;
    const timer = window.setTimeout(() => setQ(next), next ? SEARCH_DELAY : 0);
    return () => window.clearTimeout(timer);
  }, [input, q]);

  // Prva strana za upit. Za isti upit (povratak na stranicu, "Pokušaj ponovo")
  // osvežava se onoliko unosa koliko je već bilo učitano.
  useEffect(() => {
    const my = ++seq.current;
    const prev = listRef.current;
    const size = prev && prev.q === q ? Math.max(PAGE, prev.entries.length) : PAGE;
    setLoading(true);
    setLoadingMore(false);
    setError(null);
    fetchPage(q, size).then(
      (res) => {
        if (my !== seq.current) return;
        setList({ q, ...res });
        setLoading(false);
      },
      (e) => {
        if (my !== seq.current) return;
        setError(errorMessage(e));
        setLoading(false);
      },
    );
    return () => {
      seq.current++;
    };
  }, [q, reloadKey]);

  const loadMore = () => {
    if (!list || !list.hasMore || loading || loadingMore) return;
    const my = seq.current;
    const before = list.entries[list.entries.length - 1]?.date;
    setLoadingMore(true);
    fetchPage(list.q, PAGE, before).then(
      (res) => {
        if (my !== seq.current) return;
        setList((cur) => {
          if (!cur) return cur;
          const seen = new Set(cur.entries.map((e) => e.date));
          return {
            ...cur,
            entries: [...cur.entries, ...res.entries.filter((e) => !seen.has(e.date))],
            hasMore: res.hasMore,
          };
        });
        setLoadingMore(false);
      },
      (e) => {
        if (my !== seq.current) return;
        setLoadingMore(false);
        toast.error(errorMessage(e));
      },
    );
  };

  const clearSearch = () => {
    setInput('');
    setQ('');
    inputRef.current?.focus();
  };

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setQ(input.trim());
    // Na telefonu "Traži" na tastaturi treba i da je skloni.
    if (window.matchMedia('(pointer: coarse)').matches) inputRef.current?.blur();
  };

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape' && input) {
      e.preventDefault();
      setInput('');
    }
  };

  const groups = useMemo(() => (list ? groupByMonth(list.entries, lang) : []), [list, lang]);
  const today = logicalNow(dayStart).date;

  // Dok stiže odgovor za novi upit, stari rezultati ostaju vidljivi ali prigušeni.
  const stale = loading && list !== null && list.q !== q;
  // Pretraga nema smisla dok dnevnik nije učitan ili je potpuno prazan.
  const showSearch = (list !== null && (list.q !== '' || list.entries.length > 0)) || input !== '';

  let content: ReactNode;
  if (error) {
    content = (
      <Empty
        title={t('journal.loadError')}
        text={error}
        action={<Button onClick={() => setReloadKey((k) => k + 1)}>{t('common.retry')}</Button>}
      />
    );
  } else if (!list) {
    content = <PageLoader />;
  } else if (list.entries.length === 0) {
    content = list.q ? (
      <Empty
        title={t('journal.search.noResults', { query: list.q })}
        action={
          <Button variant="ghost" onClick={clearSearch}>
            {t('journal.search.clear')}
          </Button>
        }
      />
    ) : (
      <Empty
        title={t('journal.empty.title')}
        text={t('journal.empty.text')}
        action={
          <Link to={paths.today} className="btn btn-secondary">
            {t('journal.empty.openToday')}
          </Link>
        }
      />
    );
  } else {
    content = (
      <div className={cx('jr-results', stale && 'is-stale')} aria-busy={stale || undefined}>
        {groups.map((g) => (
          <section key={g.key} className="jr-month" aria-labelledby={`jr-m-${g.key}`}>
            <h2 className="jr-month-title" id={`jr-m-${g.key}`}>
              {g.label}
            </h2>
            <ol className="jr-list">
              {g.entries.map((entry) => (
                <EntryItem key={entry.date} entry={entry} query={list.q} today={today} />
              ))}
            </ol>
          </section>
        ))}
        {list.hasMore && (
          <div className="jr-more">
            <Button onClick={loadMore} loading={loadingMore} disabled={loading}>
              {t('journal.loadMore')}
            </Button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="page jr-page">
      <PageHeader title={t('journal.title')} />

      {showSearch && (
        <form className="jr-search" role="search" onSubmit={onSubmit}>
          <span className="jr-search-icon">{stale ? <Spinner small /> : <Icon name="search" size={18} />}</span>
          <TextInput
            ref={inputRef}
            type="search"
            className="jr-search-input"
            placeholder={t('journal.search.placeholder')}
            aria-label={t('journal.search.placeholder')}
            enterKeyHint="search"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onSearchKey}
          />
          {input !== '' && (
            <IconButton icon="x" label={t('journal.search.clear')} className="jr-search-clear" onClick={clearSearch} />
          )}
          <p className="sr-only" aria-live="polite">
            {list && list.q && !loading && !error
              ? t('journal.search.found', { count: `${list.entries.length}${list.hasMore ? '+' : ''}` })
              : ''}
          </p>
        </form>
      )}

      {content}
    </div>
  );
}

// ---- Jedan unos ----

function EntryItem({ entry, query, today }: { entry: JournalEntry; query: string; today: string }) {
  const lang = useLang();
  const t = useT();
  const curYear = today.slice(0, 4);
  const textId = useId();
  const itemRef = useRef<HTMLElement>(null);
  const textRef = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  const text = entry.note.trim();
  const parts = useMemo(() => highlight(text, query), [text, query]);
  const headingId = `jr-d-${entry.date}`;

  // Da li skraćeni tekst krije još redova. Meri se samo dok je skraćen
  // (raširen tekst nema šta da skriva), i ponovo kad se promeni širina.
  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el || expanded) return;
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, expanded]);

  // Ako je prvi pogodak pretrage ispod skraćenog dela, prikaži ceo tekst.
  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el || !query) return;
    const mark = el.querySelector('mark');
    if (mark && mark.offsetTop + mark.offsetHeight > el.clientHeight + 1) setExpanded(true);
  }, [text, query]);

  // Posle skupljanja dugog teksta početak unosa može ostati iznad ekrana — vrati ga.
  const scrollBack = useRef(false);
  useLayoutEffect(() => {
    if (expanded || !scrollBack.current) return;
    scrollBack.current = false;
    const el = itemRef.current;
    if (el && el.getBoundingClientRect().top < 0) el.scrollIntoView({ block: 'start' });
  }, [expanded]);

  const toggle = () => {
    scrollBack.current = expanded;
    setExpanded(!expanded);
  };

  return (
    <li className="jr-entry">
      <article ref={itemRef} aria-labelledby={headingId}>
        <header className="jr-entry-head">
          <h3 className="jr-date" id={headingId}>
            <Link to={dayPath(entry.date, today)} className="jr-date-link">
              {fmtDateLong(entry.date, lang, entry.date.slice(0, 4) !== curYear)}
              <Icon name="chevron-right" size={16} className="jr-date-icon" />
            </Link>
          </h3>
          <EntryMeta entry={entry} />
        </header>
        <p id={textId} ref={textRef} className={cx('jr-text', !expanded && 'is-clamped')}>
          {parts}
        </p>
        {overflows && (
          <button type="button" className="jr-toggle" aria-expanded={expanded} aria-controls={textId} onClick={toggle}>
            {t(expanded ? 'journal.entry.showLess' : 'journal.entry.showMore')}
            <Icon name={expanded ? 'chevron-up' : 'chevron-down'} size={16} />
          </button>
        )}
      </article>
    </li>
  );
}

/** Ocena, ispunjenost i zadaci dana — prikazuje se samo ono što postoji. */
function EntryMeta({ entry }: { entry: JournalEntry }) {
  const t = useT();
  const items: Array<{ key: string; node: ReactNode; title?: string }> = [];
  if (entry.rating != null) items.push({ key: 'r', node: <RatingDots value={entry.rating} /> });
  if (entry.score != null) {
    items.push({
      key: 's',
      node: t('journal.meta.score', { pct: fmtPercent(entry.score) }),
      title: t('journal.meta.scoreTitle'),
    });
  }
  if (entry.tasksTotal > 0) {
    items.push({
      key: 't',
      // "3/5 tasks" / "3/5 zadataka", "1/2 zadatka" — oblik se slaže sa ukupnim brojem ("od 5 zadataka").
      node: t('journal.meta.tasks', { done: entry.tasksDone, n: entry.tasksTotal }),
      title: t('journal.meta.tasksTitle'),
    });
  }
  if (items.length === 0) return null;
  return (
    <div className="jr-meta">
      {items.map((it) => (
        <span key={it.key} className="jr-meta-item" title={it.title}>
          {it.node}
        </span>
      ))}
    </div>
  );
}

// ---- Pomoćne funkcije ----

function groupByMonth(entries: JournalEntry[], lang: Lang) {
  const groups: Array<{ key: string; label: string; entries: JournalEntry[] }> = [];
  for (const e of entries) {
    const key = e.date.slice(0, 7);
    let g = groups[groups.length - 1];
    if (!g || g.key !== key) {
      g = { key, label: fmtMonthYear(e.date, lang), entries: [] };
      groups.push(g);
    }
    g.entries.push(e);
  }
  return groups;
}

/**
 * Isto poređenje kao pretraga na serveru (server/util.ts foldText): mala slova,
 * đ → dj, bez dijakritika — "caj" nalazi "Čaj".
 */
function foldChar(ch: string): string {
  return ch
    .toLocaleLowerCase('sr')
    .replace(/đ/g, 'dj')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

/** Tekst sa istaknutim pojavljivanjima upita (bez obzira na velika slova i dijakritike). */
function highlight(text: string, query: string): ReactNode {
  const needle = Array.from(query, foldChar).join('');
  if (!needle) return text;
  // Presavijen tekst + za svaki njegov znak opseg odgovarajućeg znaka u originalu
  // (jedan znak može postati dva, npr. đ → dj).
  let folded = '';
  const from: number[] = [];
  const to: number[] = [];
  let i = 0;
  for (const ch of text) {
    const f = foldChar(ch);
    for (let k = 0; k < f.length; k++) {
      from.push(i);
      to.push(i + ch.length);
    }
    folded += f;
    i += ch.length;
  }

  const out: ReactNode[] = [];
  let last = 0;
  let pos = folded.indexOf(needle);
  while (pos !== -1) {
    const s = from[pos];
    const e = to[pos + needle.length - 1];
    if (s >= last) {
      if (s > last) out.push(text.slice(last, s));
      out.push(
        <mark key={s} className="jr-mark">
          {text.slice(s, e)}
        </mark>,
      );
      last = e;
    }
    pos = folded.indexOf(needle, pos + needle.length);
  }
  if (out.length === 0) return text;
  if (last < text.length) out.push(text.slice(last));
  return out;
}
