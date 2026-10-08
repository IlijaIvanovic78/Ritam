// Prijava lozinkom (jedan korisnik). Prikazuje se kad server traži lozinku.

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, errorMessage } from '../api.ts';
import { Button, Field, TextInput, Wordmark } from '../ui/index.ts';
import './login.css';

export default function LoginPage({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    document.title = 'Prijava · Ritam';
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!password) {
      setError('Unesi lozinku.');
      inputRef.current?.focus();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const state = await api.login(password);
      if (state.authenticated || !state.authRequired) {
        onLoggedIn();
        return;
      }
      setError('Pogrešna lozinka.');
    } catch (err) {
      setError(errorMessage(err));
    }
    setBusy(false);
    // Posle greške lozinka ostaje označena da može odmah da se prekuca.
    window.requestAnimationFrame(() => inputRef.current?.select());
  };

  return (
    <div className="login">
      <form className="login-box" onSubmit={submit} noValidate>
        <div className="login-head">
          <h1 className="login-title">
            <Wordmark height={64} />
          </h1>
          <p className="login-sub">Unesi lozinku da nastaviš.</p>
        </div>

        {/* Skriveno korisničko ime pomaže menadžerima lozinki da sačuvaju lozinku. */}
        <input type="text" name="username" autoComplete="username" value="ritam" readOnly hidden />

        <Field label="Lozinka" error={error}>
          <TextInput
            ref={inputRef}
            type="password"
            name="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
              if (error) setError(null);
            }}
            aria-invalid={error ? true : undefined}
            enterKeyHint="go"
          />
        </Field>

        <Button type="submit" variant="primary" block loading={busy}>
          Uđi
        </Button>
      </form>
    </div>
  );
}
