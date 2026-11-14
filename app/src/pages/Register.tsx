import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { Marke, useApp } from '../App';
import { ApiError, auth, SIGNUP_GRUND } from '../lib/api';
import { AuthFoot } from './Login';

export default function Register() {
  const { session, reload, config } = useApp();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [code, setCode] = useState(params.get('code') ?? '');
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const codePflicht = !config.offene_registrierung;
  const preis = config.preis;

  if (session) return <Navigate to="/" replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setMsg('');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim())) { setMsg(SIGNUP_GRUND.email); return; }
    if (pw.length < 10) { setMsg(SIGNUP_GRUND.passwort); return; }
    if (codePflicht && code.trim().length < 8) { setMsg(SIGNUP_GRUND.code_noetig); return; }
    if (!ok) { setMsg(SIGNUP_GRUND.einwilligung); return; }
    setBusy(true);
    try {
      await auth.signUp({ email: email.trim(), password: pw, code: code.trim().toUpperCase(), consent: true });
      await auth.signIn(email, pw);
      await reload();
      void nav('/start', { replace: true });
    } catch (err) {
      const g = err instanceof ApiError ? err.grund ?? '' : '';
      setMsg(SIGNUP_GRUND[g] ?? 'Die Registrierung hat nicht geklappt. Bitte versuch es noch einmal.');
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
            <h1>Konto anlegen</h1>
            <p className="muted small">
              {preis ? `${preis.probe_tage} Tage gratis testen. Danach ${preis.betrag_eur} € pro Monat, jederzeit im Konto kündbar.` : 'Teste Jobbster gratis.'}
              {codePflicht ? ' Gerade nur mit Einladungscode.' : ''}
            </p>
          </div>
          <label className="field"><span>E-Mail-Adresse</span>
            <input className="input" id="reg-email" type="email" autoComplete="email" inputMode="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </label>
          <label className="field"><span>Passwort</span>
            <input className="input" id="reg-pw" type="password" autoComplete="new-password" minLength={10} value={pw} onChange={(e) => setPw(e.target.value)} aria-describedby="reg-pw-hint" required />
            <small id="reg-pw-hint">Mindestens 10 Zeichen.</small>
          </label>
          <label className="field"><span>Einladungscode{codePflicht ? '' : ' (falls du einen hast)'}</span>
            <input className="input nums" id="reg-code" autoComplete="off" autoCapitalize="characters" spellCheck={false} value={code} onChange={(e) => setCode(e.target.value)} placeholder="ZS-XXXX-XXXX-XXXX-XXXX" />
          </label>
          <label className="check"><input id="reg-ok" type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} />
            <span>Ich stimme der <Link to="/datenschutz" target="_blank">Datenschutzerklärung</Link> und den <Link to="/bedingungen" target="_blank">Bedingungen</Link> zu. Mein Lebenslauf wird dafür über die Claude API von Anthropic (USA) verarbeitet.</span>
          </label>
          <button className="btn big wide" type="submit" disabled={busy}>{busy ? <span className="spinner" aria-hidden="true" /> : null}Konto anlegen</button>
          <p className="msg err" role="alert">{msg}</p>
        </form>
        <p className="muted small" style={{ textAlign: 'center' }}>Schon ein Konto? <Link to="/anmelden">Anmelden</Link></p>
        <AuthFoot />
      </div>
    </main>
  );
}
