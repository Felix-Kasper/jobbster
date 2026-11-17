// Jobbster · Die drei Agenten als reine Funktionen: Eingabe rein, Ergebnis und Verbrauch raus.
// Kein Datenbankzugriff hier. Das macht worker.mjs (oder die Edge Function).
import { HAIKU, SONNET, werkzeuge, leseJson, summe } from './claude.mjs';
import * as P from './prompts.mjs';
import * as Q from './quellen.mjs';

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Number.isFinite(Number(n)) ? Math.round(Number(n)) : 0));
const datum = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(s || '') && !Number.isNaN(Date.parse(s)) ? s : null);
const leer = (s) => (s && String(s).trim() && !/^unbekannt$/i.test(String(s).trim()) ? String(s).trim() : null);
const ohneStrich = (s) => String(s || '').replace(/\s[–—]\s/g, ', ').replace(/[–—]/g, '-');

export const STANDARD = {
  modellScout: HAIKU,
  modellRecherche: HAIKU,
  modellText: SONNET,
  variante: 'filter', // nach dem Spike festlegen: 'filter' oder 'einfach'
  treffer: 10,
  suchen: 10,
  abrufe: 6,
  quellen: true, // echte Anzeigen aus Arbeitsagentur und EURES
  websucheWennLeer: true, // Websuche nur, wenn keine Quelle die Orte abdeckt
  // Gemessen am 16.11.2026: Nachdenken vor dem Anschreiben kostete 3,4 Cent je Entwurf (zwei Drittel der Ausgabe) ohne sichtbar besseren Text.
  // Haiku als Schreiber kostet nur 0,1 Cent, schreibt aber unzuverlässiger (verriet zum Beispiel die Rangfolge der Wunschorte).
  textDenken: false,
  textAufwand: null, // null = Standard des Modells
  // Entscheidung Felix 16.11.: Die Liste soll immer voll werden, auch mit ähnlichen und anspruchsvolleren Stellen.
  // Die Rangfolge (passt, ähnlich oder anspruchsvoller, leichter) und eine ehrliche Chance stehen bei jedem Treffer.
  mindestMatch: 0,
  webErgaenzung: true, // fehlen nach den Quellen Treffer, sucht eine kleine Websuche dort, wo die Quellen nicht hinkommen
  ergaenzungAb: 2, // erst ab so vielen fehlenden Treffern (jede Websuche kostet 1 Cent)
  ergaenzungSuchen: 4,
};

/** Bewerbungen pro Tag laut Profil: so viele Treffer sucht der tägliche Lauf. Empfohlen 10, erlaubt 1 bis 12. */
export const PRO_TAG = { min: 1, max: 12, empfohlen: 10 };
export const proTag = (profil) => clamp(profil?.preferences?.pro_tag ?? PRO_TAG.empfohlen, PRO_TAG.min, PRO_TAG.max);

function ortFuerSuche(profil) {
  const w = profil.preferences || {};
  return { land: w.land || 'AT', zeitzone: w.zeitzone || 'Europe/Vienna' };
}

/**
 * Scout: tägliche Stellensuche.
 * 1. Echte Anzeigen aus den Stellen-Quellen (Arbeitsagentur, EURES), ohne KI vorsortiert, dann von der KI bewertet.
 * 2. Fehlen danach Treffer, ergänzt eine kleine Websuche (karriere.at, StepStone, LinkedIn Jobs, Karriereseiten).
 * 3. Deckt keine Quelle die Orte des Profils ab (anderes Land, Ausfall), läuft die volle Websuche als Reserve.
 */
