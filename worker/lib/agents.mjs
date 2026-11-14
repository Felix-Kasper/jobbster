// Jobbster · Die drei Agenten als reine Funktionen: Eingabe rein, Ergebnis und Verbrauch raus.
// Kein Datenbankzugriff hier. Das macht worker.mjs (oder die Edge Function).
import { HAIKU, SONNET, werkzeuge, leseJson, summe } from './claude.mjs';
import * as P from './prompts.mjs';

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Number.isFinite(Number(n)) ? Math.round(Number(n)) : 0));
const datum = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(s || '') && !Number.isNaN(Date.parse(s)) ? s : null);
const leer = (s) => (s && String(s).trim() && !/^unbekannt$/i.test(String(s).trim()) ? String(s).trim() : null);
const ohneStrich = (s) => String(s || '').replace(/\s[–—]\s/g, ', ').replace(/[–—]/g, '-');
const firmaKey = (s) => String(s || '').toLowerCase().replace(/\(.*?\)|\b(gmbh|mbh|ag|se|kg|kgaa|co|inc|ltd|group|gruppe|holding)\b|[^a-z0-9äöüß]/g, '');

export const STANDARD = {
  modellScout: HAIKU,
  modellRecherche: HAIKU,
  modellText: SONNET,
  variante: 'filter', // nach dem Spike festlegen: 'filter' oder 'einfach'
  treffer: 10,
  suchen: 10,
  abrufe: 6,
};

/** Bewerbungen pro Tag laut Profil: so viele Treffer sucht der tägliche Lauf. Empfohlen 10, erlaubt 1 bis 12. */
export const PRO_TAG = { min: 1, max: 12, empfohlen: 10 };
export const proTag = (profil) => clamp(profil?.preferences?.pro_tag ?? PRO_TAG.empfohlen, PRO_TAG.min, PRO_TAG.max);

function ortFuerSuche(profil) {
  const w = profil.preferences || {};
  return { land: w.land || 'AT', zeitzone: w.zeitzone || 'Europe/Vienna' };
}

