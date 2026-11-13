import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useApp } from '../App';
import { ApiError, requestRun, runNow, updateLead } from '../lib/api';
import { copyText, download, letterDocx, letterPdf } from '../lib/docs';
import { formatDate, formatDateTime, mailtoFor, reasonText } from '../lib/logic';
import { Ring } from './Ring';
import type { InterviewInput, Lead, Prep, QueueItem } from '../lib/types';

type Props = { lead: Lead; queue: QueueItem[]; onClose: () => void; onChange: () => Promise<void> };

function Block({ title, children }: { title: string; children: ReactNode }) {
  return <section className="card stack" style={{ gap: 10 }}><h3>{title}</h3>{children}</section>;
}

const liste = <T,>(x: T[] | null | undefined): T[] => (Array.isArray(x) ? x : []);

function Lines({ text }: { text: string | null }) {
  if (!text) return null;
  const zeilen = text.split('\n').map((z) => z.replace(/^\s*[-•]\s*/, '').trim()).filter(Boolean);
  return <ul className="bullets">{zeilen.map((z, i) => <li key={i}>{z}</li>)}</ul>;
}

function Punkte({ title, items }: { title: string; items: string[] | null | undefined }) {
  const x = liste(items);
  return x.length ? <Block title={title}><ul className="bullets">{x.map((t, i) => <li key={i}>{t}</li>)}</ul></Block> : null;
}

function PrepView({ p }: { p: Prep }) {
  return (
    <div className="stack">
      <section className="card accent"><h3>Gesprächsvorbereitung</h3><p className="display" style={{ fontSize: 18, marginTop: 6 }}>{p.headline}</p>{p.format && <p className="small muted" style={{ marginTop: 4 }}>{p.format}</p>}</section>
      {liste(p.must_say).length > 0 && <Block title="Das musst du sagen"><ol className="num-list">{liste(p.must_say).map((x, i) => <li key={i}><span>{x}</span></li>)}</ol></Block>}
      {liste(p.people).length > 0 && <Block title="Mit wem">{liste(p.people).map((x, i) => <p key={i}><b>{x.name}</b>, {x.role}. {x.about} {x.link && <a href={x.link} target="_blank" rel="noopener noreferrer">Quelle</a>}</p>)}</Block>}
      <Punkte title="Was sie suchen" items={p.they_want} />
      <Punkte title="Firma in 30 Sekunden" items={p.company} />
      <Punkte title="So läuft das Gespräch" items={p.process} />
      {liste(p.questions).length > 0 && <Block title="Fragen mit Antwort"><div className="qa">{liste(p.questions).map((x, i) => <details key={i}><summary>{x.q}</summary><p>{x.a}</p></details>)}</div></Block>}
      <Punkte title="Deine Rückfragen" items={p.ask_back} />
      <Punkte title="Achte auf" items={p.watch_out} />
      {p.salary && <Block title="Gehalt"><p>{p.salary}</p></Block>}
      {liste(p.sources).length > 0 && <Block title="Quellen"><ul className="bullets small">{liste(p.sources).map((s, i) => <li key={i}><a href={s.url} target="_blank" rel="noopener noreferrer">{s.title || s.url}</a></li>)}</ul></Block>}
    </div>
  );
}

