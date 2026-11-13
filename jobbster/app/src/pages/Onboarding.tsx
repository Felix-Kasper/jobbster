import { useEffect, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Marke, useApp } from '../App';
import { ApiError, downloadCv, profilVorschlag, requestRun, saveProfile, uploadCv } from '../lib/api';
import { checkCvFile, readCv } from '../lib/cv';
import { download } from '../lib/docs';
import { MARKE } from '../lib/config';
import { missingForSearch, parseOrte, PRO_TAG, proTag, reasonText } from '../lib/logic';
import type { Preferences, Profile } from '../lib/types';

type Draft = {
  full_name: string; application_email: string; phone: string; linkedin_url: string; location: string; languages: string;
  cv_text: string; zielrollen: string; stellenarten: string[]; orte: string; start: string; ausschluesse: string; engagement: string; wuensche: string; land: string;
  pro_tag: number; traumjob: string;
};

const ARTEN = ['Trainee', 'Junior', 'Graduate', 'Bezahltes Praktikum', 'Berufseinstieg'];
const LAENDER: [string, string][] = [['AT', 'Österreich'], ['DE', 'Deutschland'], ['CH', 'Schweiz']];
const SPEICHER = 'jobbster-entwurf-profil';
const TITEL = ['Dein Lebenslauf', 'Über dich', 'Was du suchst', 'Feinschliff'];

function fromProfile(p: Profile | null, email: string): Draft {
  const w: Preferences = p?.preferences ?? {};
  return {
    full_name: p?.full_name ?? '', application_email: p?.application_email ?? email, phone: p?.phone ?? '', linkedin_url: p?.linkedin_url ?? '',
    location: p?.location ?? '', languages: p?.languages ?? '', cv_text: p?.cv_text ?? '', zielrollen: w.zielrollen ?? '',
    stellenarten: w.stellenarten ?? ['Trainee', 'Junior'], orte: (w.orte ?? []).join(', '), start: w.start ?? '', ausschluesse: w.ausschluesse ?? '',
    engagement: w.engagement ?? '', wuensche: w.wuensche ?? '', land: w.land ?? 'AT', pro_tag: proTag(w.pro_tag), traumjob: w.traumjob ?? '',
  };
}

function toPatch(d: Draft) {
  const t = (s: string) => (s.trim() ? s.trim() : null);
  return {
    full_name: t(d.full_name), application_email: t(d.application_email), phone: t(d.phone), linkedin_url: t(d.linkedin_url), location: t(d.location),
    languages: t(d.languages), cv_text: t(d.cv_text),
    preferences: {
      zielrollen: d.zielrollen.trim(), stellenarten: d.stellenarten, orte: parseOrte(d.orte), start: d.start.trim(), ausschluesse: d.ausschluesse.trim(),
      engagement: d.engagement.trim(), wuensche: d.wuensche.trim(), land: d.land, pro_tag: proTag(d.pro_tag), traumjob: d.traumjob.trim().slice(0, 2000), zeitzone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Vienna',
    } as Preferences,
  };
}

