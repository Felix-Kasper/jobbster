import { useCallback, useEffect, useState } from 'react';
import { adminOverview, ApiError } from '../lib/api';
import { formatDate, formatDateTime } from '../lib/logic';

type Mitglied = { id: string; email: string; plan: string; sub_status: string | null; valid_until: string | null; cancel_at_period_end: boolean; joined_at: string; treffer: number; beworben: number; kosten_30: number };
type Fehler = { created_at: string; agent: string; error: string; nutzer: string };
type Daten = {
  stand: string; nutzer: number; aktiv: number; probe: number; zahlend: number; gekuendigt: number; zahlung_offen: number; aktiv_7_tage: number;
  kosten_heute: number; kosten_7_tage: number; kosten_30_tage: number; laeufe_30_tage: Record<string, number> | null; warteschlange: number; warteliste: number;
  fehler: Fehler[]; mitglieder: Mitglied[];
};

const usd = (n: number) => `${Number(n).toFixed(2).replace('.', ',')} $`;

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
        <p className="muted small">Not-Aus, Tageslimit, Grenzen und Codes stellst du im SQL-Editor von Supabase ein. Befehle stehen in der Doku im Repo unter BETRIEB.md.</p>
      </section>
    </div>
  );
}