export default function LeadSheet({ lead: l, queue, onClose, onChange }: Props) {
  const { profile, access } = useApp();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [frage, setFrage] = useState<null | 'verwerfen' | 'absage' | 'einladung' | 'runde2'>(null);
  const [grund, setGrund] = useState('');
  const [inp, setInp] = useState<InterviewInput>({});
  const [notiz, setNotiz] = useState(l.notes ?? '');
  const ref = useRef<HTMLDivElement>(null);
  const schliessen = useRef(onClose);
  useEffect(() => { schliessen.current = onClose; }, [onClose]);

  // Nur beim Öffnen: Fokus ins Blatt, Escape schließt, Seite dahinter steht still. Beim Schließen zurück zum Auslöser.
  useEffect(() => {
    const vorher = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') schliessen.current(); };
    document.addEventListener('keydown', esc);
    const alt = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', esc);
      document.body.style.overflow = alt;
      vorher?.focus?.();
    };
  }, []);

  const laeuftEntwurf = queue.some((q) => q.lead_id === l.id && q.kind === 'entwurf' && (q.status === 'wartet' || q.status === 'laeuft'));
  const laeuftPrep = queue.some((q) => q.lead_id === l.id && q.kind === 'vorbereitung' && (q.status === 'wartet' || q.status === 'laeuft'));

  async function act(name: string, fn: () => Promise<string | void>) {
    setBusy(name); setMsg(null);
    try {
      const text = await fn();
      await onChange();
      if (text) setMsg({ text, ok: true });
    } catch (e) {
      setMsg({ text: e instanceof ApiError && e.message ? e.message : 'Das hat nicht geklappt. Bitte versuch es noch einmal.', ok: false });
    } finally { setBusy(null); }
  }

  const setStatus = (status: Lead['status'], extra: Partial<Lead> = {}) => updateLead(l.id, { status, stage_updated_at: new Date().toISOString(), ...extra });

  const entwurf = () => act('entwurf', async () => {
    const r = await requestRun('entwurf', l.id);
    if (!r.ok) throw new ApiError(reasonText(r.grund, r.frei_ab, r.limit));
    const sofort = r.queue_id ? await runNow(r.queue_id) : false;
    return sofort ? 'Der Entwurf ist fertig und liegt unter „Bereit“.' : 'Der Entwurf ist angefordert. Er erscheint in den nächsten Minuten unter „Bereit“.';
  });

  const vorbereitung = (stufe: 'interview1' | 'interview2') => act('prep', async () => {
    const r = await requestRun('vorbereitung', l.id, stufe);
    if (!r.ok) throw new ApiError(reasonText(r.grund, r.frei_ab, r.limit));
    return 'Die Vorbereitung ist angefordert. Sie erscheint hier, meist innerhalb einer halben Stunde.';
  });

  const brief = { text: l.cover_letter_md ?? '', name: profile?.full_name ?? '', email: profile?.application_email, phone: profile?.phone, company: l.company, title: l.title };
  const mail = mailtoFor(l);

  async function einladungSpeichern(e: FormEvent) {
    e.preventDefault();
    const zweite = frage === 'runde2';
    const wann = inp.when ? new Date(inp.when) : null;
    if (inp.when && (!wann || Number.isNaN(wann.getTime()))) { setMsg({ text: 'Bitte gib einen gültigen Termin an.', ok: false }); return; }
    await act('einladung', async () => {
      await setStatus(zweite ? 'interview2' : 'interview', {
        [zweite ? 'interview2_input' : 'interview1_input']: { ...inp, mail: (inp.mail ?? '').slice(0, 8000) },
        next_at: wann ? wann.toISOString() : null,
      } as Partial<Lead>);
      setFrage(null);
      return 'Gespeichert. Fordere jetzt die Vorbereitung an.';
    });
  }

  const titelId = `sheet-${l.id}`;
  const prep = l.status === 'interview2' ? l.interview2_prep : l.interview1_prep;

  const kopieren = async (text: string, was = 'Kopiert.') => {
    const ok = await copyText(text);
    setMsg({ text: ok ? was : 'Kopieren ging nicht. Markier den Text und kopier ihn selbst.', ok });
  };
  const kanal = l.apply_channel === 'email' ? 'E-Mail' : l.apply_channel === 'linkedin' ? 'LinkedIn' : 'Portal der Firma';

  return (
    <div className="sheet-bg" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="sheet" role="dialog" aria-modal="true" aria-labelledby={titelId} ref={ref} tabIndex={-1}>
        <div className="sheet-head">
          <div style={{ minWidth: 0 }}>
            <h2 id={titelId}>{l.title}</h2>
            <p>{[l.company, l.location].filter(Boolean).join(' · ')}</p>
          </div>
          <button className="btn second" onClick={onClose}>Schließen</button>
        </div>
        <div className="stack">
          <div className="sheet-top">
            <Ring score={l.match_score} why={l.why_fit} gross />
            <div className="stack" style={{ gap: 6 }}>
              <div className="pills">
                {l.deadline && <span className="pill red">Frist {formatDate(l.deadline)}</span>}
                {l.posted_at && <span className="pill">ausgeschrieben {formatDate(l.posted_at)}</span>}
                <span className="pill">Bewerbung über {kanal}</span>
                {l.salary && <span className="pill">{l.salary}</span>}
              </div>
            </div>
          </div>

          {/* ---------- Aktionen je Stufe ---------- */}
          <div className="actions">
            {l.status === 'neu' && (
              <>
                <button className="btn big" onClick={() => { void entwurf(); }} disabled={!!busy || laeuftEntwurf || !access.aktiv}>{busy === 'entwurf' || laeuftEntwurf ? <span className="spinner" aria-hidden="true" /> : null}{laeuftEntwurf ? 'Entwurf wird geschrieben' : 'Entwurf schreiben'}</button>
                <button className="btn second big" onClick={() => setFrage('verwerfen')} disabled={!!busy}>Passt nicht</button>
              </>
            )}
            {l.status === 'entwurf' && (
              <>
                {mail && <a className="btn big" href={mail.href} onClick={() => { if (mail.kurz && l.email_body) void kopieren(l.email_body, 'Der Mailtext ist kopiert. Füg ihn in die Mail ein.'); }}>In E-Mail öffnen</a>}
                {l.url && <button className={`btn big ${mail ? 'second' : ''}`} onClick={() => { void (async () => { const ok = await copyText(l.cover_letter_md ?? ''); window.open(l.url!, '_blank', 'noopener'); setMsg({ text: ok ? 'Anschreiben kopiert. Füg es im Portal ein.' : 'Kopieren ging nicht. Markier den Text unten.', ok }); })(); }}>Portal öffnen</button>}
                <button className="btn second big" onClick={() => { void act('beworben', async () => { await setStatus('beworben', { applied_at: new Date().toISOString() }); return 'Als beworben markiert.'; }); }} disabled={!!busy}>Beworben</button>
              </>
            )}
            {l.status === 'beworben' && (
              <>
                <button className="btn big" onClick={() => { setInp({}); setFrage('einladung'); }}>Einladung erhalten</button>
                <button className="btn second big" onClick={() => setFrage('absage')}>Absage</button>
              </>
            )}
            {(l.status === 'interview' || l.status === 'interview2') && (
              <>
                {!prep && <button className="btn big" onClick={() => { void vorbereitung(l.status === 'interview2' ? 'interview2' : 'interview1'); }} disabled={!!busy || laeuftPrep || !access.aktiv}>{laeuftPrep ? <span className="spinner" aria-hidden="true" /> : null}{laeuftPrep ? 'Vorbereitung läuft' : 'Vorbereitung anfordern'}</button>}
                {l.status === 'interview' && <button className="btn second big" onClick={() => { setInp({}); setFrage('runde2'); }}>Zweite Runde</button>}
                <button className="btn second big" onClick={() => { void act('vertrag', async () => { await setStatus('vertrag'); return 'Glückwunsch. Vertrag vermerkt.'; }); }} disabled={!!busy}>Vertrag erhalten</button>
                <button className="btn second big" onClick={() => setFrage('absage')}>Absage</button>
              </>
            )}
            {l.status === 'vertrag' && <button className="btn big" onClick={() => { void act('zusage', async () => { await setStatus('zusage'); return 'Angenommen. Viel Erfolg!'; }); }} disabled={!!busy}>Angenommen</button>}
            {['absage', 'verworfen', 'zusage'].includes(l.status) && (
              <button className="btn second big" onClick={() => { void act('zurueck', async () => { await setStatus(l.applied_at ? 'beworben' : 'neu', { archive_reason: null }); return 'Wiederhergestellt.'; }); }} disabled={!!busy}>Wiederherstellen</button>
            )}
          </div>
          <p className={`msg ${msg?.ok ? 'ok' : 'err'}`} role="status">{msg?.text}</p>

          {/* ---------- Rückfragen ---------- */}
          {(frage === 'verwerfen' || frage === 'absage') && (
            <form className="card stack fade-in" onSubmit={(e) => { e.preventDefault(); const art = frage; void act('archiv', async () => { await setStatus(art === 'absage' ? 'absage' : 'verworfen', { archive_reason: grund.trim().slice(0, 480) || null }); setFrage(null); setGrund(''); return art === 'absage' ? 'Absage vermerkt.' : 'Verworfen. Die Suche lernt daraus.'; }); }}>
              <label className="field"><span>{frage === 'absage' ? 'Absage: in welcher Stufe, was war der Grund? (optional)' : 'Warum passt es nicht? Die Suche lernt daraus. (optional)'}</span>
                <input className="input" id="grund" value={grund} onChange={(e) => setGrund(e.target.value)} maxLength={480} placeholder={frage === 'absage' ? 'Nach dem Erstgespräch' : 'Zu viel Außendienst'} />
              </label>
              <div className="row"><button className="btn" type="submit" disabled={!!busy}>{frage === 'absage' ? 'Absage speichern' : 'Verwerfen'}</button><button className="btn ghost" type="button" onClick={() => setFrage(null)}>Abbrechen</button></div>
            </form>
          )}
          {(frage === 'einladung' || frage === 'runde2') && (
            <form className="card stack fade-in" onSubmit={(e) => { void einladungSpeichern(e); }}>
              <h3>{frage === 'runde2' ? 'Zweite Runde' : 'Einladung zum Erstgespräch'}</h3>
              <label className="field"><span>Text der Einladung (aus der Mail kopieren)</span><textarea className="textarea" id="iv-mail" rows={5} maxLength={8000} value={inp.mail ?? ''} onChange={(e) => setInp({ ...inp, mail: e.target.value })} /></label>
              <div className="grid2">
                <label className="field"><span>Termin</span><input className="input" id="iv-wann" type="datetime-local" value={inp.when ?? ''} onChange={(e) => setInp({ ...inp, when: e.target.value })} /></label>
                <label className="field"><span>Format</span>
                  <select className="select" id="iv-format" value={inp.format ?? ''} onChange={(e) => setInp({ ...inp, format: e.target.value })}><option value="">Unbekannt</option><option value="video">Video</option><option value="telefon">Telefon</option><option value="vor_ort">Vor Ort</option></select>
                </label>
                <label className="field"><span>Gesprächspartner (optional)</span><input className="input" id="iv-wer" value={inp.people ?? ''} onChange={(e) => setInp({ ...inp, people: e.target.value })} placeholder="Name, Rolle" /></label>
                <label className="field"><span>Dauer in Minuten (optional)</span><input className="input" id="iv-dauer" type="number" min={5} max={600} inputMode="numeric" value={inp.durationMin ?? ''} onChange={(e) => setInp({ ...inp, durationMin: e.target.value ? Number(e.target.value) : undefined })} /></label>
              </div>
              {frage === 'runde2' && <label className="field"><span>Wie lief die erste Runde?</span><textarea className="textarea" id="iv-recap" rows={3} maxLength={2000} value={inp.recap ?? ''} onChange={(e) => setInp({ ...inp, recap: e.target.value })} /></label>}
              <div className="row"><button className="btn" type="submit" disabled={!!busy}>Speichern</button><button className="btn ghost" type="button" onClick={() => setFrage(null)}>Abbrechen</button></div>
            </form>
          )}

          {/* ---------- Inhalt ---------- */}
          {prep && <PrepView p={prep} />}

          {l.cover_letter_md && (
            <Block title="Anschreiben">
              <div className="letter">{l.cover_letter_md}</div>
              <div className="row">
                <button className="btn second" onClick={() => { void kopieren(l.cover_letter_md ?? ''); }}>Kopieren</button>
                <button className="btn second" disabled={busy === 'pdf'} onClick={() => { void act('pdf', async () => { const r = await letterPdf(brief); download(r.blob, r.name); return r.seiten > 1 ? `PDF erstellt. Achtung: Es hat ${r.seiten} Seiten, kürz den Text.` : 'PDF heruntergeladen.'; }); }}>PDF</button>
                <button className="btn second" disabled={busy === 'docx'} onClick={() => { void act('docx', async () => { const r = await letterDocx(brief); download(r.blob, r.name); return 'Word-Datei heruntergeladen.'; }); }}>Word</button>
              </div>
              <p className="muted small">{l.cover_letter_md.length.toLocaleString('de-AT')} Zeichen{l.drafted_at ? ` · geschrieben ${formatDateTime(l.drafted_at)}` : ''}</p>
            </Block>
          )}
          {l.email_body && (
            <Block title={`E-Mail${l.apply_email ? ` an ${l.apply_email}` : ''}`}>
              <p><b>{l.email_subject}</b></p>
              <div className="letter">{l.email_body}</div>
              <div className="row"><button className="btn second" onClick={() => { void kopieren(`${l.email_subject ?? ''}\n\n${l.email_body ?? ''}`); }}>Kopieren</button></div>
              {mail?.kurz && <p className="muted small">Der Text ist zu lang für den Mail-Link. Beim Öffnen wird er kopiert, füg ihn dann ein.</p>}
            </Block>
          )}
          {l.cv_highlights && <Block title="Für deinen Lebenslauf"><Lines text={l.cv_highlights} /></Block>}
          {l.pre_info && <Block title="Vor dem Absenden"><p className="lead-text">{l.pre_info}</p></Block>}

          {l.why_fit && <Block title="Warum es passt"><p className="lead-text">{l.why_fit}</p></Block>}
          {l.summary && <Block title="Die Stelle"><p className="lead-text">{l.summary}</p>{l.url && <a href={l.url} target="_blank" rel="noopener noreferrer">Anzeige öffnen</a>}</Block>}
          {liste(l.keywords).length > 0 && (
            <Block title="Stichworte aus der Anzeige">
              <div className="pills">{liste(l.keywords).map((k, i) => <span key={i} className={`pill ${k.matched ? 'green' : 'off'}`}>{k.term}</span>)}</div>
              <p className="muted small">Grün steht in deinem Lebenslauf, grau fehlt.</p>
            </Block>
          )}
          {l.requirements && <Block title="Anforderungen"><Lines text={l.requirements} /></Block>}
          {(l.interview1_input?.mail || l.interview2_input?.mail) && (
            <Block title="Einladung"><dl className="kv">{l.next_at && <><dt>Termin</dt><dd>{formatDateTime(l.next_at)}</dd></>}{(l.interview2_input ?? l.interview1_input)?.people && <><dt>Mit</dt><dd>{(l.interview2_input ?? l.interview1_input)?.people}</dd></>}</dl></Block>
          )}

          <form className="card stack" onSubmit={(e) => { e.preventDefault(); void act('notiz', async () => { await updateLead(l.id, { notes: notiz }); return 'Notiz gespeichert.'; }); }}>
            <label className="field"><span>Deine Notizen</span><textarea className="textarea" id="notiz" rows={3} maxLength={20000} value={notiz} onChange={(e) => setNotiz(e.target.value)} /></label>
            <div className="row"><button className="btn second" type="submit" disabled={!!busy || notiz === (l.notes ?? '')}>Notiz speichern</button></div>
          </form>
        </div>
      </div>
    </div>
  );
}