export default function Onboarding({ asProfile = false }: { asProfile?: boolean }) {
  const { profile, setProfile, session, access } = useApp();
  const nav = useNavigate();
  // Zwischenstand je Konto getrennt: Auf einem geteilten Gerät sieht niemand den Lebenslauf eines anderen.
  const speicher = `${SPEICHER}:${session?.user.id ?? 'anonym'}`;
  const [d, setD] = useState<Draft>(() => {
    const basis = fromProfile(profile, session?.user.email ?? '');
    if (asProfile) return basis;
    try {
      localStorage.removeItem(SPEICHER); // alter Schlüssel ohne Konto
      const alt = JSON.parse(localStorage.getItem(speicher) ?? 'null') as Partial<Draft> | null;
      return alt && typeof alt === 'object' ? { ...basis, ...alt } : basis;
    } catch { return basis; }
  });
  const [step, setStep] = useState(0);
  const [cvInfo, setCvInfo] = useState<string>('');
  const [cvFile, setCvFile] = useState<File | null>(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const [vorschlagLaeuft, setVorschlagLaeuft] = useState(false);
  const [vorschlagMsg, setVorschlagMsg] = useState<{ text: string; ok: boolean } | null>(null);

  // Aus „Beschreib deinen perfekten Job“ die Felder darunter ausfüllen. Leere Vorschläge lassen Eingaben stehen.
  async function vorschlagHolen() {
    if (d.traumjob.trim().length < 40) { setVorschlagMsg({ text: 'Beschreib deinen perfekten Job in zwei, drei Sätzen, dann klappt der Vorschlag.', ok: false }); return; }
    setVorschlagLaeuft(true); setVorschlagMsg(null);
    try {
      const f = await profilVorschlag(d.traumjob.trim());
      setD((x) => ({
        ...x,
        zielrollen: f.zielrollen || x.zielrollen,
        stellenarten: f.stellenarten.length ? f.stellenarten : x.stellenarten,
        orte: f.orte.length ? f.orte.join(', ') : x.orte,
        start: f.start || x.start,
        ausschluesse: f.ausschluesse || x.ausschluesse,
        wuensche: f.wuensche || x.wuensche,
      }));
      setVorschlagMsg({ text: 'Felder ausgefüllt. Prüf sie kurz und ergänze, was fehlt.', ok: true });
    } catch (e) {
      const text = e instanceof ApiError && e.message ? e.message : 'Der Vorschlag klappt gerade nicht. Füll die Felder bitte selbst aus.';
      setVorschlagMsg({ text, ok: false });
    } finally {
      setVorschlagLaeuft(false);
    }
  }

  // Zwischenspeichern auf dem Gerät, damit nichts verloren geht
  useEffect(() => {
    if (asProfile) return;
    const t = setTimeout(() => { try { localStorage.setItem(speicher, JSON.stringify(d)); } catch { /* egal */ } }, 400);
    return () => clearTimeout(t);
  }, [d, asProfile, speicher]);

  async function takeFile(file: File | undefined) {
    if (!file) return;
    const fehler = checkCvFile(file);
    if (fehler) { setCvInfo(fehler); return; }
    setBusy(true); setCvInfo('Lese den Lebenslauf …');
    try {
      const r = await readCv(file);
      setCvFile(file);
      if (r.text) set('cv_text', r.text);
      if (r.text.length >= 200) setMsg(null);
      setCvInfo(r.warnung ?? `Gelesen: ${r.seiten} ${r.seiten === 1 ? 'Seite' : 'Seiten'}, ${r.text.length.toLocaleString('de-AT')} Zeichen. Prüf den Text unten kurz.`);
    } catch {
      setCvInfo('Diese PDF ließ sich nicht lesen. Füge den Text unten selbst ein.');
    } finally {
      setBusy(false);
    }
  }

  async function persist(extra: Partial<Profile> = {}): Promise<Profile | null> {
    try {
      const patch: Partial<Profile> = { ...toPatch(d), ...extra };
      if (cvFile) patch.cv_path = await uploadCv(cvFile);
      const p = await saveProfile(patch);
      setProfile(p);
      setCvFile(null);
      return p;
    } catch (e) {
      setMsg({ text: e instanceof ApiError && e.message ? e.message : 'Speichern hat nicht geklappt.', ok: false });
      return null;
    }
  }

  async function next(e?: FormEvent) {
    e?.preventDefault();
    setMsg(null);
    if (step === 0 && d.cv_text.trim().length < 200) { setMsg({ text: 'Lade deinen Lebenslauf hoch oder füge mindestens ein paar Zeilen Text ein.', ok: false }); return; }
    if (step === 1 && !d.full_name.trim()) { setMsg({ text: 'Bitte trag deinen Namen ein. Er steht unter jedem Anschreiben.', ok: false }); return; }
    if (step === 2) {
      const fehlt = missingForSearch({ cv_text: d.cv_text, full_name: d.full_name, preferences: toPatch(d).preferences }).filter((f) => f !== 'Lebenslauf' && f !== 'Name');
      if (fehlt.length) { setMsg({ text: `Noch offen: ${fehlt.join(', ')}.`, ok: false }); return; }
    }
    setBusy(true);
    const p = await persist();
    setBusy(false);
    if (p) setStep((s) => s + 1);
  }

  async function finish() {
    setBusy(true); setMsg(null);
    const p = await persist({ onboarded_at: new Date().toISOString() });
    if (!p) { setBusy(false); return; }
    try { localStorage.removeItem(speicher); } catch { /* egal */ }
    let hinweis = '';
    if (access.aktiv) {
      const r = await requestRun('scout').catch(() => null);
      hinweis = r?.ok ? 'erste-suche' : r ? reasonText(r.grund, r.frei_ab, r.limit) : '';
    }
    setBusy(false);
    void nav('/treffer', { replace: true, state: { hinweis } });
  }

  async function saveAll(e: FormEvent) {
    e.preventDefault();
    const fehlt = missingForSearch({ cv_text: d.cv_text, full_name: d.full_name, preferences: toPatch(d).preferences });
    if (fehlt.length) { setMsg({ text: `Noch offen: ${fehlt.join(', ')}.`, ok: false }); return; }
    setBusy(true); setMsg(null);
    const p = await persist();
    setBusy(false);
    if (p) setMsg({ text: 'Gespeichert. Der nächste Suchlauf nutzt die neuen Angaben.', ok: true });
  }

  async function cvHerunterladen() {
    if (!profile?.cv_path) return;
    try { download(await downloadCv(profile.cv_path), 'Lebenslauf.pdf'); } catch (e) { setMsg({ text: e instanceof ApiError ? e.message : 'Download fehlgeschlagen.', ok: false }); }
  }

  const dropProps = {
    onDragOver: (e: DragEvent) => { e.preventDefault(); setOver(true); },
    onDragLeave: () => setOver(false),
    onDrop: (e: DragEvent) => { e.preventDefault(); setOver(false); void takeFile(e.dataTransfer.files[0]); },
  };

  const teilLebenslauf = (
    <section className="stack" aria-labelledby="t-cv">
      <h2 id="t-cv" className="h2">Dein Lebenslauf</h2>
      <p className="muted small" style={{ marginTop: -8 }}>Jobbster schreibt nur mit dem, was hier steht. Nichts wird erfunden.</p>
      <button type="button" className={`drop ${over ? 'over' : ''}`} onClick={() => fileRef.current?.click()} {...dropProps}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 15V4M7.5 8.5 12 4l4.5 4.5M4.5 15v3.5a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5V15" /></svg>
        <b>PDF auswählen oder hierher ziehen</b>
        <span className="muted small">Bis 5 MB. Der Text wird auf deinem Gerät gelesen.</span>
      </button>
      <input ref={fileRef} id="cv-datei" type="file" accept="application/pdf,.pdf" className="sr" onChange={(e) => { void takeFile(e.target.files?.[0]); e.target.value = ''; }} />
      <p className="msg" role="status">{cvInfo}</p>
      {asProfile && profile?.cv_path && <button type="button" className="btn ghost" onClick={() => { void cvHerunterladen(); }}>Gespeicherte PDF herunterladen</button>}
      <label className="field"><span>Text des Lebenslaufs</span>
        <textarea className="textarea" id="cv-text" rows={10} maxLength={30000} value={d.cv_text} onChange={(e) => set('cv_text', e.target.value)} aria-describedby="cv-hint" />
        <small id="cv-hint">{d.cv_text.length.toLocaleString('de-AT')} von 30.000 Zeichen</small>
      </label>
    </section>
  );

  const teilPerson = (
    <section className="stack" aria-labelledby="t-du">
      <h2 id="t-du" className="h2">Über dich</h2>
      <div className="grid2">
        <label className="field"><span>Name</span><input className="input" id="p-name" autoComplete="name" value={d.full_name} onChange={(e) => set('full_name', e.target.value)} /></label>
        <label className="field"><span>E-Mail für Bewerbungen</span><input className="input" id="p-mail" type="email" autoComplete="email" value={d.application_email} onChange={(e) => set('application_email', e.target.value)} /></label>
        <label className="field"><span>Telefon (optional)</span><input className="input" id="p-tel" type="tel" autoComplete="tel" value={d.phone} onChange={(e) => set('phone', e.target.value)} /></label>
        <label className="field"><span>LinkedIn (optional)</span><input className="input" id="p-li" type="url" inputMode="url" value={d.linkedin_url} onChange={(e) => set('linkedin_url', e.target.value)} placeholder="https://www.linkedin.com/in/…" /></label>
        <label className="field"><span>Wohnort (optional)</span><input className="input" id="p-ort" autoComplete="address-level2" value={d.location} onChange={(e) => set('location', e.target.value)} /></label>
        <label className="field"><span>Sprachen mit Niveau</span><input className="input" id="p-spr" value={d.languages} onChange={(e) => set('languages', e.target.value)} placeholder="Deutsch Muttersprache, Englisch B2" /></label>
      </div>
    </section>
  );

  const teilSuche = (
    <section className="stack" aria-labelledby="t-suche">
      <h2 id="t-suche" className="h2">Was du suchst</h2>
      <div className="traumjob stack" style={{ gap: 10 }}>
        <label className="field"><span>Beschreib deinen perfekten Job</span>
          <textarea className="textarea" id="s-traumjob" rows={5} maxLength={2000} value={d.traumjob} onChange={(e) => set('traumjob', e.target.value)} aria-describedby="s-traumjob-h"
            placeholder="Was machst du den ganzen Tag? In welcher Branche, welcher Stadt, mit welchem Team? Was ist dir wichtig, was willst du auf keinen Fall?" />
          <small id="s-traumjob-h">Je genauer, desto besser passen Treffer und Anschreiben. Daraus füllt die KI die Felder unten aus.</small>
        </label>
        <div className="row">
          <button type="button" className="btn second" id="s-vorschlag" onClick={() => { void vorschlagHolen(); }} disabled={vorschlagLaeuft || busy}>{vorschlagLaeuft ? <span className="spinner" aria-hidden="true" /> : null}{vorschlagLaeuft ? 'Wird ausgewertet' : 'Felder daraus ausfüllen'}</button>
          <span className={`msg ${vorschlagMsg?.ok ? 'ok' : 'err'}`} role="status">{vorschlagMsg?.text}</span>
        </div>
      </div>
      <label className="field"><span>Zielrollen</span>
        <textarea className="textarea" id="s-rollen" rows={3} maxLength={600} value={d.zielrollen} onChange={(e) => set('zielrollen', e.target.value)} placeholder="Zum Beispiel: Junior Consultant, Trainee Vertrieb, Business Analyst" />
      </label>
      <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
        <legend style={{ marginBottom: 6 }}>Stellenarten</legend>
        <div className="chips">
          {ARTEN.map((a) => (
            <label key={a}><input type="checkbox" checked={d.stellenarten.includes(a)} onChange={(e) => set('stellenarten', e.target.checked ? [...d.stellenarten, a] : d.stellenarten.filter((x) => x !== a))} />{a}</label>
          ))}
        </div>
      </fieldset>
      <div className="grid2">
        <label className="field"><span>Orte, der wichtigste zuerst</span>
          <input className="input" id="s-orte" value={d.orte} onChange={(e) => set('orte', e.target.value)} placeholder="Innsbruck, München, remote" aria-describedby="s-orte-h" />
          <small id="s-orte-h">Mit Komma trennen.</small>
        </label>
        <label className="field"><span>Start</span><input className="input" id="s-start" value={d.start} onChange={(e) => set('start', e.target.value)} placeholder="ab Februar 2027" /></label>
        <label className="field"><span>Land für die Suche</span>
          <select className="select" id="s-land" value={d.land} onChange={(e) => set('land', e.target.value)}>{LAENDER.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        </label>
        <label className="field"><span>Was nicht (optional)</span><input className="input" id="s-nicht" value={d.ausschluesse} onChange={(e) => set('ausschluesse', e.target.value)} placeholder="Außendienst, Zeitarbeit" /></label>
      </div>
      <div className="field menge">
        <label htmlFor="s-pro-tag"><span>Bewerbungen pro Tag</span> <b className="nums">{d.pro_tag}</b></label>
        <input id="s-pro-tag" type="range" min={PRO_TAG.min} max={PRO_TAG.max} step={1} value={d.pro_tag} onChange={(e) => set('pro_tag', proTag(e.target.value))} aria-describedby="s-pro-tag-h" />
        <small id="s-pro-tag-h">Empfohlen: {PRO_TAG.empfohlen}. So viele passende Stellen sucht {MARKE} jeden Morgen. Die Entwürfe schreibst du per Knopfdruck.</small>
      </div>
    </section>
  );

  const teilFein = (
    <section className="stack" aria-labelledby="t-fein">
      <h2 id="t-fein" className="h2">Feinschliff</h2>
      <label className="field"><span>Engagement neben Studium oder Job (optional)</span>
        <textarea className="textarea" id="f-eng" rows={3} maxLength={600} value={d.engagement} onChange={(e) => set('engagement', e.target.value)} placeholder="Ein Satz davon kommt ins Anschreiben. Nur, was stimmt." />
      </label>
      <label className="field"><span>Weitere Wünsche an die Suche (optional)</span>
        <textarea className="textarea" id="f-wunsch" rows={3} maxLength={800} value={d.wuensche} onChange={(e) => set('wuensche', e.target.value)} placeholder="Zum Beispiel: lieber kleinere Firmen, Englisch als Arbeitssprache ok" />
      </label>
    </section>
  );

  if (asProfile) {
    return (
      <form className="stack" onSubmit={(e) => { void saveAll(e); }} noValidate>
        <div className="page-title"><div><h1>Profil</h1><p>Daraus sucht Jobbster jeden Morgen Stellen und schreibt Entwürfe.</p></div><button className="btn" type="submit" disabled={busy}>{busy ? <span className="spinner" aria-hidden="true" /> : null}Speichern</button></div>
        <div className="card stack">{teilLebenslauf}</div>
        <div className="card stack">{teilPerson}</div>
        <div className="card stack">{teilSuche}</div>
        <div className="card stack">{teilFein}</div>
        <div className="row"><button className="btn big" type="submit" disabled={busy}>Speichern</button><p className={`msg ${msg?.ok ? 'ok' : 'err'}`} role="status">{msg?.text}</p></div>
      </form>
    );
  }

  const teile = [teilLebenslauf, teilPerson, teilSuche, teilFein];
  const letzter = step >= teile.length;
  const gesamt = teile.length + 1;
  return (
    <main className="auth" style={{ alignItems: 'start' }}>
      <div className="auth-box wizard">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <Marke to="/start" />
          <span className="step-label">Schritt {Math.min(step + 1, gesamt)} von {gesamt}{!letzter ? ` · ${TITEL[step]}` : ''}</span>
        </div>
        <div className="steps" style={{ ['--n' as string]: gesamt }} aria-label={`Schritt ${Math.min(step + 1, gesamt)} von ${gesamt}`} role="progressbar" aria-valuemin={1} aria-valuemax={gesamt} aria-valuenow={Math.min(step + 1, gesamt)}>
          {[...teile, null].map((_, n) => <span key={n} className={n <= step ? 'on' : ''} />)}
        </div>
        <form className="auth-card" onSubmit={(e) => { void next(e); }} noValidate>
          <div key={step} className="fade-in stack">
            {!letzter ? teile[step] : (
              <section className="stack" aria-labelledby="t-fertig">
                <h2 id="t-fertig" className="display" style={{ fontSize: 22 }}>Fertig eingerichtet.</h2>
                <p className="muted">{access.aktiv
                  ? `Jobbster startet jetzt den ersten Suchlauf. Die Treffer erscheinen in den nächsten Minuten. Danach sucht es jeden Morgen ${d.pro_tag === 1 ? 'eine passende Stelle' : `${d.pro_tag} passende Stellen`}, so wie eingestellt.`
                  : 'Dein Profil ist gespeichert. Starte die Probe im Konto, dann beginnt der erste Suchlauf.'}</p>
                <button type="button" className="btn big wide" onClick={() => { void finish(); }} disabled={busy}>{busy ? <span className="spinner" aria-hidden="true" /> : null}{access.aktiv ? 'Erste Suche starten' : 'Weiter'}</button>
              </section>
            )}
          </div>
          <p className={`msg ${msg?.ok ? 'ok' : 'err'}`} role="alert">{msg?.text}</p>
          {!letzter && (
            <div className="row" style={{ justifyContent: 'space-between', borderTop: '1px solid var(--line)', paddingTop: 16 }}>
              <button type="button" className="btn ghost" onClick={() => setStep((s) => Math.max(0, s - 1))} disabled={step === 0 || busy}>Zurück</button>
              <button type="submit" className="btn big" disabled={busy}>{busy ? <span className="spinner" aria-hidden="true" /> : null}Weiter</button>
            </div>
          )}
        </form>
        <p className="muted small" style={{ textAlign: 'center' }}>Wird nach jedem Schritt gespeichert. <Link to="/konto">Zum Konto</Link></p>
      </div>
    </main>
  );
}
