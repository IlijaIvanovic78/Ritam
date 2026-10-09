// Okvir aplikacije: obnova sesije (nalog), učitavanje rasporeda, navigacija
// (bočna traka na desktopu, donja traka na telefonu), traka nove verzije i prikaz stranice po ruti.

import {
  Component,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode,
} from 'react';
import { capitalize, fmtDateMedium } from '../../shared/time.ts';
import type { AuthUser, Lang } from '../../shared/types.ts';
import {
  ApiError,
  UNAUTHORIZED_EVENT,
  USER_CHANGED_EVENT,
  api,
  pageOwnerUser,
  sameUser,
  sessionStore,
  setOfflineUser,
} from './api.ts';
import { useLang, useT, type MessageKey, type TFunction } from './i18n/index.ts';
import {
  adoptUser,
  announceLogin,
  endSessionFromOtherTab,
  markSignedOut,
  onOtherTabAuth,
  readLastUser,
} from './lib/account.ts';
import { useOnline, useServerStale } from './lib/hooks.ts';
import { applyUpdate, clearApiCache, dismissUpdate, useUpdateState } from './lib/pwa.ts';
import { Link, TODAY_EVENT, paths, useLocation, useRoute, type Route } from './lib/router.tsx';
import { scheduleStore, useScheduleState } from './lib/store.ts';
import DayPage from './pages/DayPage.tsx';
import JournalPage from './pages/JournalPage.tsx';
import LoginPage from './pages/LoginPage.tsx';
import ProgressPage from './pages/ProgressPage.tsx';
import SchedulePage from './pages/SchedulePage.tsx';
import SettingsPage from './pages/SettingsPage.tsx';
import {
  Button,
  ConfirmHost,
  Empty,
  Icon,
  PageHeader,
  PageLoader,
  Toaster,
  Wordmark,
  cx,
  toast,
  type IconName,
} from './ui/index.ts';
import { DIALOGS_EVENT } from './ui/Sheet.tsx';

type Phase = 'checking' | 'login' | 'ready';

/**
 * Raspored (drugi uređaj je možda menjao šablone, kategorije, dane u nedelji) se tiho osveži pri
 * povratku u aplikaciju i fokusu prozora ako je stariji od FOCUS_REFRESH_MS, i povremeno dok tab
 * stoji vidljiv (laptop) a ništa nije otvoreno.
 */
const FOCUS_REFRESH_MS = 30_000;
const POLL_MS = 60_000;
const POLL_CHECK_MS = 15_000;
/** Dok je upaljena traka "Server nije dostupan": koliko često se proverava da li je server ponovo tu. */
const PROBE_MS = 15_000;
/**
 * Pokretanje: koliko se čeka obnova sesije pre nego što se pokažu sačuvani podaci poslednjeg naloga
 * (slaba veza). Obnova se i posle toga završava u pozadini.
 */
const START_WAIT_MS = 4_000;

type StartOutcome = { kind: 'ok'; user: AuthUser } | { kind: 'login' } | { kind: 'offline' } | { kind: 'slow' };

const wait = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

