// Podešavanja: tema, početak dana, prag za niz, instalacija, rezervna kopija, raspored ispočetka, nalog,
// verzija aplikacije.

import { useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react';
import { fmtClock, fmtDateMedium, fmtDateShort, localISODate, parseClock } from '../../../shared/time.ts';
import { ApiError, api, errorMessage } from '../api.ts';
import { logout, settlePendingWrites } from '../lib/account.ts';
import { useSession } from '../lib/hooks.ts';
import { clearNoteDrafts, listNoteDraftDates } from '../lib/noteDrafts.ts';
import { buildLabel, checkForUpdate, clearApiCache, isStandalone, useInstallPrompt } from '../lib/pwa.ts';
import { scheduleStore, useScheduleData, useSettings } from '../lib/store.ts';
import { setTheme, useTheme, type ThemePref } from '../lib/theme.ts';
import {
  Button,
  Card,
  Field,
  PageHeader,
  Segmented,
  Sheet,
  TextInput,
  TimeInput,
  Toggle,
  confirmDialog,
  cx,
  toast,
} from '../ui/index.ts';
import './settings.css';

const APP_VERSION = '1.0.0';
const MAX_DAY_START = 360; // 06:00
const MAX_IMPORT_BYTES = 20 * 1024 * 1024;

const THEME_OPTIONS: Array<{ value: ThemePref; label: string }> = [
  { value: 'dark', label: 'Tamna' },
  { value: 'light', label: 'Svetla' },
  { value: 'system', label: 'Sistem' },
];

const THRESHOLD_OPTIONS = [50, 60, 70, 80, 90].map((v) => ({ value: v, label: `${v}%` }));

export default function SettingsPage() {
  return (
    <div className="page">
      <PageHeader title="Podešavanja" />
      <div className="set-body">
        <AppearanceSection />
        <DaySection />
        <InstallSection />
        <BackupSection />
        <ResetSection />
        <AccountSection />
        <VersionSection />
      </div>
    </div>
  );
}

/**
 * Red podešavanja: naziv i objašnjenje levo, kontrola desno (na telefonu ispod). Kartica sa
 * jednim redom nema naziv reda — naslov kartice je već naziv.
 */
function Row({
  label,
  hint,
  htmlFor,
  children,
}: {
  label?: ReactNode;
  hint?: ReactNode;
  htmlFor?: string;
  children?: ReactNode;
}) {
  return (
    <div className="set-row">
      <div className="set-row-text">
        {label != null &&
          (htmlFor ? (
            <label className="set-row-label" htmlFor={htmlFor}>
              {label}
            </label>
          ) : (
            <div className="set-row-label">{label}</div>
          ))}
        {hint && <p className="set-row-hint">{hint}</p>}
      </div>
      {children != null && <div className="set-row-control">{children}</div>}
    </div>
  );
}

// ---- Izgled ----

function AppearanceSection() {
  const theme = useTheme();
  return (
    <Card title="Izgled">
      <Row hint="Sistem prati podešavanje telefona ili računara.">
        <div className="set-seg-wrap">
          <Segmented label="Tema" value={theme} options={THEME_OPTIONS} onChange={setTheme} className="set-seg" />
        </div>
      </Row>
    </Card>
  );
}

// ---- Dan i niz ----

function DaySection() {
  const settings = useSettings();
  const [draft, setDraft] = useState(() => fmtClock(settings.dayStart));
  const [savingStart, setSavingStart] = useState(false);
  const [savingThreshold, setSavingThreshold] = useState(false);

  // Ako se podešavanje promeni spolja (osvežavanje rasporeda), prikaži novu vrednost.
  useEffect(() => {
    setDraft(fmtClock(settings.dayStart));
  }, [settings.dayStart]);

  const parsed = parseClock(draft);
  const invalid = parsed == null || parsed > MAX_DAY_START;
  const dirty = !invalid && parsed !== settings.dayStart;

  const saveDayStart = async () => {
    if (invalid || !dirty || savingStart) return;
    setSavingStart(true);
    try {
      const payload = await api.patchSettings({ dayStart: parsed });
      scheduleStore.set(payload);
      setDraft(fmtClock(payload.settings.dayStart));
      toast.success('Početak dana je sačuvan.');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSavingStart(false);
    }
  };

  const threshold = Math.round(settings.streakThreshold * 100);
  const saveThreshold = async (pct: number) => {
    if (pct === threshold || savingThreshold) return;
    setSavingThreshold(true);
    try {
      scheduleStore.set(await api.patchSettings({ streakThreshold: pct / 100 }));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setSavingThreshold(false);
    }
  };

  return (
    <Card title="Dan">
      <Row
        label="Dan počinje u"
        hint="Sve između ponoći i ovog vremena računa se u prethodni dan — korisno ako ležeš posle ponoći."
      >
        <form
          className="set-inline"
          onSubmit={(e) => {
            e.preventDefault();
            void saveDayStart();
          }}
        >
          <TimeInput
            aria-label="Dan počinje u"
            className="set-time"
            min="00:00"
            max="06:00"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? 'set-day-start-error' : undefined}
          />
          <Button type="submit" disabled={!dirty} loading={savingStart}>
            Sačuvaj
          </Button>
        </form>
        {invalid && (
          <p className="set-error" id="set-day-start-error">
            Izaberi vreme od 00:00 do 06:00.
          </p>
        )}
      </Row>
      <Row label="Prag za niz dana" hint="Dan ulazi u niz kad je ispunjen bar ovoliko.">
        <div className={cx('set-seg-wrap', savingThreshold && 'set-busy')} aria-busy={savingThreshold || undefined}>
          <Segmented
            label="Prag za niz dana"
            value={threshold}
            options={THRESHOLD_OPTIONS}
            onChange={(v) => void saveThreshold(v)}
            className="set-seg set-seg-num"
          />
        </div>
      </Row>
    </Card>
  );
}

