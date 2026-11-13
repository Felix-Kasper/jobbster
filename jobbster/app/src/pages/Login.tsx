import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Marke, useApp } from '../App';
import { ApiError, auth } from '../lib/api';
import { SUPPORT_EMAIL } from '../lib/config';

export function AuthFoot() {
  return (
    <nav className="auth-foot" aria-label="Rechtliches">
      <Link to="/impressum">Impressum</Link><Link to="/datenschutz">Datenschutz</Link><Link to="/bedingungen">Bedingungen</Link>
    </nav>
  );
}

export default function Login() {
  const { session, reload } = useApp();
  const nav = useNavigate();
  const loc = useLocation();
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const ziel = (loc.state as { von?: string } | null)?.von ?? '/';

  if (session) return <Navigate to={ziel} replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!email.trim() || !pw) { setMsg('Bitte E-Mail und Passwort eingeben.'); return; }
    setBusy(true); setMsg('');
    try {
      await auth.signIn(email, pw);
      await reload();
      void nav(ziel, { replace: true });
    } catch (err) {
      setMsg(err instanceof ApiError ? err.message : 'Die Anmeldung hat nicht geklappt.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="auth">
      <div className="auth-box fade-in">
        <Marke to="/" />
        <form className="auth-card" onSubmit={(e) => { void submit(e); }} noValidate>
          <div>
            <h1>Anmelden</h1>
            <p className="muted small">Willkommen zurück.</p>
          </div>
          <label className="field"><span>E-Mail-Adresse</span>
            <input className="input" id="login-email" type="email" autoComplete="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </label>
          <label className="field"><span>Passwort</span>
            <input className="input" id="login-pw" type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} required />
          </label>
          <button className="btn big wide" type="submit" disabled={busy}>{busy ? <span className="spinner" aria-hidden="true" /> : null}Anmelden</button>
          <p className="msg err" role="alert">{msg}</p>
          {SUPPORT_EMAIL && <p className="muted small">Passwort vergessen? Schreib von deiner Adresse an {SUPPORT_EMAIL}, dann setzen wir es zurück.</p>}
        </form>
        <p className="muted small" style={{ textAlign: 'center' }}>Noch kein Konto? <Link to="/registrieren">Registrieren</Link></p>
        <AuthFoot />
      </div>
    </main>
  );
}
