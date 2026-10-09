// Prijava i registracija naloga (email + lozinka). Prikazuje se kad sesija ne postoji ili je
// istekla. Bez drugih ekrana: nema resetovanja lozinke ni dvostepene provere.

import { Fragment, useEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import { htmlLang } from '../../../shared/i18n.ts';
import type { AuthConfig, AuthUser } from '../../../shared/types.ts';
import { ApiError, api, errorMessage } from '../api.ts';
import { LANGS, setLang, useLang, useT } from '../i18n/index.ts';
import { Button, Field, TextInput, Wordmark } from '../ui/index.ts';
import './login.css';

type Mode = 'login' | 'register';
type Signup = AuthConfig['signup'];
type FieldName = 'email' | 'password' | 'code';
type Errors = Partial<Record<FieldName | 'form', string>>;

const PASSWORD_MIN = 8;
const PASSWORD_MAX = 200;
const EMAIL_MAX = 254;
/** Isto kao osnovna provera na serveru: nešto@nešto.domen. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default function LoginPage({ onLoggedIn }: { onLoggedIn: (user: AuthUser) => void | Promise<void> }) {
  const t = useT();
  const [mode, setMode] = useState<Mode>('login');
  /** null = još nije poznato (server nije odgovorio) — opcija registracije se tada ne nudi. */
  const [signup, setSignup] = useState<Signup | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  const register = mode === 'register';
  const needsCode = register && signup === 'code';

  const docTitle = register ? t('login.titleRegister') : t('login.titleSignIn');
  useEffect(() => {
    document.title = docTitle;
  }, [docTitle]);

  // Promena jezika ispod forme: prikazane greške su na prethodnom jeziku — sklanjaju se (sledeći pokušaj ih
  // prikazuje ponovo, na novom jeziku).
  const lang = useLang();
  const shownLang = useRef(lang);
  useEffect(() => {
    if (shownLang.current === lang) return;
    shownLang.current = lang;
    setErrors({});
  }, [lang]);

  // Da li se nudi registracija (i da li traži kod). Bez mreže se proverava ponovo kad mreža stigne.
  useEffect(() => {
    let alive = true;
    const load = () => {
      api
        .authConfig()
        .then((c) => {
          if (alive) setSignup(c.signup);
        })
        .catch(() => {});
    };
    load();
    window.addEventListener('online', load);
    return () => {
      alive = false;
      window.removeEventListener('online', load);
    };
  }, []);

  const refs: Record<FieldName, RefObject<HTMLInputElement | null>> = {
    email: emailRef,
    password: passwordRef,
    code: codeRef,
  };

  /** Fokus (i označen tekst) na prvo polje sa greškom, posle rendera. */
  const focusField = (name: FieldName | undefined) => {
    if (!name) return;
    window.requestAnimationFrame(() => {
      const el = refs[name].current;
      el?.focus();
      el?.select();
    });
  };

  const switchMode = (next: Mode) => {
    if (busy) return;
    setMode(next);
    setErrors({});
    window.requestAnimationFrame(() => {
      const empty = !email.trim() ? emailRef.current : passwordRef.current;
      empty?.focus();
    });
  };

  const validate = (): Errors => {
    const e: Errors = {};
    const em = email.trim();
    if (!em || em.length > EMAIL_MAX || !EMAIL_RE.test(em)) e.email = t('login.emailInvalid');
    if (!password) e.password = register ? t('login.passwordMin', { min: PASSWORD_MIN }) : t('login.passwordRequired');
    else if (register && password.length < PASSWORD_MIN) e.password = t('login.passwordMin', { min: PASSWORD_MIN });
    else if (register && password.length > PASSWORD_MAX) e.password = t('login.passwordMax', { max: PASSWORD_MAX });
    if (needsCode && !code.trim()) e.code = t('login.codeRequired');
    return e;
  };

  /** Greška servera ide uz polje na koje se odnosi. */
  const serverErrors = (err: unknown): Errors => {
    const msg = errorMessage(err);
    if (!(err instanceof ApiError)) return { form: msg };
    if (err.code === 'bad_code') {
      // Server traži kod iako ovde nije bilo poznato (podešavanje je promenjeno).
      if (signup !== 'code') setSignup('code');
      return { code: msg };
    }
    if (err.code === 'signup_closed') {
      setSignup('closed');
      setMode('login');
      return { form: msg };
    }
    if (err.status === 409) return { email: msg };
    if (err.status === 401) return { password: msg };
    if (err.status === 400) {
      // Poruka servera je na jeziku interfejsa (X-Ritam-Lang).
      if (/email/i.test(msg)) return { email: msg };
      if (/lozink|password/i.test(msg)) return { password: msg };
      if (/kod|code/i.test(msg)) return { code: msg };
    }
    // 429 (previše pokušaja), greška mreže, server nedostupan…
    return { form: msg };
  };

  const firstField = (e: Errors): FieldName | undefined =>
    (['email', 'password', 'code'] as const).find((k) => e[k] != null);

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    if (busy) return;
    const invalid = validate();
    if (Object.keys(invalid).length > 0) {
      setErrors(invalid);
      focusField(firstField(invalid));
      return;
    }
    setBusy(true);
    setErrors({});
    const em = email.trim();
    try {
      const r = register ? await api.register(em, password, needsCode ? code.trim() : undefined) : await api.login(em, password);
      // App prelazi na aplikaciju (ova stranica nestaje); dugme ostaje zauzeto do tada.
      await onLoggedIn(r.user);
      return;
    } catch (err) {
      const e = serverErrors(err);
      setErrors(e);
      setBusy(false);
      focusField(firstField(e) ?? (e.form ? 'password' : undefined));
    }
  };

  const clearError = (name: FieldName) => {
    if (errors[name] || errors.form) setErrors((e) => ({ ...e, [name]: undefined, form: undefined }));
  };

  const canRegister = signup === 'open' || signup === 'code';

  return (
    <div className="login">
      <form className="login-box" onSubmit={submit} noValidate aria-busy={busy || undefined}>
        <div className="login-head">
          <h1 className="login-title">
            <Wordmark height={64} />
          </h1>
          <p className="login-sub">{register ? t('login.subRegister') : t('login.subSignIn')}</p>
        </div>

        <Field label={t('login.email')} error={errors.email}>
          <TextInput
            ref={emailRef}
            type="email"
            name="email"
            autoComplete="username"
            inputMode="email"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            autoFocus
            maxLength={EMAIL_MAX}
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              clearError('email');
            }}
            aria-invalid={errors.email ? true : undefined}
            enterKeyHint="next"
          />
        </Field>

        <Field
          label={t('login.password')}
          error={errors.password}
          hint={register ? t('login.passwordHint', { min: PASSWORD_MIN }) : undefined}
        >
          <TextInput
            ref={passwordRef}
            type="password"
            name="password"
            autoComplete={register ? 'new-password' : 'current-password'}
            minLength={register ? PASSWORD_MIN : undefined}
            maxLength={PASSWORD_MAX}
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              clearError('password');
            }}
            aria-invalid={errors.password ? true : undefined}
            enterKeyHint={needsCode ? 'next' : 'go'}
          />
        </Field>

        {needsCode && (
          <Field label={t('login.code')} error={errors.code} hint={t('login.codeHint')}>
            <TextInput
              ref={codeRef}
              name="signup-code"
              autoComplete="off"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              maxLength={200}
              value={code}
              onChange={(e) => {
                setCode(e.target.value);
                clearError('code');
              }}
              aria-invalid={errors.code ? true : undefined}
              enterKeyHint="go"
            />
          </Field>
        )}

        {errors.form && (
          <p className="login-error" role="alert">
            {errors.form}
          </p>
        )}

        <Button type="submit" variant="primary" block loading={busy}>
          {register ? t('login.createAccount') : t('login.signIn')}
        </Button>

        {(register || canRegister) && (
          <p className="login-switch">
            {register ? t('login.haveAccount') : t('login.noAccount')}{' '}
            <button type="button" className="login-link" onClick={() => switchMode(register ? 'login' : 'register')}>
              {register ? t('login.signIn') : t('login.createAccount')}
            </button>
          </p>
        )}
      </form>
      <LanguageSwitch />
    </div>
  );
}

/**
 * Tih izbor jezika ispod forme ("English · Srpski"): menja jezik na ovom uređaju odmah; pri registraciji
 * izabran jezik postaje jezik naloga, a posle prijave važi jezik naloga.
 */
function LanguageSwitch() {
  const t = useT();
  const lang = useLang();
  return (
    <div className="login-lang" role="group" aria-label={t('lang.label')}>
      {LANGS.map((l, i) => (
        <Fragment key={l}>
          {i > 0 && <span aria-hidden="true">·</span>}
          <button
            type="button"
            className="login-lang-btn"
            lang={htmlLang(l)}
            aria-pressed={lang === l}
            onClick={() => setLang(l)}
          >
            {t(`lang.${l}` as const)}
          </button>
        </Fragment>
      ))}
    </div>
  );
}
