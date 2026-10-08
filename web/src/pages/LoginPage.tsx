// Prijava i registracija naloga (email + lozinka). Prikazuje se kad sesija ne postoji ili je
// istekla. Bez drugih ekrana: nema resetovanja lozinke ni dvostepene provere.

import { useEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import type { AuthConfig, AuthUser } from '../../../shared/types.ts';
import { ApiError, api, errorMessage } from '../api.ts';
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

  useEffect(() => {
    document.title = register ? 'Novi nalog · Ritam' : 'Prijava · Ritam';
  }, [register]);

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
    if (!em || em.length > EMAIL_MAX || !EMAIL_RE.test(em)) e.email = 'Unesi ispravnu email adresu.';
    if (!password) e.password = register ? `Lozinka mora imati bar ${PASSWORD_MIN} znakova.` : 'Unesi lozinku.';
    else if (register && password.length < PASSWORD_MIN) e.password = `Lozinka mora imati bar ${PASSWORD_MIN} znakova.`;
    else if (register && password.length > PASSWORD_MAX) e.password = `Lozinka može imati najviše ${PASSWORD_MAX} znakova.`;
    if (needsCode && !code.trim()) e.code = 'Unesi kod za registraciju.';
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
      if (/email/i.test(msg)) return { email: msg };
      if (/lozink/i.test(msg)) return { password: msg };
      if (/kod/i.test(msg)) return { code: msg };
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
          <p className="login-sub">{register ? 'Napravi nalog da počneš.' : 'Prijavi se da nastaviš.'}</p>
        </div>

        <Field label="Email" error={errors.email}>
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

        <Field label="Lozinka" error={errors.password} hint={register ? `Bar ${PASSWORD_MIN} znakova.` : undefined}>
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
          <Field label="Kod za registraciju" error={errors.code} hint="Kod postavlja onaj ko vodi server.">
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
          {register ? 'Napravi nalog' : 'Prijavi se'}
        </Button>

        {(register || canRegister) && (
          <p className="login-switch">
            {register ? 'Već imaš nalog?' : 'Nemaš nalog?'}{' '}
            <button type="button" className="login-link" onClick={() => switchMode(register ? 'login' : 'register')}>
              {register ? 'Prijavi se' : 'Napravi nalog'}
            </button>
          </p>
        )}
      </form>
    </div>
  );
}