// ---- Instalacija ----

function InstallSection() {
  const { canInstall, installed, promptInstall } = useInstallPrompt();
  const standalone = installed || isStandalone();

  const install = async () => {
    try {
      if (await promptInstall()) toast.success('Ritam je instaliran.');
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  // Već instalirana aplikacija: kartica nema šta da ponudi.
  if (standalone) return null;

  return (
    <Card title="Instalacija">
      {canInstall ? (
        <Row hint="Otvara se kao zasebna aplikacija, bez adresne trake.">
          <Button variant="secondary" icon="download" onClick={() => void install()}>
            Instaliraj aplikaciju
          </Button>
        </Row>
      ) : (
        <div className="set-install">
          <p className="set-row-hint">Otvara se kao zasebna aplikacija, bez adresne trake.</p>
          <dl className="set-steps">
            <div>
              <dt>iPhone</dt>
              <dd>U Safariju otvori Podeli, pa izaberi Dodaj na početni ekran.</dd>
            </div>
            <div>
              <dt>Android</dt>
              <dd>U Chrome meniju izaberi Instaliraj aplikaciju.</dd>
            </div>
            <div>
              <dt>Laptop</dt>
              <dd>U Chrome-u ili Edge-u klikni ikonicu za instalaciju u adresnoj traci.</dd>
            </div>
          </dl>
          {!window.isSecureContext && (
            <p className="set-row-hint">Instalacija i rad bez interneta rade samo preko HTTPS adrese.</p>
          )}
        </div>
      )}
    </Card>
  );
}

// ---- Rezervna kopija ----

interface BackupHeader {
  app: 'ritam';
  exportedAt?: unknown;
}

function isBackup(data: unknown): data is BackupHeader {
  return typeof data === 'object' && data !== null && (data as { app?: unknown }).app === 'ritam';
}

/** "7. okt 2026. u 21:14" iz ISO vremena; null ako nije ispravno. */
function fmtExportedAt(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  const iso = localISODate(d);
  return `${fmtDateShort(iso)} ${d.getFullYear()}. u ${fmtClock(d.getHours() * 60 + d.getMinutes())}`;
}

function BackupSection() {
  const [exporting, setExporting] = useState(false);
  const [importing, setImporting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const download = async () => {
    setExporting(true);
    try {
      const data = await api.exportData();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `ritam-backup-${localISODate()}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      // Safari-ju treba trenutak pre nego što se URL oslobodi.
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setExporting(false);
    }
  };

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // isti fajl može ponovo da se izabere
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) {
      toast.error('Fajl je prevelik. Najviše 20 MB.');
      return;
    }

    let data: unknown;
    try {
      data = JSON.parse(await file.text());
    } catch {
      toast.error('Fajl nije ispravan JSON.');
      return;
    }
    if (!isBackup(data)) {
      toast.error('Ovo nije Ritam rezervna kopija.');
      return;
    }

    const when = fmtExportedAt(data.exportedAt);
    const ok = await confirmDialog({
      title: 'Vratiti podatke iz kopije?',
      body: (
        <>
          <p>Svi podaci ovog naloga biće zamenjeni podacima iz kopije. Ovo ne može da se poništi.</p>
          {when && <p className="set-confirm-meta">Kopija je napravljena {when}.</p>}
        </>
      ),
      confirmText: 'Vrati kopiju',
      danger: true,
    });
    if (!ok) return;

    setImporting(true);
    try {
      await api.importData(data);
      await clearApiCache();
      clearNoteDrafts();
      // Ponovno učitavanje je najjednostavniji način da sve stranice vide nove podatke.
      window.location.reload();
    } catch (err) {
      toast.error(errorMessage(err));
      setImporting(false);
    }
  };

  return (
    <Card title="Rezervna kopija">
      <Row label="Preuzmi kopiju" hint="Raspored, dani, zadaci i beleške ovog naloga u jednom JSON fajlu.">
        <Button icon="download" loading={exporting} onClick={() => void download()}>
          Preuzmi
        </Button>
      </Row>
      <Row label="Vrati iz kopije" hint="Zamenjuje sve podatke ovog naloga podacima iz fajla.">
        <Button icon="upload" loading={importing} onClick={() => fileRef.current?.click()}>
          Izaberi fajl…
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => void onFile(e)}
        />
      </Row>
    </Card>
  );
}

// ---- Raspored ispočetka ----

const RESET_KEEPS = 'Sačuvani dani, zadaci i beleške ostaju, a napredak ranijih dana se ne menja.';

/**
 * Briše ceo raspored (kategorije, šablone, dodelu šablona danima u nedelji) jednom potvrđenom akcijom —
 * npr. primer koji je ranija verzija upisivala u novu bazu. Ništa se ne briše bez potvrde. Kad nema
 * nijedne kategorije, šablona ni dodele (nova, prazna instalacija), kartica se ne prikazuje.
 */
function ResetSection() {
  const { categories, templates, weekdays, settings } = useScheduleData();
  const [resetDayStart, setResetDayStart] = useState(true);
  const [busy, setBusy] = useState(false);

  const mapped = Object.values(weekdays).some((t) => t != null);
  const dayStartSet = settings.dayStart !== 0;
  // Sam početak dana se menja u kartici Dan; ovde nema šta da se obriše.
  if (categories.length === 0 && templates.length === 0 && !mapped) return null;

  const withDayStart = dayStartSet && resetDayStart;

  const reset = async () => {
    const ok = await confirmDialog({
      title: 'Raspored ispočetka?',
      body: (
        <>
          <p>
            Brišu se sve kategorije ({categories.length}), šabloni ({templates.length}) i dodela šablona danima u
            nedelji{withDayStart ? ', a dan ponovo počinje u 00:00' : ''}. {RESET_KEEPS}
          </p>
          <p className="set-confirm-meta">Ako želiš da sačuvaš i ovaj raspored, prvo preuzmi kopiju.</p>
        </>
      ),
      confirmText: 'Obriši raspored',
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      scheduleStore.set(await api.resetSchedule(withDayStart ? { dayStart: true } : {}));
      toast.success('Raspored je obrisan. Napravi svoj na stranici Raspored.');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Raspored ispočetka">
      <div className="set-reset">
        <p className="set-row-hint">
          Briše sve kategorije, šablone i dodelu šablona danima u nedelji, da raspored napraviš od nule. {RESET_KEEPS}
        </p>
        {dayStartSet && (
          <Toggle
            checked={resetDayStart}
            onChange={setResetDayStart}
            disabled={busy}
            label={`Vrati i početak dana na 00:00 (sada ${fmtClock(settings.dayStart)})`}
          />
        )}
        <Button icon="trash" loading={busy} onClick={() => void reset()}>
          Obriši raspored…
        </Button>
      </div>
    </Card>
  );
}

// ---- Nalog ----

/** Email sa mestom za prelom posle "@" (dugačka adresa se ne cepa usred domena). */
function EmailText({ email }: { email: string }) {
  const at = email.lastIndexOf('@');
  if (at <= 0) return <>{email}</>;
  return (
    <>
      {email.slice(0, at + 1)}
      <wbr />
      {email.slice(at + 1)}
    </>
  );
}

const PASSWORD_MIN = 8;
const PASSWORD_MAX = 200;

function AccountSection() {
  const { user } = useSession();
  const [busy, setBusy] = useState(false);
  const [pwOpen, setPwOpen] = useState(false);

  const signOut = async () => {
    if (busy) return;
    setBusy(true);
    // Izmene koje još čekaju u redu (npr. beleška sačuvana pri izlasku sa dana) prvo stignu do servera.
    await settlePendingWrites();
    setBusy(false);
    // Nesačuvane beleške su samo na ovom uređaju; odjava ih briše (lični tekst ne ostaje posle odjave).
    const drafts = listNoteDraftDates();
    if (drafts.length > 0) {
      const ok = await confirmDialog({
        title: 'Imaš nesačuvanu belešku',
        body:
          drafts.length === 1
            ? `Beleška za ${fmtDateMedium(drafts[0])} nije sačuvana na serveru. Odjavom se briše sa ovog uređaja.`
            : `Beleške za ${drafts.map(fmtDateMedium).join(', ')} nisu sačuvane na serveru. Odjavom se brišu sa ovog uređaja.`,
        confirmText: 'Odjavi se',
        danger: true,
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      // App sluša 'ritam:unauthorized' i vraća na ekran za prijavu.
      await logout();
    } catch (e) {
      toast.error(errorMessage(e));
      setBusy(false);
    }
  };

  return (
    <Card title="Nalog">
      <Row
        label={<span className="set-email">{user ? <EmailText email={user.email} /> : 'Nalog'}</span>}
        hint="Prijavljen si ovim nalogom."
      />
      <Row label="Lozinka" hint="Posle promene, ostali uređaji moraju ponovo da se prijave.">
        <Button icon="lock" onClick={() => setPwOpen(true)}>
          Promeni lozinku
        </Button>
      </Row>
      <Row label="Odjava" hint="Za ponovni ulaz na ovom uređaju trebaju email i lozinka.">
        <Button icon="logout" loading={busy} onClick={() => void signOut()}>
          Odjavi se
        </Button>
      </Row>
      {pwOpen && <PasswordSheet email={user?.email ?? ''} onClose={() => setPwOpen(false)} />}
    </Card>
  );
}

// ---- Verzija ----

/**
 * Verzija aplikacije (oznaka build-a = heš glavnog JS fajla, ista koju server javlja u /api/health) i
 * ručna provera nove verzije. Nova verzija se prikazuje trakom na dnu ekrana (App.tsx).
 */
function VersionSection() {
  const [checking, setChecking] = useState(false);
  const build = buildLabel();

  const check = async () => {
    if (checking) return;
    setChecking(true);
    const result = await checkForUpdate(true);
    setChecking(false);
    if (result === 'latest') toast('Imaš najnoviju verziju.');
    else if (result === 'offline') toast('Nema konekcije.');
    else if (result === 'unavailable') toast.error('Server nije dostupan. Pokušaj ponovo.');
    else if (result === 'unknown') toast('Server ne javlja verziju, pa provera nije moguća.');
    // 'update': pojavi se traka "Dostupna je nova verzija." sa dugmetom Osveži.
  };

  return (
    <Card title="Verzija">
      <Row
        label={
          <span className="tabular">
            Ritam {APP_VERSION} · {build ?? 'razvoj'}
          </span>
        }
        hint="Nova verzija se proverava sama i nudi se trakom na dnu ekrana."
      >
        <Button icon="refresh" loading={checking} onClick={() => void check()}>
          Proveri ažuriranje
        </Button>
      </Row>
    </Card>
  );
}

/** Promena lozinke: trenutna + nova. Ostale sesije naloga se opozivaju, ovaj uređaj ostaje prijavljen. */
function PasswordSheet({ email, onClose }: { email: string; onClose: () => void }) {
  const formId = useId();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [errors, setErrors] = useState<{ current?: string; next?: string; form?: string }>({});
  const [busy, setBusy] = useState(false);
  const currentRef = useRef<HTMLInputElement>(null);
  const nextRef = useRef<HTMLInputElement>(null);

  const focus = (el: HTMLInputElement | null) =>
    window.requestAnimationFrame(() => {
      el?.focus();
      el?.select();
    });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const invalid: typeof errors = {};
    if (!current) invalid.current = 'Unesi trenutnu lozinku.';
    if (next.length < PASSWORD_MIN) invalid.next = `Lozinka mora imati bar ${PASSWORD_MIN} znakova.`;
    else if (next.length > PASSWORD_MAX) invalid.next = `Lozinka može imati najviše ${PASSWORD_MAX} znakova.`;
    if (invalid.current || invalid.next) {
      setErrors(invalid);
      focus(invalid.current ? currentRef.current : nextRef.current);
      return;
    }
    setBusy(true);
    setErrors({});
    try {
      await api.changePassword(current, next);
      toast.success('Lozinka je promenjena.');
      onClose();
    } catch (err) {
      const msg = errorMessage(err);
      if (err instanceof ApiError && err.code === 'bad_password') {
        setErrors({ current: msg });
        focus(currentRef.current);
      } else if (err instanceof ApiError && err.status === 400 && /trenutn/i.test(msg)) {
        setErrors({ current: msg });
        focus(currentRef.current);
      } else if (err instanceof ApiError && err.status === 400) {
        setErrors({ next: msg });
        focus(nextRef.current);
      } else {
        setErrors({ form: msg });
      }
      setBusy(false);
    }
  };

  return (
    <Sheet
      open
      onClose={onClose}
      title="Promeni lozinku"
      size="sm"
      footer={
        <>
          {errors.form && (
            <p className="set-foot-error" role="alert">
              {errors.form}
            </p>
          )}
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            Otkaži
          </Button>
          <Button variant="primary" type="submit" form={formId} loading={busy}>
            Sačuvaj
          </Button>
        </>
      }
    >
      <form id={formId} className="stack" onSubmit={submit} noValidate>
        {/* Menadžer lozinki tako zna za koji nalog čuva novu lozinku. */}
        <input type="email" name="email" autoComplete="username" value={email} readOnly hidden />
        <Field label="Trenutna lozinka" error={errors.current}>
          <TextInput
            ref={currentRef}
            type="password"
            name="current-password"
            autoComplete="current-password"
            data-autofocus
            maxLength={PASSWORD_MAX}
            value={current}
            onChange={(e) => {
              setCurrent(e.target.value);
              if (errors.current || errors.form) setErrors((x) => ({ ...x, current: undefined, form: undefined }));
            }}
            aria-invalid={errors.current ? true : undefined}
            enterKeyHint="next"
          />
        </Field>
        <Field label="Nova lozinka" error={errors.next} hint={`Bar ${PASSWORD_MIN} znakova.`}>
          <TextInput
            ref={nextRef}
            type="password"
            name="new-password"
            autoComplete="new-password"
            minLength={PASSWORD_MIN}
            maxLength={PASSWORD_MAX}
            value={next}
            onChange={(e) => {
              setNext(e.target.value);
              if (errors.next || errors.form) setErrors((x) => ({ ...x, next: undefined, form: undefined }));
            }}
            aria-invalid={errors.next ? true : undefined}
            enterKeyHint="done"
          />
        </Field>
      </form>
    </Sheet>
  );
}
