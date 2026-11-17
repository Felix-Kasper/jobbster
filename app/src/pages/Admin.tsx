import { useCallback, useEffect, useState } from 'react';
import { adminCodes, adminEinladen, adminOffeneCodes, adminOverview, adminWarteliste, ApiError, type OffenerCode, type WartelisteEintrag } from '../lib/api';
import { MARKE } from '../lib/config';
import { formatDate, formatDateTime } from '../lib/logic';

type Mitglied = { id: string; email: string; plan: string; sub_status: string | null; valid_until: string | null; cancel_at_period_end: boolean; joined_at: string; treffer: number; beworben: number; kosten_30: number };
type Fehler = { created_at: string; agent: string; error: string; nutzer: string };
type Daten = {
  stand: string; nutzer: number; aktiv: number; probe: number; zahlend: number; gekuendigt: number; zahlung_offen: number; aktiv_7_tage: number;
  kosten_heute: number; kosten_7_tage: number; kosten_30_tage: number; laeufe_30_tage: Record<string, number> | null; warteschlange: number; warteliste: number;
  fehler: Fehler[]; mitglieder: Mitglied[];
};

const usd = (n: number) => `${Number(n).toFixed(2).replace('.', ',')} $`;
const fehlerText = (e: unknown) => (e instanceof ApiError ? e.message : 'Das hat nicht geklappt.');

/** Fertige Einladung als Mail. Öffnet das Mailprogramm, gesendet wird von Hand. */
export function einladungsMail(email: string, code: string, registrieren: string): string {
  const text = [
    'Hallo,',
    '',
    `danke für dein Interesse an ${MARKE}. Hier ist dein persönlicher Zugang, 30 Tage gratis:`,
    '',
    `Code: ${code}`,
    `Konto anlegen: ${registrieren}`,
    '',
    'Du lädst deinen Lebenslauf hoch, beschreibst deinen perfekten Job, und ab dann liegen jeden Morgen passende Stellen bereit. Anschreiben schreibt Jobbster auf Knopfdruck, gesendet wird immer von dir.',
    '',
    'Über eine kurze Rückmeldung nach ein paar Tagen freue ich mich sehr: Was hilft dir, was nervt?',
    '',
    'Viele Grüße',
  ].join('\n');
  return `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(`Dein Zugang zu ${MARKE}`)}&body=${encodeURIComponent(text)}`;
}
const registrierLink = () => `${window.location.origin}${import.meta.env.BASE_URL}registrieren`;