/** Scout: Suche mit Werkzeugen, dann Bewertung als strukturierte Ausgabe. */
export async function scout({ claude, profil, bekannt = [], signale = '', cfg = {} }) {
  const ziel = cfg.treffer ?? proTag(profil);
  const c = { ...STANDARD, suchen: clamp(ziel + 2, 6, 14), ...cfg, treffer: ziel };
  const heute = c.heute || new Date().toISOString().slice(0, 10);
  const hinweise = [];
  const profilT = P.profilText(profil);

  const user = [
    `PROFIL\n${profilT}`,
    bekannt.length ? `SCHON BEKANNT (nicht erneut aufnehmen)\n${bekannt.slice(0, 120).join('; ')}` : '',
    signale ? `SIGNALE\n${signale}` : '',
    'Suche jetzt und gib die Trefferliste aus.',
  ].filter(Boolean).join('\n\n');

  const suche = await claude.zugMitWerkzeugen(
    { model: c.modellScout, system: P.scoutSuche({ heute, treffer: c.treffer, suchen: c.suchen, abrufe: c.abrufe }), user },
    werkzeuge(c.variante, { suchen: c.suchen, abrufe: c.abrufe, ...ortFuerSuche(profil) }),
  );
  if (suche.stop !== 'end_turn') hinweise.push(`Suche endete mit ${suche.stop}`);
  if (suche.werkzeugFehler.length) hinweise.push(`Werkzeug-Fehler: ${[...new Set(suche.werkzeugFehler)].join(', ')}`);

  let bewertung = null;
  let daten = { leads: [], abgelehnt: [] };
  if (suche.text.includes('###')) {
    bewertung = await claude.zug({
      model: c.modellScout,
      system: P.scoutBewertung({ heute }),
      user: `PROFIL\n${profilT}\n\nTREFFERLISTE\n${suche.text}`,
      format: P.LEADS_SCHEMA,
    });
    const gelesen = leseJson(bewertung.text);
    if (gelesen) daten = gelesen;
    else hinweise.push(`Bewertung lieferte kein lesbares JSON (${bewertung.stop})`);
  } else {
    hinweise.push('Suche lieferte keine Trefferliste');
  }

  const gesehen = new Set(bekannt.map(firmaKey));
  const leads = [];
  for (const l of daten.leads || []) {
    const key = firmaKey(l.company);
    if (!key || !leer(l.title) || gesehen.has(key)) continue;
    gesehen.add(key);
    const url = /^https?:\/\//i.test(l.url || '') ? l.url.trim() : null;
    if (!url) continue; // ohne Link zur Anzeige ist ein Treffer nichts wert
    const mail = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(l.apply_email || '') ? l.apply_email.trim() : null;
    leads.push({
      dedup_key: `stelle|${l.company}|${l.title}|${leer(l.location) ?? ''}`.toLowerCase().replace(/\s+/g, ' ').trim(),
      kind: 'stelle',
      source: leer(l.source),
      company: l.company.trim(),
      title: l.title.trim(),
      location: leer(l.location),
      url,
      apply_channel: l.apply_channel === 'email' && mail ? 'email' : l.apply_channel === 'linkedin' ? 'linkedin' : 'portal',
      apply_email: mail,
      posted_at: datum(l.posted_at),
      deadline: datum(l.deadline),
      salary: leer(l.salary),
      language: l.language === 'en' ? 'en' : 'de',
      match_score: clamp(l.rolle, 0, 35) + clamp(l.lebenslauf, 0, 20) + clamp(l.chance, 0, 35) + clamp(l.ort, 0, 10),
      keywords: (l.keywords || []).slice(0, 15).map((k) => ({ term: String(k.term).slice(0, 60), matched: Boolean(k.matched) })),
      summary: ohneStrich(l.summary),
      requirements: (l.requirements || []).map((x) => `- ${ohneStrich(x)}`).join('\n'),
      why_fit: ohneStrich(l.why_fit),
      pre_info: [l.verified_online ? '' : 'Hinweis: Anzeige nicht geprüft, vor dem Bewerben öffnen.', ohneStrich(l.pre_info)].filter(Boolean).join(' ') || null,
    });
  }
  leads.sort((a, b) => b.match_score - a.match_score);

  return { leads: leads.slice(0, c.treffer), abgelehnt: daten.abgelehnt || [], hinweise, werkzeug: suche.werkzeug, nutzung: summe(suche, bewertung), model: c.modellScout };
}

function stelleText(lead) {
  return [
    'STELLE',
    `Firma: ${lead.company}`,
    `Titel: ${lead.title}`,
    `Ort: ${lead.location || 'unbekannt'}`,
    `Link: ${lead.url || 'unbekannt'}`,
    `Sprache der Anzeige: ${lead.language || 'de'}`,
    `Ansprechpartner: ${lead.contact_name || 'unbekannt'}`,
    `Inhalt: ${lead.summary || ''}`,
    `Anforderungen:\n${lead.requirements || ''}`,
    lead.pre_info ? `Vorinfos: ${lead.pre_info}` : '',
  ].filter(Boolean).join('\n');
}