export async function scout({ claude, profil, bekannt = [], signale = '', cfg = {}, holen = globalThis.fetch }) {
  const ziel = cfg.treffer ?? proTag(profil);
  const c = { ...STANDARD, suchen: clamp(ziel + 2, 6, 14), ...cfg, treffer: ziel };
  c.heute = c.heute || new Date().toISOString().slice(0, 10);
  const profilT = P.profilText(profil);

  if (!c.quellen) return scoutAusWebsuche({ claude, profil, profilT, bekannt, signale, c });

  const r = await scoutAusQuellen({ claude, profil, profilT, bekannt, signale, c, holen });
  const q = r.ergebnis;
  const fehlend = c.treffer - q.leads.length;
  const ergaenzen = r.abgedeckt && c.webErgaenzung && fehlend >= c.ergaenzungAb;
  const reserve = !r.abgedeckt && c.websucheWennLeer;
  if (!ergaenzen && !reserve) return q;

  // Ergänzung: wenige Suchen, keine Abrufe, kein Nachdenken. Reserve (keine Quelle deckt die Orte ab): volle Websuche.
  // Mit Suchwerkzeug nicht ganz ohne Nachdenken: Am 17.11. lieferte Haiku so nur ungültige Suchanfragen. Wenig Aufwand reicht.
  const cWeb = ergaenzen ? { ...c, treffer: fehlend, suchen: c.ergaenzungSuchen, abrufe: 0, webAufwand: 'low', ergaenzung: true } : c;
  let web;
  try {
    web = await scoutAusWebsuche({ claude, profil, profilT, bekannt: [...bekannt, ...q.leads.map((l) => l.company)], signale, c: cWeb });
  } catch (e) {
    if (!ergaenzen) throw e;
    return { ...q, hinweise: [...q.hinweise, `Websuche zur Ergänzung fehlgeschlagen (${String(e.message).slice(0, 80)})`] };
  }
  return {
    leads: [...q.leads, ...web.leads].slice(0, c.treffer),
    abgelehnt: [...q.abgelehnt, ...web.abgelehnt],
    hinweise: [...q.hinweise, ergaenzen ? `Websuche ergänzt ${fehlend} fehlende Treffer` : 'Quellen decken die Orte nicht ab, Websuche als Reserve', ...web.hinweise],
    werkzeug: ergaenzen ? 'quellen+web' : web.werkzeug,
    nutzung: summe(q.nutzung, web.nutzung),
    model: c.modellScout,
  };
}

/** Suchbegriffe: aus den Zielrollen abgeleitet, von der KI um Synonyme ergänzt. Fällt die KI aus, reichen die eigenen. */
async function suchbegriffe({ claude, profil, profilT, c, hinweise }) {
  const eigene = Q.begriffeAusRollen(profil.preferences?.zielrollen);
  let plan = null;
  try {
    plan = await claude.zug({ model: c.modellScout, system: P.scoutSuchplan(), user: `PROFIL\n${profilT.slice(0, 6000)}`, format: P.SUCHPLAN_SCHEMA, maxTokens: 600, denken: false, aufwand: 'low' });
  } catch (e) {
    hinweise.push(`Suchplan ohne KI (${String(e.message).slice(0, 80)})`);
  }
  const vonKi = leseJson(plan?.text ?? '');
  const liste = (x) => (Array.isArray(x) ? x : []);
  const begriffe = Q.begriffeMischen(eigene, liste(vonKi?.begriffe));
  const kern = new Set(begriffe.map((b) => b.toLowerCase()));
  // Verwandte Rollen füllen die Liste auf, wenn die Kernrolle nicht genug hergibt
  const verwandt = Q.begriffeMischen(liste(vonKi?.verwandt)).filter((b) => !kern.has(b.toLowerCase()));
  return { begriffe, verwandt, plan };
}

