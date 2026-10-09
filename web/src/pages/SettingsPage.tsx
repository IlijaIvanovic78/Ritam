// Podešavanja: jezik, tema, početak dana, prag za niz, instalacija, rezervna kopija, raspored ispočetka, nalog,
// verzija aplikacije.

import { useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from 'react';
import { htmlLang } from '../../../shared/i18n.ts';
import type { Lang } from '../../../shared/types.ts';
import { fmtClock, fmtDateMedium, fmtDateShort, localISODate, parseClock } from '../../../shared/time.ts';
import { ApiError, api, errorMessage } from '../api.ts';
import { LANGS, joinAnd, setLang, tIn, useLang, useT, type TFunction } from '../i18n/index.ts';
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

const THEMES: ThemePref[] = ['dark', 'light', 'system'];

const THRESHOLD_OPTIONS = [50, 60, 70, 80, 90].map((v) => ({ value: v, label: `${v}%` }));

export default function SettingsPage() {
  const t = useT();
  return (
    <div className="page">
      <PageHeader title={t('shell.page.settings')} />
      <div className="set-body">
        <LanguageSection />
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

// ---- Jezik ----

/**
 * Jezik interfejsa: menja se odmah na ovom uređaju, pa se upisuje u nalog (važi na svim uređajima naloga). Ako
 * čuvanje ne uspe, jezik se vraća, a poruka je na vraćenom jeziku (greška sa servera / iz SW-a je već stigla na
 * novom jeziku, jer je zahtev otišao sa njim u X-Ritam-Lang). Naziv kartice i jezika su čitljivi na oba jezika
 * ("Language · Jezik").
 */
function LanguageSection() {
  const t = useT();
  const lang = useLang();
  const [saving, setSaving] = useState(false);
  const options = LANGS.map((l) => ({
    value: l,
    label: <span lang={htmlLang(l)}>{t(`lang.${l}` as const)}</span>,
  }));

  const change = async (next: Lang) => {
    if (next === lang || saving) return;
    const prev = lang;
    setLang(next);
    setSaving(true);
    try {
      scheduleStore.set(await api.patchSettings({ lang: next }));
    } catch {
      setLang(prev);
      toast.error(tIn(prev, 'settings.language.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card title={t('lang.label')}>
      <Row hint={t('settings.language.hint')}>
        <div className={cx('set-seg-wrap', saving && 'set-busy')} aria-busy={saving || undefined}>
          <Segmented
            label={t('lang.label')}
            value={lang}
            options={options}
            onChange={(v) => void change(v)}
            className="set-seg"
          />
        </div>
      </Row>
    </Card>
  );
}

// ---- Izgled ----

function AppearanceSection() {
  const t = useT();
  const theme = useTheme();
  const options = THEMES.map((v) => ({ value: v, label: t(`settings.theme.${v}` as const) }));
  return (
    <Card title={t('settings.appearance.title')}>
      <Row hint={t('settings.appearance.hint')}>
        <div className="set-seg-wrap">
          <Segmented
            label={t('settings.theme.label')}
            value={theme}
            options={options}
            onChange={setTheme}
            className="set-seg"
          />
        </div>
      </Row>
    </Card>
  );
}

// ---- Dan i niz ----

function DaySection() {
  const t = useT();
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
      toast.success(t('settings.day.startSaved'));
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
    <Card title={t('settings.day.title')}>
      <Row label={t('settings.day.start')} hint={t('settings.day.startHint')}>
        <form
          className="set-inline"
          onSubmit={(e) => {
            e.preventDefault();
            void saveDayStart();
          }}
        >
          <TimeInput
            aria-label={t('settings.day.start')}
            className="set-time"
            min="00:00"
            max="06:00"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-invalid={invalid || undefined}
            aria-describedby={invalid ? 'set-day-start-error' : undefined}
          />
          <Button type="submit" disabled={!dirty} loading={savingStart}>
            {t('common.save')}
          </Button>
        </form>
        {invalid && (
          <p className="set-error" id="set-day-start-error">
            {t('settings.day.startInvalid')}
          </p>
        )}
      </Row>
      <Row label={t('settings.day.threshold')} hint={t('settings.day.thresholdHint')}>
        <div className={cx('set-seg-wrap', savingThreshold && 'set-busy')} aria-busy={savingThreshold || undefined}>
          <Segmented
            label={t('settings.day.threshold')}
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
  const t = useT();
  const { canInstall, installed, promptInstall } = useInstallPrompt();
  const standalone = installed || isStandalone();

  const install = async () => {
    try {
      if (await promptInstall()) toast.success(t('settings.install.done'));
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };

  // Već instalirana aplikacija: kartica nema šta da ponudi.
  if (standalone) return null;

  return (
    <Card title={t('settings.install.title')}>
      {canInstall ? (
        <Row hint={t('settings.install.hint')}>
          <Button variant="secondary" icon="download" onClick={() => void install()}>
            {t('settings.install.button')}
          </Button>
        </Row>
      ) : (
        <div className="set-install">
          <p className="set-row-hint">{t('settings.install.hint')}</p>
          <dl className="set-steps">
            <div>
              <dt>iPhone</dt>
              <dd>{t('settings.install.iphone')}</dd>
            </div>
            <div>
              <dt>Android</dt>
              <dd>{t('settings.install.android')}</dd>
            </div>
            <div>
              <dt>{t('settings.install.laptop')}</dt>
              <dd>{t('settings.install.laptopSteps')}</dd>
            </div>
          </dl>
          {!window.isSecureContext && <p className="set-row-hint">{t('settings.install.httpsOnly')}</p>}
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

/** en "Oct 7, 2026 at 21:14", sr "7. okt 2026. u 21:14" iz ISO vremena; null ako nije ispravno. */
function fmtExportedAt(v: unknown, lang: Lang, t: TFunction): string | null {
  if (typeof v !== 'string') return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return t('settings.backup.when', {
    date: fmtDateShort(localISODate(d), lang),
    year: d.getFullYear(),
    time: fmtClock(d.getHours() * 60 + d.getMinutes()),
  });
}

function BackupSection() {
  const t = useT();
  const lang = useLang();
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
      toast.error(t('settings.backup.tooLarge'));
      return;
    }

    let data: unknown;
    try {
      data = JSON.parse(await file.text());
    } catch {
      toast.error(t('settings.backup.notJson'));
      return;
    }
    if (!isBackup(data)) {
      toast.error(t('settings.backup.notBackup'));
      return;
    }

    const when = fmtExportedAt(data.exportedAt, lang, t);
    const ok = await confirmDialog({
      title: t('settings.backup.confirmTitle'),
      body: (
        <>
          <p>{t('settings.backup.confirmBody')}</p>
          {when && <p className="set-confirm-meta">{t('settings.backup.createdAt', { when })}</p>}
        </>
      ),
      confirmText: t('settings.backup.confirm'),
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
    <Card title={t('settings.backup.title')}>
      <Row label={t('settings.backup.download')} hint={t('settings.backup.downloadHint')}>
        <Button icon="download" loading={exporting} onClick={() => void download()}>
          {t('settings.backup.downloadButton')}
        </Button>
      </Row>
      <Row label={t('settings.backup.restore')} hint={t('settings.backup.restoreHint')}>
        <Button icon="upload" loading={importing} onClick={() => fileRef.current?.click()}>
          {t('settings.backup.chooseFile')}
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

/**
 * Briše ceo raspored (kategorije, šablone, dodelu šablona danima u nedelji) jednom potvrđenom akcijom —
 * npr. primer koji je ranija verzija upisivala u novu bazu. Ništa se ne briše bez potvrde. Kad nema
 * nijedne kategorije, šablona ni dodele (nova, prazna instalacija), kartica se ne prikazuje.
 */
function ResetSection() {
  const t = useT();
  const { categories, templates, weekdays, settings } = useScheduleData();
  const [resetDayStart, setResetDayStart] = useState(true);
  const [busy, setBusy] = useState(false);

  const mapped = Object.values(weekdays).some((t) => t != null);
  const dayStartSet = settings.dayStart !== 0;
  // Sam početak dana se menja u kartici Dan; ovde nema šta da se obriše.
  if (categories.length === 0 && templates.length === 0 && !mapped) return null;

  const withDayStart = dayStartSet && resetDayStart;
  const keeps = t('settings.reset.keeps');

  const reset = async () => {
    const counts = { categories: categories.length, templates: templates.length, keeps };
    const ok = await confirmDialog({
      title: t('settings.reset.confirmTitle'),
      body: (
        <>
          <p>
            {withDayStart ? t('settings.reset.confirmBodyDayStart', counts) : t('settings.reset.confirmBody', counts)}
          </p>
          <p className="set-confirm-meta">{t('settings.reset.confirmMeta')}</p>
        </>
      ),
      confirmText: t('settings.reset.confirm'),
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      scheduleStore.set(await api.resetSchedule(withDayStart ? { dayStart: true } : {}));
      toast.success(t('settings.reset.done'));
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title={t('settings.reset.title')}>
      <div className="set-reset">
        <p className="set-row-hint">{t('settings.reset.hint', { keeps })}</p>
        {dayStartSet && (
          <Toggle
            checked={resetDayStart}
            onChange={setResetDayStart}
            disabled={busy}
            label={t('settings.reset.dayStartToo', { time: fmtClock(settings.dayStart) })}
          />
        )}
        <Button icon="trash" loading={busy} onClick={() => void reset()}>
          {t('settings.reset.button')}
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
  const t = useT();
  const lang = useLang();
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
      const one = drafts.length === 1;
      const ok = await confirmDialog({
        title: t(one ? 'settings.account.draftTitle' : 'settings.account.draftTitleMany'),
        body: one
          ? t('settings.account.draftOne', { date: fmtDateMedium(drafts[0], lang) })
          : // Kratki datumi bez zareza ("Oct 6 and Oct 8"): "Thu, Oct 8" u nabrajanju bi se slio u jedan niz.
            t('settings.account.draftMany', { dates: joinAnd(drafts.map((d) => fmtDateShort(d, lang)), lang) }),
        confirmText: t('settings.account.signOut'),
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
    <Card title={t('settings.account.title')}>
      <Row
        label={
          <span className="set-email">{user ? <EmailText email={user.email} /> : t('settings.account.title')}</span>
        }
        hint={t('settings.account.signedIn')}
      />
      <Row label={t('settings.account.password')} hint={t('settings.account.passwordHint')}>
        <Button icon="lock" onClick={() => setPwOpen(true)}>
          {t('settings.account.changePassword')}
        </Button>
      </Row>
      <Row label={t('settings.account.signOutLabel')} hint={t('settings.account.signOutHint')}>
        <Button icon="logout" loading={busy} onClick={() => void signOut()}>
          {t('settings.account.signOut')}
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
  const t = useT();
  const [checking, setChecking] = useState(false);
  const build = buildLabel();

  const check = async () => {
    if (checking) return;
    setChecking(true);
    const result = await checkForUpdate(true);
    setChecking(false);
    if (result === 'latest') toast(t('settings.version.latest'));
    else if (result === 'offline') toast(t('error.offline'));
    else if (result === 'unavailable') toast.error(t('error.unavailable'));
    else if (result === 'unknown') toast(t('settings.version.unknown'));
    // 'update': pojavi se traka nove verzije (update.available) sa dugmetom Osveži.
  };

  return (
    <Card title={t('settings.version.title')}>
      <Row
        label={
          <span className="tabular">
            Ritam {APP_VERSION} · {build ?? t('settings.version.dev')}
          </span>
        }
        hint={t('settings.version.hint')}
      >
        <Button icon="refresh" loading={checking} onClick={() => void check()}>
          {t('settings.version.check')}
        </Button>
      </Row>
    </Card>
  );
}

/** Promena lozinke: trenutna + nova. Ostale sesije naloga se opozivaju, ovaj uređaj ostaje prijavljen. */
function PasswordSheet({ email, onClose }: { email: string; onClose: () => void }) {
  const t = useT();
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
    if (!current) invalid.current = t('settings.password.currentRequired');
    if (next.length < PASSWORD_MIN) invalid.next = t('login.passwordMin', { min: PASSWORD_MIN });
    else if (next.length > PASSWORD_MAX) invalid.next = t('login.passwordMax', { max: PASSWORD_MAX });
    if (invalid.current || invalid.next) {
      setErrors(invalid);
      focus(invalid.current ? currentRef.current : nextRef.current);
      return;
    }
    setBusy(true);
    setErrors({});
    try {
      await api.changePassword(current, next);
      toast.success(t('settings.password.changed'));
      onClose();
    } catch (err) {
      const msg = errorMessage(err);
      if (err instanceof ApiError && err.code === 'bad_password') {
        setErrors({ current: msg });
        focus(currentRef.current);
      } else if (err instanceof ApiError && err.status === 400 && /trenutn|current/i.test(msg)) {
        // Poruka servera je na jeziku interfejsa (X-Ritam-Lang).
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
      title={t('settings.account.changePassword')}
      size="sm"
      footer={
        <>
          {errors.form && (
            <p className="set-foot-error" role="alert">
              {errors.form}
            </p>
          )}
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" type="submit" form={formId} loading={busy}>
            {t('common.save')}
          </Button>
        </>
      }
    >
      <form id={formId} className="stack" onSubmit={submit} noValidate>
        {/* Menadžer lozinki tako zna za koji nalog čuva novu lozinku. */}
        <input type="email" name="email" autoComplete="username" value={email} readOnly hidden />
        <Field label={t('settings.password.current')} error={errors.current}>
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
        <Field
          label={t('settings.password.new')}
          error={errors.next}
          hint={t('login.passwordHint', { min: PASSWORD_MIN })}
        >
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
