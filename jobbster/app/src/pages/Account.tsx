import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useApp } from '../App';
import { ApiError, auth, billing, BILLING_GRUND, deleteAccount, exportAll, redeemCode, sendFeedback } from '../lib/api';
import { download } from '../lib/docs';
import { formatDate } from '../lib/logic';

const CODE_GRUND: Record<string, string> = {
  code: 'Dieser Code gilt nicht oder wurde schon eingelöst.',
  nur_neue_konten: 'Probe-Codes gelten nur für neue Konten.',
  kein_zugang: 'Dein Konto ist gesperrt.',
  nicht_angemeldet: 'Du bist nicht mehr angemeldet.',
};

export default function Account() {
  const { session, member, access, config, reload } = useApp();
  const nav = useNavigate();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<Record<string, { text: string; ok: boolean }>>({});
  const [code, setCode] = useState('');
  const [fb, setFb] = useState('');
  const [pw, setPw] = useState('');
  const [loeschen, setLoeschen] = useState('');
  const say = (k: string, text: string, ok = false) => setMsg((m) => ({ ...m, [k]: { text, ok } }));
  const preis = config.preis;
  const [params, setParams] = useSearchParams();
  const rueckkehr = params.get('zahlung');
  const [warten, setWarten] = useState(rueckkehr === 'ok');

  // Zurück von Stripe: Der Webhook bucht das Abo meist in wenigen Sekunden. So lange den Stand neu laden.
  useEffect(() => {
    if (rueckkehr !== 'ok') return;
    let n = 0;
    let aus = false;
    const t = setInterval(() => {
      n += 1;
      void reload().finally(() => { if (n >= 8 && !aus) { aus = true; clearInterval(t); setWarten(false); } });
    }, 2500);
    return () => { aus = true; clearInterval(t); };
  }, [rueckkehr, reload]);
  const bestaetigt = rueckkehr === 'ok' && (member?.sub_status === 'trialing' || member?.sub_status === 'active');

  async function zahlung(action: 'checkout' | 'portal') {
    setBusy(action); say('abo', '');
    try {
      const url = await billing(action);
      window.location.assign(url);
    } catch (e) {
      const g = e instanceof ApiError ? e.grund ?? '' : '';
      say('abo', BILLING_GRUND[g] ?? 'Die Zahlungsseite ließ sich nicht öffnen. Bitte versuch es später.');
      setBusy(null);
    }
  }

  async function einloesen(e: FormEvent) {
    e.preventDefault();
    if (code.trim().length < 8) { say('code', 'Bitte gib den ganzen Code ein.'); return; }
    setBusy('code');
    try {
      const r = await redeemCode(code);
      if (r.ok) { say('code', r.gueltig_bis ? `Eingelöst. Dein Zugang läuft jetzt bis ${formatDate(r.gueltig_bis)}.` : 'Eingelöst.', true); setCode(''); await reload(); }
      else say('code', CODE_GRUND[r.grund ?? ''] ?? 'Der Code ließ sich nicht einlösen.');
    } catch (err) { say('code', err instanceof ApiError ? err.message : 'Das hat nicht geklappt.'); }
    finally { setBusy(null); }
  }

  const istAbo = !!member?.stripe_customer_id || member?.plan === 'abo';
  const kannProbe = !member?.trial_used && !istAbo;

  const status = access.aktiv ? (member?.sub_status === 'past_due' || member?.cancel_at_period_end ? 'warn' : 'an') : '';

  return (
    <div className="stack">
      <div className="page-title"><div><h1>Konto</h1><p>Zugang, Abo und deine Daten.</p></div></div>

      {rueckkehr === 'ok' && (
        <div className={`banner ${bestaetigt ? 'ok' : ''} fade-in`} role="status">
          <span>{bestaetigt ? 'Danke! Dein Abo ist aktiv.' : warten ? 'Zahlung erhalten. Dein Zugang wird gerade freigeschaltet …' : 'Die Bestätigung von Stripe dauert länger als üblich. Lade die Seite in einer Minute neu.'}</span>
          <button className="btn ghost" onClick={() => setParams({}, { replace: true })}>Ausblenden</button>
        </div>
      )}
      {rueckkehr === 'abbruch' && (
        <div className="banner fade-in" role="status"><span>Bezahlung abgebrochen. Es wurde nichts abgebucht.</span><button className="btn ghost" onClick={() => setParams({}, { replace: true })}>Ausblenden</button></div>
      )}

      <section className="card plan" aria-labelledby="k-zugang">
        <div className="stack" style={{ gap: 4 }}>
          <h2 id="k-zugang" className="status"><i className={status} aria-hidden="true" />{access.titel}</h2>
          <p className="lead-text">{access.text}</p>
          {preis && <p className="muted small">{preis.betrag_eur} € pro Monat nach {preis.probe_tage} Tagen Probe. Monatlich kündbar, die Kündigung gilt zum Ende des bezahlten Monats. 14 Tage Rücktrittsrecht.</p>}
          {istAbo && <p className="muted small">Kündigen, Zahlungsart ändern und Rechnungen laden geht auf der sicheren Seite von Stripe.</p>}
          <p className={`msg ${msg.abo?.ok ? 'ok' : 'err'}`} role="status">{msg.abo?.text}</p>
        </div>
        <div className="row">
          {istAbo
            ? <button className="btn big" onClick={() => { void zahlung('portal'); }} disabled={!!busy}>{busy === 'portal' ? <span className="spinner" aria-hidden="true" /> : null}Abo verwalten oder kündigen</button>
            : <button className="btn big" onClick={() => { void zahlung('checkout'); }} disabled={!!busy}>{busy === 'checkout' ? <span className="spinner" aria-hidden="true" /> : null}{kannProbe ? `${preis?.probe_tage ?? 7} Tage gratis testen` : 'Abo starten'}</button>}
        </div>
      </section>

      <div className="split">
        <form className="card stack" onSubmit={(e) => { void einloesen(e); }} aria-labelledby="k-code">
          <div className="section-head"><h2 id="k-code">Code einlösen</h2><p>Für Gutscheine, Geschenke und Garantie-Monate.</p></div>
          <div className="row">
            <input className="input nums" id="k-code-feld" style={{ flex: '1 1 200px', width: 'auto' }} autoComplete="off" autoCapitalize="characters" spellCheck={false} value={code} onChange={(e) => setCode(e.target.value)} placeholder="ZS-XXXX-XXXX-XXXX-XXXX" aria-label="Code" />
            <button className="btn second" type="submit" disabled={busy === 'code'}>Einlösen</button>
          </div>
          <p className={`msg ${msg.code?.ok ? 'ok' : 'err'}`} role="status">{msg.code?.text}</p>
        </form>

        <form className="card stack" onSubmit={(e) => { e.preventDefault(); if (!fb.trim()) return; setBusy('fb'); void sendFeedback(fb, 'konto').then(() => { setFb(''); say('fb', 'Danke, angekommen.', true); }).catch((err: unknown) => { say('fb', err instanceof ApiError ? err.message : 'Senden hat nicht geklappt.'); }).finally(() => setBusy(null)); }} aria-labelledby="k-fb">
          <div className="section-head"><h2 id="k-fb">Rückmeldung oder Hilfe</h2><p>Liest ein Mensch, meist am selben Tag.</p></div>
          <label className="field"><span>Was klappt, was nervt, was fehlt?</span><textarea className="textarea" id="k-fb-feld" rows={3} maxLength={4000} value={fb} onChange={(e) => setFb(e.target.value)} /></label>
          <div className="row"><button className="btn second" type="submit" disabled={busy === 'fb' || !fb.trim()}>Senden</button></div>
          <p className={`msg ${msg.fb?.ok ? 'ok' : 'err'}`} role="status">{msg.fb?.text}</p>
        </form>
      </div>

      <section className="card stack" aria-labelledby="k-daten">
        <div className="section-head"><h2 id="k-daten">Deine Daten</h2><p>Alles, was Jobbster über dich speichert, als Datei.</p></div>
        <dl className="kv"><dt>E-Mail</dt><dd>{session?.user.email}</dd>{member?.joined_at && <><dt>Dabei seit</dt><dd>{formatDate(member.joined_at)}</dd></>}</dl>
        <div className="row">
          <button className="btn second" disabled={busy === 'export'} onClick={() => { setBusy('export'); void exportAll().then((b) => { download(b, `Jobbster-Daten-${new Date().toISOString().slice(0, 10)}.json`); say('daten', 'Export heruntergeladen.', true); }).catch((err: unknown) => { say('daten', err instanceof ApiError ? err.message : 'Export fehlgeschlagen.'); }).finally(() => setBusy(null)); }}>Alle Daten exportieren</button>
          <button className="btn second" onClick={() => { void auth.signOut().then(() => reload()).then(() => nav('/anmelden')); }}>Abmelden</button>
        </div>
        <form className="row" onSubmit={(e) => { e.preventDefault(); if (pw.length < 10) { say('daten', 'Das neue Passwort braucht mindestens 10 Zeichen.'); return; } setBusy('pw'); void auth.changePassword(pw).then(() => { setPw(''); say('daten', 'Passwort geändert.', true); }).catch((err: unknown) => { say('daten', err instanceof ApiError ? err.message : 'Ändern hat nicht geklappt.'); }).finally(() => setBusy(null)); }}>
          <input className="input" id="k-pw" style={{ flex: '1 1 200px', width: 'auto' }} type="password" autoComplete="new-password" minLength={10} value={pw} onChange={(e) => setPw(e.target.value)} aria-label="Neues Passwort" placeholder="Neues Passwort" />
          <button className="btn second" type="submit" disabled={busy === 'pw'}>Passwort ändern</button>
        </form>
        <p className={`msg ${msg.daten?.ok ? 'ok' : 'err'}`} role="status">{msg.daten?.text}</p>
      </section>

      <section className="card stack" aria-labelledby="k-weg" style={{ borderColor: 'var(--red-line)' }}>
        <div className="section-head"><h2 id="k-weg">Konto löschen</h2><p>Löscht dein Konto, deinen Lebenslauf, alle Treffer und Entwürfe sofort und endgültig.{istAbo ? ' Ein laufendes Abo wird dabei sofort beendet, es wird nichts mehr abgebucht.' : ''}</p></div>
        <form className="row" onSubmit={(e) => { e.preventDefault(); if (loeschen !== 'LÖSCHEN') { say('weg', 'Tipp LÖSCHEN in Großbuchstaben ein.'); return; } setBusy('weg'); void deleteAccount().then(() => reload()).then(() => nav('/anmelden', { replace: true })).catch((err: unknown) => { say('weg', err instanceof ApiError && err.grund === 'abo_aktiv' ? 'Dein Abo ließ sich gerade nicht beenden. Kündige es unter „Abo verwalten“ und versuch es dann noch einmal.' : 'Löschen hat nicht geklappt. Schreib uns, dann löschen wir von Hand.'); setBusy(null); }); }}>
          <input className="input" id="k-loeschen" style={{ flex: '1 1 200px', width: 'auto' }} value={loeschen} onChange={(e) => setLoeschen(e.target.value)} aria-label="Zum Bestätigen LÖSCHEN eintippen" placeholder="LÖSCHEN eintippen" autoComplete="off" />
          <button className="btn danger" type="submit" disabled={busy === 'weg'}>Endgültig löschen</button>
        </form>
        <p className="msg err" role="status">{msg.weg?.text}</p>
      </section>
    </div>
  );
}