async function scoutAusQuellen({ claude, profil, profilT, bekannt, signale, c, holen }) {
  const w = profil.preferences || {};
  const hinweise = [];
  const leer = (nutzung, abgedeckt = false) => ({ abgedeckt, ergebnis: { leads: [], abgelehnt: [], hinweise, werkzeug: 'quellen', nutzung, model: c.modellScout } });

  const orte = Q.ortPlan(w.orte, w.land);
  if (!orte.length) {
    hinweise.push('Profil ohne Ort für die Stellen-Quellen');
    return leer(summe());
  }
  const { begriffe, verwandt, plan } = await suchbegriffe({ claude, profil, profilT, c, hinweise });
  if (!begriffe.length) {
    hinweise.push('Profil ohne Zielrollen für die Stellen-Quellen');
    return leer(summe(plan));
  }

  const arten = (Array.isArray(w.stellenarten) ? w.stellenarten : []).join(' ').toLowerCase();
  const roh = await Q.sammle({ holen, begriffe, verwandt, orte, mitPraktikum: !arten || /trainee|praktik|graduate/.test(arten) });
  hinweise.push(...roh.hinweise);
  const erfahren = /senior|leitung|führung|fuehrung|erfahren/i.test(`${w.level ?? ''}`);
  const wunsch = `${arten} ${String(w.zielrollen ?? '')} ${String(w.level ?? '')}`.toLowerCase();
  const auswahl = Q.vorauswahl(roh.kandidaten, {
    begriffe, verwandt, bekannt, ausschluesse: w.ausschluesse, erfahren, max: clamp(c.treffer * 3, 15, 36),
    praktikum: !arten || /praktik|intern/.test(wunsch), werkstudent: /werkstudent|working student/.test(wunsch),
  });
  const { kandidaten, fehlgeschlagen } = await Q.anreichern(holen, auswahl);
  if (fehlgeschlagen) hinweise.push(`Quelle: ${fehlgeschlagen} Anzeigen ohne Details`);
  hinweise.push(`Quellen: ${roh.anfragen} Anfragen (${begriffe.join(' · ')}${verwandt.length ? `; verwandt: ${verwandt.join(' · ')}` : ''} in ${orte.map((o) => o.name).join(', ')}), ${roh.kandidaten.length} Anzeigen, ${kandidaten.length} in der Bewertung`);
  if (!kandidaten.length) return leer(summe(plan), roh.beantwortet > 0);

  const bewertung = await claude.zug({
    model: c.modellScout,
    system: P.scoutBewertung({ heute: c.heute }),
    user: [
      `PROFIL\n${profilT}`,
      signale ? `SIGNALE (was die Person bisher beworben oder aussortiert hat)\n${signale}` : '',
      `TREFFERLISTE\n${Q.trefferliste(kandidaten)}`,
      // Die Ausgabe ist der teure und langsame Teil: nur so viele ausführlich, wie gebraucht werden.
      // 4 mehr als nötig, weil doppelte Firmen (Name nur im Anzeigentext) danach noch wegfallen.
      `Die Liste hat ${kandidaten.length} Treffer. Gib ${Math.min(kandidaten.length, c.treffer + 4)} davon in leads aus, nach der Reihenfolge der Vorliebe, und fülle mit ähnlichen und anspruchsvolleren auf. Weniger nur, wenn die Liste nach den Regeln nicht mehr hergibt. Was gar nicht geht, kommt mit Grund in höchstens 8 Wörtern in abgelehnt. Den Rest lässt du weg.`,
    ].filter(Boolean).join('\n\n'),
    format: P.LEADS_SCHEMA,
    maxTokens: 20000,
    denken: false, // die Begründung steht ohnehin in why_fit; Nachdenken davor kostete das Vierfache der Antwort
  });
  const daten = leseJson(bewertung.text) ?? retteLeads(bewertung.text);
  if (!daten) hinweise.push(`Bewertung lieferte kein lesbares JSON (${bewertung.stop})`);
  else if (bewertung.stop === 'max_tokens') hinweise.push('Bewertung abgeschnitten, vollständige Treffer gerettet');
  hinweise.push(`Bewertung: ${daten?.leads?.length ?? 0} Treffer, ${daten?.abgelehnt?.length ?? 0} abgelehnt, ${bewertung.tokensAus} Tokens Ausgabe (${bewertung.tokensDenken || 0} davon Nachdenken), ${Math.round(bewertung.ms / 1000)} s`);
  const alle = leadsAusBewertung(daten?.leads, { bekannt, kandidaten });
  const leads = alle.filter((l) => l.match_score >= c.mindestMatch);
  if (alle.length > leads.length) hinweise.push(`${alle.length - leads.length} Treffer unter ${c.mindestMatch} Punkten nicht übernommen`);
  return { abgedeckt: true, ergebnis: { leads: leads.slice(0, c.treffer), abgelehnt: daten?.abgelehnt || [], hinweise, werkzeug: 'quellen', nutzung: summe(plan, bewertung), model: c.modellScout } };
}

