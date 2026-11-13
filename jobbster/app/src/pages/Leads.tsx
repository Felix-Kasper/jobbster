import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { useApp } from '../App';
import { ApiError, listLeads, openQueue, requestRun } from '../lib/api';
import { chanceOf, countByTab, daysUntil, formatDate, formatDateTime, reasonText, sortLeads, tabOf, TABS, type Tab } from '../lib/logic';
import type { Lead, QueueItem } from '../lib/types';
import LeadSheet from '../components/LeadSheet';
import { Ring } from '../components/Ring';

const Pfeil = <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5" /></svg>;
const TAB_IDS = new Set<string>(TABS.map((t) => t.id));

function Pills({ l }: { l: Lead }) {
  const c = chanceOf(l.why_fit);
  const tage = daysUntil(l.deadline);
  return (
    <div className="pills">
      {c && <span className={`pill ${c === 'hoch' ? 'green' : c === 'mittel' ? 'orange' : 'red'}`}><span className="dot" />Chance {c}</span>}
      {tage !== null && tage >= 0 && <span className={`pill ${tage <= 7 ? 'red' : 'orange'}`}>Frist {formatDate(l.deadline)}</span>}
      {l.status === 'neu' && l.requested_at && <span className="pill blue">Entwurf angefordert</span>}
      {l.prep_requested_at && <span className="pill blue">Vorbereitung angefordert</span>}
      {l.next_at && <span className="pill blue">{formatDateTime(l.next_at)}</span>}
      {(l.status === 'absage' || l.status === 'verworfen') && <span className="pill off">{l.status === 'absage' ? 'Absage' : 'Verworfen'}</span>}
      {l.status === 'zusage' && <span className="pill green">Zusage erhalten</span>}
      {l.status === 'interview2' && <span className="pill">Runde 2</span>}
      {l.status === 'vertrag' && <span className="pill green">Vertrag</span>}
      <span className="pill">{l.apply_channel === 'email' ? 'E-Mail' : l.apply_channel === 'linkedin' ? 'LinkedIn' : 'Portal'}</span>
    </div>
  );
}