function Warteliste() {
  const [liste, setListe] = useState<WartelisteEintrag[] | null>(null);
  const [codes, setCodes] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState('');
  const laden = useCallback(() => { adminWarteliste().then(setListe).catch((e: unknown) => setMsg(fehlerText(e))); }, []);
  useEffect(() => { laden(); }, [laden]);

  async function einladen(w: WartelisteEintrag) {
    setBusy(w.id); setMsg('');
    try {
      const code = await adminEinladen(w.id);
      setCodes((c) => ({ ...c, [w.id]: code }));
      laden();
    } catch (e) { setMsg(fehlerText(e)); } finally { setBusy(null); }
  }

  if (!liste) return <p className="muted">{msg || 'Lädt …'}</p>;
  const offen = liste.filter((w) => !w.invited_at && !w.hat_konto);
  return (
    <section className="stack">
      <h2 className="h2">Warteliste <span className="muted">({offen.length} offen)</span></h2>
      {msg && <div className="banner bad" role="alert">{msg}</div>}
      {liste.length === 0 ? <p className="muted">Noch niemand auf der Warteliste.</p> : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>E-Mail</th><th>Nachricht</th><th>Seit</th><th>Stand</th><th /></tr></thead>
            <tbody>
              {liste.map((w) => (
                <tr key={w.id}>
                  <td>{w.email}</td>
                  <td style={{ whiteSpace: 'normal', maxWidth: 320 }}>{w.note || <span className="muted">·</span>}</td>
                  <td>{formatDate(w.created_at)}</td>
                  <td>{w.hat_konto ? 'hat ein Konto' : w.invited_at ? `eingeladen ${formatDate(w.invited_at)}` : 'wartet'}</td>
                  <td className="r">
                    {codes[w.id] ? (
                      <span className="row" style={{ justifyContent: 'flex-end' }}>
                        <span className="nums">{codes[w.id]}</span>
                        <a className="btn" href={einladungsMail(w.email, codes[w.id], registrierLink())}>Mail öffnen</a>
                      </span>
                    ) : !w.hat_konto && <button className="btn second" disabled={busy === w.id} onClick={() => { void einladen(w); }}>{w.invited_at ? 'Neuer Code' : 'Code erzeugen'}</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted small">„Code erzeugen“ macht einen persönlichen Code (30 Tage, einmal einlösbar). „Mail öffnen“ öffnet dann eine fertige Einladung in deinem Mailprogramm. Absenden musst du selbst.</p>
    </section>
  );
}

function Codes() {
  const [offen, setOffen] = useState<OffenerCode[] | null>(null);
  const [neu, setNeu] = useState<string[]>([]);
  const [anzahl, setAnzahl] = useState(5);
  const [notiz, setNotiz] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const laden = useCallback(() => { adminOffeneCodes().then(setOffen).catch((e: unknown) => setMsg(fehlerText(e))); }, []);
  useEffect(() => { laden(); }, [laden]);

  async function erzeugen() {
    setBusy(true); setMsg('');
    try {
      const c = await adminCodes(anzahl, 30, notiz);
      setNeu(c);
      try { await navigator.clipboard.writeText(c.join('\n')); setMsg('Erzeugt und in die Zwischenablage kopiert.'); } catch { setMsg('Erzeugt.'); }
      laden();
    } catch (e) { setMsg(fehlerText(e)); } finally { setBusy(false); }
  }

  return (
    <section className="stack">
      <h2 className="h2">Codes <span className="muted">({offen?.length ?? 0} noch nicht eingelöst)</span></h2>
      <div className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
        <label className="field" style={{ width: 110 }}><span>Anzahl</span><input type="number" min={1} max={50} value={anzahl} onChange={(e) => setAnzahl(Math.max(1, Math.min(50, Number(e.target.value) || 1)))} /></label>
        <label className="field" style={{ flex: 1, minWidth: 200 }}><span>Notiz (für wen?)</span><input value={notiz} maxLength={200} onChange={(e) => setNotiz(e.target.value)} placeholder="zum Beispiel MCI Jahrgang 2027" /></label>
        <button className="btn" disabled={busy} onClick={() => { void erzeugen(); }}>Codes erzeugen</button>
      </div>
      {msg && <p className="muted small" role="status">{msg}</p>}
      {neu.length > 0 && <pre className="card nums" style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{neu.join('\n')}</pre>}
      {offen && offen.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Code</th><th>Notiz</th><th className="r">Tage</th><th>Einlösbar bis</th><th>Erzeugt</th></tr></thead>
            <tbody>{offen.map((c) => <tr key={c.code}><td className="nums">{c.code}</td><td>{c.note ?? '·'}</td><td className="r">{c.days}</td><td>{c.expires_at ? formatDate(c.expires_at) : 'unbegrenzt'}</td><td>{formatDate(c.created_at)}</td></tr>)}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}

export default function Admin() {
  const [d, setD] = useState<Daten | null>(null);
  const [err, setErr] = useState('');
  const laden = useCallback(() => {
    adminOverview().then((x) => { setD(x as unknown as Daten); setErr(''); }).catch((e: unknown) => setErr(e instanceof ApiError ? e.message : 'Laden fehlgeschlagen.'));
  }, []);
  useEffect(() => { laden(); }, [laden]);

  if (err) return <div className="banner bad" role="alert">{err}</div>;
  if (!d) return <div className="empty"><span className="spinner muted" aria-label="Lädt" /></div>;
  const kopf = d.zahlend + d.probe;
  return (
    <div className="stack">
      <div className="page-title"><div><h1>Admin</h1><p>Stand {formatDateTime(d.stand)}</p></div><button className="btn second" onClick={laden}>Aktualisieren</button></div>
      <div className="stats">
        <div><b>{d.zahlend}</b><span>zahlend</span></div>
        <div><b>{d.probe}</b><span>in der Probe</span></div>
        <div><b>{d.aktiv_7_tage}</b><span>aktiv in 7 Tagen</span></div>
        <div><b>{d.nutzer}</b><span>Konten gesamt</span></div>
        <div><b>{usd(d.kosten_heute)}</b><span>KI-Kosten heute</span></div>
        <div><b>{usd(d.kosten_30_tage)}</b><span>KI-Kosten 30 Tage</span></div>
        <div><b>{kopf ? usd(d.kosten_30_tage / kopf) : '0'}</b><span>pro aktivem Nutzer, 30 Tage</span></div>
        <div><b>{d.warteliste}</b><span>auf der Warteliste</span></div>
      </div>
      {(d.zahlung_offen > 0 || d.gekuendigt > 0 || d.warteschlange > 5) && (
        <div className="banner warn" role="status">{[d.zahlung_offen && `${d.zahlung_offen} mit offener Zahlung`, d.gekuendigt && `${d.gekuendigt} gekündigt zum Periodenende`, d.warteschlange > 5 && `${d.warteschlange} Aufträge warten`].filter(Boolean).join(' · ')}</div>
      )}
      <section className="stack">
        <h2 className="h2">Läufe in 30 Tagen</h2>
        <p className="muted">{Object.entries(d.laeufe_30_tage ?? {}).map(([k, v]) => `${({ scout: 'Suche', writer: 'Entwurf', coach: 'Vorbereitung', profil: 'Profil-Vorschlag' } as Record<string, string>)[k] ?? k}: ${v}`).join(' · ') || 'Noch keine.'}</p>
      </section>
      <Warteliste />
      <Codes />
      <section className="stack">
        <h2 className="h2">Mitglieder</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>E-Mail</th><th>Tarif</th><th>Status</th><th>Gültig bis</th><th className="r">Treffer</th><th className="r">Beworben</th><th className="r">Kosten 30 T.</th><th>Seit</th></tr></thead>
            <tbody>
              {d.mitglieder.map((m) => (
                <tr key={m.id}>
                  <td>{m.email}</td><td>{m.plan}</td><td>{m.sub_status ?? '·'}{m.cancel_at_period_end ? ', gekündigt' : ''}</td>
                  <td>{m.valid_until ? formatDate(m.valid_until) : 'unbegrenzt'}</td><td className="r">{m.treffer}</td><td className="r">{m.beworben}</td><td className="r">{usd(m.kosten_30)}</td><td>{formatDate(m.joined_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="stack">
        <h2 className="h2">Fehler</h2>
        {d.fehler.length === 0 ? <p className="muted">Keine Fehler.</p> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Wann</th><th>Agent</th><th>Nutzer</th><th>Fehler</th></tr></thead>
              <tbody>{d.fehler.map((f, i) => <tr key={i}><td>{formatDateTime(f.created_at)}</td><td>{f.agent}</td><td className="nums">{f.nutzer}</td><td style={{ whiteSpace: 'normal' }}>{f.error}</td></tr>)}</tbody>
            </table>
          </div>
        )}
      </section>
      <section className="card stack">
        <h2 className="h2">Betrieb</h2>
        <p className="muted small">Not-Aus, Tageslimit und Grenzen stellst du im SQL-Editor von Supabase ein. Befehle stehen in der Doku im Repo unter BETRIEB.md.</p>
      </section>
    </div>
  );
}
