// Okvir aplikacije: provera prijave, učitavanje rasporeda, navigacija
// (bočna traka na desktopu, donja traka na telefonu) i prikaz stranice po ruti.

import { Component, useCallback, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from 'react';
import { capitalize, fmtDateMedium } from '../../shared/time.ts';
import type { AuthState } from '../../shared/types.ts';
import { api } from './api.ts';
import { useOnline, useServerStale } from './lib/hooks.ts';
import { clearApiCache } from './lib/pwa.ts';
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
  type IconName,
} from './ui/index.ts';

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

export default function App() {
  const [phase, setPhase] = useState<Phase>('checking');
  const [auth, setAuth] = useState<AuthState | null>(null);
  const schedule = useScheduleState();
  /** Raste pri svakom pokretanju i povratku na prijavu: zakasneli nastavak ranijeg start() se odbacuje. */
  const startGen = useRef(0);

  const start = useCallback(async () => {
    const gen = ++startGen.current;
    setPhase('checking');
    // Raspored se učitava odmah, uporedo sa proverom prijave: na slaboj vezi ne čeka se jedno pa
    // drugo (raspored može da stigne i iz keša service worker-a). Čim stigne, aplikacija se
    // prikazuje i bez odgovora na proveru prijave — bez važeće sesije server za raspored vraća 401,
    // a 'ritam:unauthorized' vraća na prijavu.
    let checked = false;
    void scheduleStore.load().then(() => {
      if (gen !== startGen.current) return;
      if (!checked && scheduleStore.get().data) setPhase((p) => (p === 'checking' ? 'ready' : p));
    });
    let a: AuthState | null = null;
    try {
      a = await api.me();
    } catch {
      // Bez konekcije (ili server ne odgovara na vreme): nastavi sa onim što stigne iz keša.
      a = null;
    }
    // U međuvremenu je neki zahtev vratio 401 (prijava je već na ekranu) ili je start() ponovljen.
    if (gen !== startGen.current) return;
    checked = true;
    setAuth(a);
    if (a && a.authRequired && !a.authenticated) {
      scheduleStore.clear();
      setPhase('login');
      return;
    }
    setPhase('ready');
  }, []);

  useEffect(() => {
    void start();
  }, [start]);

  // Bilo koji API poziv sa 401 → nazad na prijavu.
  useEffect(() => {
    const onUnauthorized = () => {
      startGen.current += 1;
      scheduleStore.clear();
      void clearApiCache();
      setAuth((a) => ({ authRequired: a?.authRequired ?? true, authenticated: false }));
      setPhase('login');
    };
    window.addEventListener('ritam:unauthorized', onUnauthorized);
    return () => window.removeEventListener('ritam:unauthorized', onUnauthorized);
  }, []);

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

  const onLoggedIn = useCallback(() => {
    setAuth({ authRequired: true, authenticated: true });
    // Učitavanje kreće pre promene faze, da 'ready' nikad ne zatekne raspored bez podataka i bez učitavanja.
    void scheduleStore.load();
    setPhase('ready');
  }, []);

  let content: ReactNode;
  if (phase === 'login') {
    content = <LoginPage onLoggedIn={onLoggedIn} />;
  } else if (phase === 'ready' && schedule.data) {
    // Kad nije poznato (offline pri pokretanju), odjava se ipak nudi.
    content = <Shell authRequired={auth?.authRequired ?? true} />;
  } else if (phase === 'ready' && !schedule.loading) {
    // Greška učitavanja (ili raspored obrisan bez novog učitavanja): nikad samo beskrajni spinner.
    content = (
      <div className="shell-splash">
        <Empty
          title="Podaci nisu učitani."
          text={schedule.error}
          action={
            <Button icon="refresh" onClick={() => void start()}>
              Pokušaj ponovo
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
      <Toaster />
      <ConfirmHost />
    </>
  );
}

// ---- Okvir sa navigacijom ----

interface NavItem {
  route: Route['name'];
  to: string;
  label: string;
  icon: IconName;
}

const NAV: NavItem[] = [
  { route: 'day', to: paths.today, label: 'Danas', icon: 'today' },
  { route: 'progress', to: paths.progress, label: 'Napredak', icon: 'chart' },
  { route: 'journal', to: paths.journal, label: 'Dnevnik', icon: 'journal' },
  { route: 'schedule', to: paths.schedule, label: 'Raspored', icon: 'blocks' },
];

const TITLES: Record<Route['name'], string> = {
  day: 'Danas',
  progress: 'Napredak',
  journal: 'Dnevnik',
  schedule: 'Raspored',
  settings: 'Podešavanja',
  notfound: 'Nije pronađeno',
};

function pageTitle(route: Route): string {
  if (route.name === 'day' && route.date) return capitalize(fmtDateMedium(route.date));
  return TITLES[route.name];
}

/** Klik na već aktivan tab vraća stranicu na vrh (kao u nativnim aplikacijama). */
function scrollTopIfActive(active: boolean) {
  if (!active) return;
  if (window.location.pathname === paths.today) window.dispatchEvent(new Event(TODAY_EVENT));
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  window.scrollTo({ top: 0, behavior: reduce ? 'auto' : 'smooth' });
}

function Shell({ authRequired }: { authRequired: boolean }) {
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

  // route je nov objekat svakim renderom; naslov zavisi samo od putanje.
  const title = `${pageTitle(route)} · Ritam`;
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
        Preskoči na sadržaj
      </a>

      <nav className="shell-side" aria-label="Glavna navigacija">
        <Link
          to={paths.today}
          className="shell-brand"
          aria-label="Ritam — Danas"
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
                  <span>{item.label}</span>
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
            <span>Podešavanja</span>
          </Link>
        </div>
      </nav>

      <main id="main" className="shell-main" tabIndex={-1}>
        <header className="shell-top">
          <Link
            to={paths.today}
            className="shell-top-brand"
            aria-label="Ritam — Danas"
            onClick={() => scrollTopIfActive(pathname === paths.today)}
          >
            <Wordmark height={30} />
          </Link>
        </header>
        {(!online || stale) && (
          <div className="shell-offline" role="status">
            <span className="shell-offline-dot" aria-hidden="true" />
            {online
              ? 'Server nije dostupan — prikazani su sačuvani podaci.'
              : 'Nema interneta — izmene se ne čuvaju.'}
          </div>
        )}
        <PageErrorBoundary key={pathname}>
          <PageView key={pathname} route={route} authRequired={authRequired} />
        </PageErrorBoundary>
      </main>

      <nav className="shell-tabbar" aria-label="Glavna navigacija">
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
              <span className="shell-tab-label">{item.label}</span>
            </Link>
          );
        })}
      </nav>
    </div>
  );
}

function PageView({ route, authRequired }: { route: Route; authRequired: boolean }) {
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
      return <SettingsPage authRequired={authRequired} />;
    case 'notfound':
      return <NotFound />;
  }
}

function NotFound() {
  return (
    <div className="page">
      <PageHeader title="Nije pronađeno" />
      <Empty
        title="Ova stranica ne postoji."
        text="Proveri adresu ili se vrati na današnji dan."
        action={
          <Link to={paths.today} className="btn btn-secondary">
            <span>Idi na Danas</span>
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
    console.error('Greška u prikazu stranice:', error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="page">
        <div className="shell-crash">
          <Empty
            title="Ova stranica nije uspela da se prikaže."
            text="Podaci na serveru nisu dirani. Učitaj stranicu ponovo."
            action={
              <Button icon="refresh" onClick={() => window.location.reload()}>
                Učitaj ponovo
              </Button>
            }
          />
        </div>
      </div>
    );
  }
}
