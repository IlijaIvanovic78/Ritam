import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/fonts.css';
import './styles/tokens.css';
import './styles/base.css';
import './styles/ui.css';
import './shell.css';
import App from './App.tsx';
import { initInstallPrompt, registerSW } from './lib/pwa.ts';
import { initTheme } from './lib/theme.ts';
import { initKeyboardInset } from './lib/viewport.ts';

// Tema pre prvog rendera, da ne trepne pogrešna pozadina.
initTheme();
// Ponuda za instalaciju može da stigne pre nego što korisnik otvori Podešavanja.
initInstallPrompt();
// Sheet-ovi i toast-ovi iznad tastature na telefonu.
initKeyboardInset();
// U dev režimu (Vite) SW bi keširao module i smetao HMR-u.
if (import.meta.env.PROD) registerSW();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