export default function Leads() {
  const { access } = useApp();
  const { id } = useParams();
  const nav = useNavigate();
  const loc = useLocation();
  const [leads, setLeads] = useState<Lead[] | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [tab, setTab] = useState<Tab>(() => {
    try {
      const t = sessionStorage.getItem('jobbster-tab');
      return t && TAB_IDS.has(t) ? (t as Tab) : 'bereit';
    } catch { return 'bereit'; }
  });
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState(() => {
    const h = (loc.state as { hinweis?: string } | null)?.hinweis;
    return h === 'erste-suche' ? 'Der erste Suchlauf läuft. Die Treffer erscheinen in den nächsten Minuten unter „Neu“.' : h ?? '';
  });
  const [busy, setBusy] = useState(false);
  const erstesLaden = useRef(true);

  const load = useCallback(async () => {
    try {
      const [l, q] = await Promise.all([listLeads(), openQueue()]);
      setLeads(l); setQueue(q); setErr('');
      // Ist „Bereit“ leer, aber „Neu“ nicht, beim ersten Laden dorthin
      if (erstesLaden.current) {
        erstesLaden.current = false;
        const c = countByTab(l);
        if (c.bereit === 0 && c.neu > 0) setTab((t) => (t === 'bereit' ? 'neu' : t));
      }
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Laden hat nicht geklappt.');
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const offen = queue.filter((q) => q.status === 'wartet' || q.status === 'laeuft');
  useEffect(() => {
    if (!offen.length) return;
    const t = setInterval(() => { void load(); }, 15000);
    return () => clearInterval(t);
  }, [offen.length, load]);

  useEffect(() => { try { sessionStorage.setItem('jobbster-tab', tab); } catch { /* egal */ } }, [tab]);

  const counts = useMemo(() => countByTab(leads ?? []), [leads]);

  const sichtbar = useMemo(() => sortLeads((leads ?? []).filter((l) => tabOf(l) === tab), tab), [leads, tab]);
  const aktuell = id ? leads?.find((l) => l.id === id) ?? null : null;
  const sucht = offen.some((q) => q.kind === 'scout');
  const letzterFehler = queue.find((q) => q.status === 'fehler' && Date.now() - Date.parse(q.created_at) < 86_400_000);

  async function sucheStarten() {
    setBusy(true); setMsg('');
    try {
      const r = await requestRun('scout');
      setMsg(r.ok ? 'Suchlauf gestartet. Die Treffer erscheinen in den nächsten Minuten.' : reasonText(r.grund, r.frei_ab, r.limit));
      await load();
    } catch (e) {
      setMsg(e instanceof ApiError ? e.message : 'Das hat nicht geklappt.');
    } finally { setBusy(false); }
  }
  const schliessen = useCallback(() => { void nav('/treffer'); }, [nav]);

  const gespraeche = (leads ?? []).filter((l) => ['interview', 'interview2', 'vertrag'].includes(l.status));
  const beworben = (leads ?? []).filter((l) => l.applied_at).length;

  const leerText: Record<Tab, [string, string]> = {
    neu: [sucht ? 'Die Suche läuft.' : 'Noch keine neuen Treffer.', 'Jobbster sucht jeden Morgen neue Stellen, so viele wie unter Profil eingestellt. Mit „Jetzt suchen“ geht es sofort.'],
    bereit: ['Keine Entwürfe bereit.', 'Öffne einen Treffer unter „Neu“ und tipp auf „Entwurf schreiben“.'],
    beworben: ['Noch keine Bewerbung abgeschickt.', 'Wenn du eine Bewerbung abgeschickt hast, markier sie als beworben.'],
    gespraeche: ['Noch keine Einladung.', 'Kommt eine Einladung, öffne die Bewerbung und tipp auf „Einladung erhalten“.'],
    archiv: ['Das Archiv ist leer.', 'Absagen und Verworfenes landen hier.'],
  };

  return (
    <>
      <div className="page-title">
        <div>
          <h1>Treffer</h1>
          <p>Passende Stellen, deine Entwürfe und Gespräche an einem Ort.</p>
        </div>
        <button className="btn" onClick={() => { void sucheStarten(); }} disabled={busy || sucht || !access.aktiv}>
          {busy || sucht ? <span className="spinner" aria-hidden="true" /> : null}{sucht ? 'Suche läuft' : 'Jetzt suchen'}
        </button>
      </div>
      {msg && <div className="banner fade-in" role="status"><span>{msg}</span><button className="btn ghost" onClick={() => setMsg('')}>Ausblenden</button></div>}
      {letzterFehler && <div className="banner warn" role="status">Ein Lauf ist fehlgeschlagen und zählt nicht gegen deine Grenze. Starte ihn einfach noch einmal.</div>}
      {err && <div className="banner bad" role="alert"><span>{err}</span><button className="btn second" onClick={() => { void load(); }}>Neu laden</button></div>}

      <div className="funnel" aria-label="Überblick">
        <div><b>{counts.bereit}</b><span>Entwürfe bereit</span></div>
        <div><b>{beworben}</b><span>beworben</span></div>
        <div><b>{gespraeche.length}</b><span>im Gespräch</span></div>
      </div>

      <div className="toolbar">
        <div className="seg" role="group" aria-label="Bereiche">
          {TABS.map((t) => (
            <button key={t.id} type="button" aria-pressed={tab === t.id} onClick={() => setTab(t.id)}>{t.label}<span className="n">{counts[t.id]}</span></button>
          ))}
        </div>
      </div>

      {leads === null && !err ? (
        <div className="empty"><span className="spinner muted" aria-label="Lädt" /></div>
      ) : sichtbar.length === 0 ? (
        <div className="empty">
          <b>{leerText[tab][0]}</b>
          <span>{leerText[tab][1]}</span>
        </div>
      ) : (
        <ul className="list">
          {sichtbar.map((l) => (
            <li key={l.id}>
              <Link className="item" to={`/treffer/${l.id}`}>
                <Ring score={l.match_score} why={l.why_fit} />
                <span style={{ minWidth: 0 }}>
                  <span className="t">{l.title}</span>
                  <span className="s">{[l.company, l.location].filter(Boolean).join(' · ')}</span>
                  <Pills l={l} />
                </span>
                <span className="pfeil">{Pfeil}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {id && aktuell && <LeadSheet key={aktuell.id} lead={aktuell} queue={queue} onClose={schliessen} onChange={load} />}
      {id && leads && !aktuell && (
        <div className="banner warn" role="alert"><span>Diesen Treffer gibt es nicht mehr.</span><button className="btn second" onClick={schliessen}>Zur Liste</button></div>
      )}
    </>
  );
}