/** Schreiber: kurze Recherche zur Firma, dann Entwurf als strukturierte Ausgabe. */
export async function entwurf({ claude, profil, lead, cfg = {} }) {
  const c = { ...STANDARD, ...cfg };
  const heute = c.heute || new Date().toISOString().slice(0, 10);
  const hinweise = [];
  const profilT = P.profilText(profil);
  const stelle = stelleText(lead);

  let recherche = null;
  try {
    recherche = await claude.zugMitWerkzeugen(
      { model: c.modellRecherche, system: P.schreiberRecherche({ heute }), user: `PROFIL\n${profilT}\n\n${stelle}`, maxTokens: 6000 },
      werkzeuge('einfach', { suchen: 3, abrufe: 0, ...ortFuerSuche(profil) }),
    );
  } catch (e) {
    hinweise.push(`Recherche fehlgeschlagen: ${String(e.message).slice(0, 120)}`);
  }

  const text = await claude.zug({
    model: c.modellText,
    system: P.schreiber({ heute }),
    user: `PROFIL\n${profilT}\n\n${stelle}\n\nRECHERCHE ZUR FIRMA\n${recherche?.text || 'keine'}`,
    format: P.ENTWURF_SCHEMA,
    maxTokens: 8000,
  });
  const e = leseJson(text.text);
  if (!e) throw new Error(`Entwurf lieferte kein lesbares JSON (${text.stop})`);

  let brief = ohneStrich(e.cover_letter);
  let kuerzung = null;
  if (brief.length > 1800) {
    kuerzung = await claude.zug({
      model: c.modellText,
      system: 'Kürze das Anschreiben auf höchstens 1.700 Zeichen inklusive Betreff, Anrede und Grußformel. Aufbau, Fakten und Zahlen bleiben, nichts hinzufügen. Kein Gedankenstrich als Satzzeichen. Gib nur das gekürzte Anschreiben aus.',
      user: brief,
      maxTokens: 4000,
    });
    if (kuerzung.text.trim().length > 400) brief = ohneStrich(kuerzung.text.trim());
    if (brief.length > 2000) hinweise.push(`Anschreiben bleibt mit ${brief.length} Zeichen zu lang`);
  }

  return {
    felder: {
      email_subject: ohneStrich(e.email_subject).slice(0, 300),
      email_body: ohneStrich(e.email_body),
      cover_letter_md: brief,
      cv_highlights: (e.cv_highlights || []).map((x) => `- ${ohneStrich(x)}`).join('\n'),
      pre_info: [lead.pre_info, ohneStrich(e.pre_info)].filter(Boolean).join(' ').slice(0, 2000) || null,
    },
    leitgedanke: e.leitgedanke,
    hinweise,
    nutzung: summe(recherche, text, kuerzung),
    model: c.modellText,
  };
}

/** Coach: Recherche zu Firma und Gesprächspartnern, dann der Spickzettel als strukturierte Ausgabe. */
export async function vorbereitung({ claude, profil, lead, stufe = 'interview1', cfg = {} }) {
  const c = { ...STANDARD, ...cfg };
  const heute = c.heute || new Date().toISOString().slice(0, 10);
  const hinweise = [];
  const profilT = P.profilText(profil);
  const eingabe = (stufe === 'interview2' ? lead.interview2_input : lead.interview1_input) || {};
  const einladung = `EINLADUNG UND ANGABEN DER PERSON\n${JSON.stringify(eingabe).slice(0, 12000)}`;
  const stelle = stelleText(lead);

  let recherche = null;
  try {
    recherche = await claude.zugMitWerkzeugen(
      { model: c.modellRecherche, system: P.coachRecherche({ heute, stufe }), user: `${stelle}\n\n${einladung}`, maxTokens: 8000 },
      werkzeuge(c.variante, { suchen: 8, abrufe: 4, ...ortFuerSuche(profil) }),
    );
  } catch (e) {
    hinweise.push(`Recherche fehlgeschlagen: ${String(e.message).slice(0, 120)}`);
  }

  const teile = [
    `PROFIL\n${profilT}`,
    stelle,
    einladung,
    lead.cover_letter_md ? `ANSCHREIBEN DER PERSON\n${lead.cover_letter_md}` : '',
    stufe === 'interview2' && lead.interview1_prep ? `RÜCKBLICK: Kernbotschaften der ersten Runde\n${JSON.stringify(lead.interview1_prep.must_say || [])}` : '',
    `RECHERCHE\n${recherche?.text || 'keine'}`,
  ].filter(Boolean).join('\n\n');

  const text = await claude.zug({ model: c.modellText, system: P.coach({ heute, stufe }), user: teile, format: P.PREP_SCHEMA, maxTokens: 12000 });
  const p = leseJson(text.text);
  if (!p) throw new Error(`Vorbereitung lieferte kein lesbares JSON (${text.stop})`);

  const sauber = JSON.parse(JSON.stringify(p), (k, v) => (typeof v === 'string' && k !== 'url' && k !== 'link' ? ohneStrich(v) : v));
  sauber.salary = stufe === 'interview2' && sauber.salary ? sauber.salary : null;
  sauber.people = (sauber.people || []).map((x) => ({ ...x, link: /^https?:\/\//i.test(x.link || '') ? x.link : '' }));
  sauber.sources = (sauber.sources || []).filter((s) => /^https?:\/\//i.test(s.url || ''));
  sauber.generated_at = new Date().toISOString();

  return { prep: sauber, hinweise, nutzung: summe(recherche, text), model: c.modellText };
}