export default function App() {
  // Promena jezika ponovo renderuje celu aplikaciju (stranice nemaju memo), pa se svaki tekst prevede; stanje
  // stranica i otvorenih formi ostaje.
  const t = useT();
  const [phase, setPhase] = useState<Phase>('checking');
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const schedule = useScheduleState();
  /** Raste pri svakom pokretanju i povratku na prijavu: zakasneli nastavak ranijeg start() se odbacuje. */
  const startGen = useRef(0);
  // Nalog čiji su podaci učitani u memoriju ove stranice (keš dana, dnevnik, napredak…) je
  // pageOwnerUser() iz api.ts. Prijava drugog naloga posle toga učitava stranicu ponovo, da ništa od
  // prethodnog naloga ne ostane (a do tada api.ts ne šalje nijedan zahtev).

  const enter = useCallback(() => {
    // Učitavanje kreće pre promene faze, da 'ready' nikad ne zatekne raspored bez podataka i bez učitavanja.
    void scheduleStore.load();
    setPhase('ready');
  }, []);

  const start = useCallback(async () => {
    const gen = ++startGen.current;
    setPhase('checking');
    // Sesija se obnavlja preko refresh kolačića; access token ostaje samo u memoriji.
    const outcome: Promise<StartOutcome> = api.refresh().then(
      (r): StartOutcome => ({ kind: 'ok', user: r.user }),
      (e: unknown): StartOutcome => (e instanceof ApiError && e.status === 401 ? { kind: 'login' } : { kind: 'offline' }),
    );
    let res = await Promise.race([outcome, wait(START_WAIT_MS).then((): StartOutcome => ({ kind: 'slow' }))]);
    if (gen !== startGen.current) return;
    // Poslednji nalog ovog uređaja, ako mu sesija nije završena (odjavljen nalog nema rad bez servera).
    const last = readLastUser();
    const known = last && !last.signedOut ? last : null;
    // Nema naloga čiji bi se sačuvani podaci pokazali: čeka se odgovor servera.
    if (res.kind === 'slow' && !known) {
      res = await outcome;
      if (gen !== startGen.current) return;
    }
    if (res.kind === 'ok') {
      await adoptUser(res.user);
      if (gen !== startGen.current) return;
      enter();
      return;
    }
    if (res.kind === 'login' || !known) {
      setPhase('login');
      return;
    }
    // Stranica već ima podatke drugog naloga (prijava u drugom tabu): ispočetka.
    const owner = pageOwnerUser();
    if (owner && !sameUser(owner, known)) {
      window.location.reload();
      return;
    }
    // Bez servera (ili spora veza): sačuvani podaci poslednjeg naloga iz keša service worker-a.
    // Prvi zahtev koji stigne do servera obnovi sesiju; odbijena obnova vraća na prijavu.
    setOfflineUser(known);
    enter();
  }, [enter]);

  useEffect(() => {
    void start();
  }, [start]);

  // Sesija je završena (odjava, istekla ili opozvana) → prijava. Nesačuvane beleške ostaju na
  // uređaju (šalju se posle ponovne prijave istog naloga); odjava ih briše sama (lib/account.ts).
  // Pokretanje bez servera posle toga prikazuje Prijavu, ne podatke tog naloga.
  useEffect(() => {
    const onUnauthorized = () => {
      startGen.current += 1;
      scheduleStore.clear();
      markSignedOut();
      void clearApiCache();
      setPhase('login');
    };
    // Osvežena sesija pripada drugom nalogu (prijava u drugom tabu): stranica se učitava ispočetka.
    const onUserChanged = () => {
      startGen.current += 1;
      window.location.reload();
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    window.addEventListener(USER_CHANGED_EVENT, onUserChanged);
    return () => {
      window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
      window.removeEventListener(USER_CHANGED_EVENT, onUserChanged);
    };
  }, []);

  // Prijava/odjava u drugom tabu ovog browsera (kolačić sesije je zajednički).
  useEffect(
    () =>
      onOtherTabAuth((ev) => {
        const me = sessionStore.get().user;
        if (ev.type === 'logout') {
          if (me) endSessionFromOtherTab();
          return;
        }
        if (me && me.id === ev.userId) return;
        // Na uređaju je sada drugi nalog: ništa od prethodnog ne ostaje na ekranu ni u memoriji.
        if (me || pageOwnerUser() != null) window.location.reload();
        else if (phaseRef.current === 'login') void start();
      }),
    [start],
  );

  // Tiho osvežavanje rasporeda (izmene sa drugog uređaja).
  useEffect(() => {
    if (phase !== 'ready') return;
    const refreshIfOlder = (ms: number) => {
      if (scheduleStore.get().data && scheduleStore.age() > ms) void scheduleStore.refresh();
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') refreshIfOlder(FOCUS_REFRESH_MS);
    };
    const onFocus = () => refreshIfOlder(FOCUS_REFRESH_MS);
    const poll = window.setInterval(() => {
      // Ne dok je otvoren sheet (forma) — osvežava se kad se zatvori.
      if (document.visibilityState !== 'visible' || !navigator.onLine || document.querySelector('dialog[open]')) return;
      refreshIfOlder(POLL_MS);
    }, POLL_CHECK_MS);
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(poll);
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('focus', onFocus);
    };
  }, [phase]);

  // Raspored nije učitan (bez mreže): kad se mreža vrati, pokušaj ponovo sam.
  const loadFailed = phase === 'ready' && !schedule.data && !schedule.loading;
  useEffect(() => {
    if (!loadFailed) return;
    const onOnline = () => void start();
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [loadFailed, start]);

  const onLoggedIn = useCallback(
    async (user: AuthUser) => {
      startGen.current += 1;
      await adoptUser(user);
      announceLogin(user);
      // U memoriji su podaci drugog naloga (sesija je istekla pa se prijavio neko drugi): ispočetka.
      const owner = pageOwnerUser();
      if (owner && !sameUser(owner, user)) {
        window.location.reload();
        return;
      }
      enter();
    },
    [enter],
  );

  let content: ReactNode;
  if (phase === 'login') {
    content = <LoginPage onLoggedIn={onLoggedIn} />;
  } else if (phase === 'ready' && schedule.data) {
    content = <Shell />;
  } else if (phase === 'ready' && !schedule.loading) {
    // Greška učitavanja (ili raspored obrisan bez novog učitavanja): nikad samo beskrajni spinner.
    content = (
      <div className="shell-splash">
        <Empty
          title={t('shell.loadFailed')}
          text={schedule.error}
          action={
            <Button icon="refresh" onClick={() => void start()}>
              {t('common.retry')}
            </Button>
          }
        />
      </div>
    );
  } else {
    content = (
      <div className="shell-splash">
        <PageLoader />
      </div>
    );
  }

  return (
    <>
      {content}
      {/* U okviru aplikacije traka stoji iznad donje trake (Shell); ovde za Prijavu i ekran greške. */}
      {!(phase === 'ready' && schedule.data) && <UpdateBar />}
      <Toaster />
      <ConfirmHost />
    </>
  );
}

// ---- Okvir sa navigacijom ----

interface NavItem {
  route: Route['name'];
  to: string;
  icon: IconName;
}

const NAV: NavItem[] = [
  { route: 'day', to: paths.today, icon: 'today' },
  { route: 'progress', to: paths.progress, icon: 'chart' },
  { route: 'journal', to: paths.journal, icon: 'journal' },
  { route: 'schedule', to: paths.schedule, icon: 'blocks' },
];

/** Naziv stranice (navigacija i naslov taba). */
const TITLES: Record<Route['name'], Extract<MessageKey, `shell.page.${string}`>> = {
  day: 'shell.page.today',
  progress: 'shell.page.progress',
  journal: 'shell.page.journal',
  schedule: 'shell.page.schedule',
  settings: 'shell.page.settings',
  notfound: 'shell.page.notFound',
};

function pageTitle(route: Route, t: TFunction, lang: Lang): string {
  if (route.name === 'day' && route.date) return capitalize(fmtDateMedium(route.date, lang));
  return t(TITLES[route.name]);
}

/** Klik na već aktivan tab vraća stranicu na vrh (kao u nativnim aplikacijama). */
function scrollTopIfActive(active: boolean) {
  if (!active) return;
  if (window.location.pathname === paths.today) window.dispatchEvent(new Event(TODAY_EVENT));
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
}

function Shell() {
  const t = useT();
  const lang = useLang();
  const route = useRoute();
  const pathname = useLocation().split('?')[0];
  const online = useOnline();
  const stale = useServerStale();

  // Traka "Server nije dostupan" se gasi tek kad server stvarno odgovori. Stranice bez povremenog
  // osvežavanja (Raspored, Dnevnik, Podešavanja…) ne šalju zahteve same, pa se server proverava
  // ovde (/api/health ide mimo keša service worker-a).
  useEffect(() => {
    if (!stale) return;
    const probe = () => {
      if (document.visibilityState === 'visible' && navigator.onLine) api.health().catch(() => {});
    };
    const id = window.setInterval(probe, PROBE_MS);
    document.addEventListener('visibilitychange', probe);
    window.addEventListener('focus', probe);
    return () => {
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', probe);
      window.removeEventListener('focus', probe);
    };
  }, [stale]);

  // route je nov objekat svakim renderom; naslov zavisi samo od putanje i jezika.
  const title = `${pageTitle(route, t, lang)} · Ritam`;
  useEffect(() => {
    document.title = title;
  }, [title]);

  const isActive = (item: NavItem) => route.name === item.route;
  // Na telefonu se Podešavanja otvaraju iz Rasporeda, pa tab Raspored ostaje istaknut.
  const isTabActive = (item: NavItem) => isActive(item) || (item.route === 'schedule' && route.name === 'settings');
  const settingsActive = route.name === 'settings';

  return (
    <div className="shell">
      <a className="shell-skip" href="#main">
        {t('shell.skipToContent')}
      </a>

      <nav className="shell-side" aria-label={t('shell.mainNav')}>
        <Link
          to={paths.today}
          className="shell-brand"
          aria-label={t('shell.homeLink')}
          onClick={() => scrollTopIfActive(pathname === paths.today)}
        >
          <Wordmark height={34} />
        </Link>
        <ul className="shell-side-list">
          {NAV.map((item) => {
            const active = isActive(item);
            return (
              <li key={item.route}>
                <Link
                  to={item.to}
                  className={cx('shell-side-link', active && 'is-active')}
                  aria-current={active ? 'page' : undefined}
                  onClick={() => scrollTopIfActive(active && item.to === pathname)}
                >
                  <Icon name={item.icon} size={20} />
                  <span>{t(TITLES[item.route])}</span>
                </Link>
              </li>
            );
          })}
        </ul>
        <div className="shell-side-foot">
          <Link
            to={paths.settings}
            className={cx('shell-side-link', settingsActive && 'is-active')}
            aria-current={settingsActive ? 'page' : undefined}
          >
            <Icon name="settings" size={20} />
            <span>{t('shell.page.settings')}</span>
          </Link>
        </div>
      </nav>

      <main id="main" className="shell-main" tabIndex={-1}>
        <header className="shell-top">
          <Link
            to={paths.today}
            className="shell-top-brand"
            aria-label={t('shell.homeLink')}
            onClick={() => scrollTopIfActive(pathname === paths.today)}
          >
            <Wordmark height={30} />
          </Link>
        </header>
        {(!online || stale) && (
          <div className="shell-offline" role="status">
            <span className="shell-offline-dot" aria-hidden="true" />
            {online ? t('shell.serverStale') : t('shell.offline')}
          </div>
        )}
        <PageErrorBoundary key={pathname}>
          <PageView key={pathname} route={route} />
        </PageErrorBoundary>
      </main>

      <UpdateBar />

      <nav className="shell-tabbar" aria-label={t('shell.mainNav')}>
        {NAV.map((item) => {
          const active = isTabActive(item);
          return (
            <Link
              key={item.route}
              to={item.to}
              className={cx('shell-tab', active && 'is-active')}
              aria-current={isActive(item) ? 'page' : undefined}
              onClick={() => scrollTopIfActive(isActive(item) && item.to === pathname)}
            >
              <Icon name={item.icon} size={22} />
              <span className="shell-tab-label">{t(TITLES[item.route])}</span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

// ---- Nova verzija aplikacije ----

/** Otvoren je sheet ili dijalog (modalni <dialog>; Sheet javlja promenu kroz DIALOGS_EVENT). */
function useDialogOpen(): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const update = () => setOpen(document.querySelector('dialog[open]') != null);
    update();
    window.addEventListener(DIALOGS_EVENT, update);
    return () => window.removeEventListener(DIALOGS_EVENT, update);
  }, []);
  return open;
}

/**
 * "A new version is available." (update.available) + Osveži + ×: tiha traka na dnu (telefon: odmah iznad donje
 * trake; desktop: na dnu sadržaja). Stranica se nikad ne učitava sama (lib/pwa.ts). Dok je otvoren sheet ili
 * dijalog, traka čeka da se zatvori — Osveži bi prekinuo formu, a van dijaloga ionako ne prima dodir.
 * Visina trake ide u --update-h: stranica dobija toliko prostora na dnu, a toast-ovi stoje iznad nje.
 */
function UpdateBar() {
  const t = useT();
  const { available, applying } = useUpdateState();
  const dialogOpen = useDialogOpen();
  const ref = useRef<HTMLDivElement>(null);
  const show = available && !dialogOpen;

  useLayoutEffect(() => {
    const el = ref.current;
    if (!show || !el) return;
    const root = document.documentElement.style;
    const measure = () => root.setProperty('--update-h', `${Math.ceil(el.getBoundingClientRect().height)}px`);
    measure();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    return () => {
      ro?.disconnect();
      root.removeProperty('--update-h');
    };
  }, [show]);

  if (!show) return null;

  const refresh = async () => {
    if (applying) return;
    const result = await applyUpdate();
    if (result === 'offline') toast.error(t('error.offline'));
    else if (result === 'unavailable') toast.error(t('error.unavailable'));
  };

  const dismiss = () => {
    // Fokus je bio u traci (tastatura): ne ostavljaj ga na <body> kad traka nestane.
    const hadFocus = ref.current?.contains(document.activeElement) ?? false;
    dismissUpdate();
    if (hadFocus) document.getElementById('main')?.focus({ preventScroll: true });
  };

  return (
    <div ref={ref} className="shell-update" role="status">
      <div className="shell-update-text">
        <span>{t('update.available')}</span>
        <button
          type="button"
          className={cx('shell-update-btn', applying && 'is-busy')}
          aria-disabled={applying || undefined}
          onClick={() => void refresh()}
        >
          {applying && <span className="spinner shell-update-spinner" aria-hidden="true" />}
          {applying ? t('update.refreshing') : t('update.refresh')}
        </button>
      </div>
      <button
        type="button"
        className="shell-update-close"
        aria-label={t('update.hideLabel')}
        title={t('update.hide')}
        disabled={applying}
        onClick={dismiss}
      >
        <Icon name="x" size={16} />
      </button>
    </div>
  );
}

function PageView({ route }: { route: Route }) {
  switch (route.name) {
    case 'day':
      return <DayPage date={route.date} />;
    case 'progress':
      return <ProgressPage />;
    case 'journal':
      return <JournalPage />;
    case 'schedule':
      return <SchedulePage />;
    case 'settings':
      return <SettingsPage />;
    case 'notfound':
      return <NotFound />;
  }
}

function NotFound() {
  const t = useT();
  return (
    <div className="page">
      <PageHeader title={t('shell.page.notFound')} />
      <Empty
        title={t('shell.notFound.title')}
        text={t('shell.notFound.text')}
        action={
          <Link to={paths.today} className="btn btn-secondary">
            <span>{t('shell.notFound.goToday')}</span>
          </Link>
        }
      />
    </div>
  );
}

// ---- Granica greške oko stranice ----

class PageErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Page render error:', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return <PageCrash />;
  }
}

/** Prikaz umesto stranice koja je pala (funkcijska komponenta, da tekst prati jezik). */
function PageCrash() {
  const t = useT();
  return (
    <div className="page">
      <div className="shell-crash">
        <Empty
          title={t('shell.crash.title')}
          text={t('shell.crash.text')}
          action={
            <Button icon="refresh" onClick={() => window.location.reload()}>
              {t('common.reload')}
            </Button>
          }
        />
      </div>
    </div>
  );
}