async function scoutAusWebsuche({ claude, profil, profilT, bekannt, signale, c }) {
  const hinweise = [];
  const user = [
    `PROFIL\n${profilT}`,
    bekannt.length ? `SCHON BEKANNT (nicht erneut aufnehmen)\n${bekannt.slice(0, 120).join('; ')}` : '',
    signale ? `SIGNALE\n${signale}` : '',
    c.ergaenzung ? 'Die Stellen der Arbeitsagentur und des AMS sind schon ausgewertet. Suche gezielt dort, wo diese nicht hinkommen: karriere.at, StepStone, LinkedIn Jobs, Indeed, XING und Karriereseiten von Arbeitgebern der Region.' : '',
    'Suche jetzt und gib die Trefferliste aus.',
  ].filter(Boolean).join('\n\n');

  const suche = await claude.zugMitWerkzeugen(
    { model: c.modellScout, system: P.scoutSuche({ heute: c.heute, treffer: c.treffer, suchen: c.suchen, abrufe: c.abrufe }), user, ...(c.webAufwand ? { aufwand: c.webAufwand, maxTokens: 14000 } : {}) },
    werkzeuge(c.variante, { suchen: c.suchen, abrufe: c.abrufe, ...ortFuerSuche(profil) }),
  );
  if (suche.stop !== 'end_turn') hinweise.push(`Suche endete mit ${suche.stop}`);
  const bloecke = (suche.text.match(/^###/gm) || []).length;
  hinweise.push(`${suche.suchen} Suchen, ${suche.abrufe} Abrufe, ${bloecke} Kandidaten: ${suche.suchbegriffe.join(' · ')}`);
  if (suche.werkzeugFehler.length) hinweise.push(`Werkzeug-Fehler: ${[...new Set(suche.werkzeugFehler)].join(', ')}`);

  let bewertung = null;
  let daten = { leads: [], abgelehnt: [] };
  if (suche.text.includes('###')) {
    bewertung = await claude.zug({
      model: c.modellScout,
      system: P.scoutBewertung({ heute: c.heute }),
      user: `PROFIL\n${profilT}\n\nTREFFERLISTE\n${suche.text}`,
      format: P.LEADS_SCHEMA,
      ...(c.webAufwand ? { denken: false } : {}),
    });
    const gelesen = leseJson(bewertung.text);
    if (gelesen) daten = gelesen;
    else hinweise.push(`Bewertung lieferte kein lesbares JSON (${bewertung.stop})`);
  } else {
    hinweise.push('Suche lieferte keine Trefferliste');
  }
  const leads = leadsAusBewertung(daten.leads, { bekannt });
  return { leads: leads.slice(0, c.treffer), abgelehnt: daten.abgelehnt || [], hinweise, werkzeug: suche.werkzeug, nutzung: summe(suche, bewertung), model: c.modellScout };
}

const STUFE = Symbol('stufe');
/** passung aus der Bewertung: Rang für die Reihenfolge und ehrlicher Vorsatz vor der Begründung. */
const PASSUNG = { passt: [0, ''], aehnlich: [1, 'Ähnliche Rolle: '], anspruchsvoller: [1, 'Anspruchsvoller: '], leichter: [2, 'Leichter als das Profil: '] };

/** Abgeschnittene Antwort (max_tokens): alle vollständig ausgegebenen Treffer behalten statt alles zu verwerfen. */
export function retteLeads(text) {
  const t = String(text ?? '');
  for (let i = t.lastIndexOf('},'); i > 0; i = t.lastIndexOf('},', i - 1)) {
    const gelesen = leseJson(`${t.slice(0, i + 1)}],"abgelehnt":[]}`);
    if (Array.isArray(gelesen?.leads) && gelesen.leads.length) return gelesen;
  }
  return null;
}

/**
 * Bewertung der KI in saubere Treffer für die Datenbank wandeln.
 * Mit `kandidaten` (aus den Quellen) kommen die Fakten aus der Schnittstelle, nicht von der KI:
 * Link, Datum, Quelle, Ort und Kontakt lassen sich so nicht erfinden. Die KI liefert Bewertung und Texte.
 */
export function leadsAusBewertung(roh, { bekannt = [], kandidaten = null } = {}) {
  const gesehen = new Set(bekannt.map(Q.firmaKey));
  const leads = [];
  for (const l of roh || []) {
    const k = kandidaten ? kandidaten[Number(l.nr) - 1] ?? kandidaten.find((x) => x.url === l.url) : null;
    if (kandidaten && !k) continue; // Treffer, den es in der Liste nicht gab
    const company = leer(k?.firma) ?? leer(l.company);
    const title = leer(k?.titel) ?? leer(l.title);
    const key = Q.firmaKey(company);
    if (!key || !title || gesehen.has(key)) continue;
    gesehen.add(key);
    const url = k?.url ?? (/^https?:\/\//i.test(l.url || '') ? l.url.trim() : null);
    if (!url) continue; // ohne Link zur Anzeige ist ein Treffer nichts wert
    const mail = [k?.mail, l.apply_email].find((m) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(m || ''))?.trim() ?? null;
    const location = leer(k?.ort) ?? leer(l.location);
    const [stufe, vorsatz] = PASSUNG[l.passung] ?? PASSUNG.passt;
    leads.push({
      [STUFE]: stufe,
      dedup_key: `stelle|${company}|${title}|${location ?? ''}`.toLowerCase().replace(/\s+/g, ' ').trim(),
      kind: 'stelle',
      source: leer(k?.quelle) ?? leer(l.source),
      company,
      title,
      location,
      url,
      apply_channel: l.apply_channel === 'email' && mail ? 'email' : l.apply_channel === 'linkedin' ? 'linkedin' : 'portal',
      apply_email: mail,
      posted_at: datum(k?.datum ?? l.posted_at),
      deadline: datum(l.deadline),
      salary: leer(l.salary),
      language: l.language === 'en' ? 'en' : 'de',
      match_score: clamp(l.rolle, 0, 35) + clamp(l.lebenslauf, 0, 20) + clamp(l.chance, 0, 35) + clamp(l.ort, 0, 10),
      keywords: (l.keywords || []).slice(0, 15).map((x) => ({ term: String(x.term).slice(0, 60), matched: Boolean(x.matched) })),
      summary: ohneStrich(l.summary),
      requirements: (l.requirements || []).map((x) => `- ${ohneStrich(x)}`).join('\n'),
      why_fit: `${vorsatz}${ohneStrich(l.why_fit)}`,
      pre_info: [k || l.verified_online ? '' : 'Hinweis: Anzeige nicht geprüft, vor dem Bewerben öffnen.', ohneStrich(l.pre_info)].filter(Boolean).join(' ') || null,
    });
  }
  // Erst was passt, dann Ähnliches und Anspruchsvolleres, Leichteres zuletzt. Innerhalb der Stufe nach Punkten.
  // Die Stufe hängt als Symbol am Treffer: Sie steuert nur die Reihenfolge und landet nicht in der Datenbank.
  return leads.sort((a, b) => a[STUFE] - b[STUFE] || b.match_score - a.match_score);
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
      // Jede Suche kostet 1 Cent und ist damit der teuerste Teil eines Entwurfs: höchstens zwei, ohne Nachdenken davor
      { model: c.modellRecherche, system: P.schreiberRecherche({ heute }), user: `PROFIL\n${profilT}\n\n${stelle}`, maxTokens: 3000, denken: false },
      werkzeuge('einfach', { suchen: 2, abrufe: 0, ...ortFuerSuche(profil) }),
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
    denken: c.textDenken,
    aufwand: c.textAufwand,
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

  const teil = (name, z) => (z ? `${name} ${z.usd.toFixed(4)} $ (${z.tokensEin} ein, ${z.tokensAus} aus, davon ${z.tokensDenken || 0} Nachdenken${z.suchen ? `, ${z.suchen} Suchen` : ''})` : null);
  hinweise.push(['Kosten:', teil('Recherche', recherche), teil('Text', text), teil('Kürzung', kuerzung)].filter(Boolean).join(' '));

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
      // Gemessen 17.11.: 8 Suchen mit Nachdenken kosteten 9 Cent. Die Recherche sammelt nur, das Denken passiert im Text danach.
      { model: c.modellRecherche, system: P.coachRecherche({ heute, stufe }), user: `${stelle}\n\n${einladung}`, maxTokens: 8000, denken: false },
      werkzeuge(c.variante, { suchen: 6, abrufe: 2, ...ortFuerSuche(profil) }),
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

  const teil = (name, z) => (z ? `${name} ${z.usd.toFixed(4)} $ (${z.tokensEin} ein, ${z.tokensAus} aus, davon ${z.tokensDenken || 0} Nachdenken${z.suchen ? `, ${z.suchen} Suchen, ${z.abrufe} Abrufe` : ''})` : null);
  hinweise.push(['Kosten:', teil('Recherche', recherche), teil('Text', text)].filter(Boolean).join(' '));
  return { prep: sauber, hinweise, nutzung: summe(recherche, text), model: c.modellText };
}
