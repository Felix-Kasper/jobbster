#!/usr/bin/env node
/**
 * Jobbster · Spike Tag 1 (11.11.2026)
 *
 * Misst mit einem ERFUNDENEN Profil:
 *   1. Scout über die Claude API mit Websuche: Trefferqualität, Dauer, Kosten
 *   2. Anschreiben-Entwurf: Dauer (Limit der Supabase Edge Function: 150 s) und Kosten
 *
 * Start:   node scout-spike.mjs             voller Lauf (3 Scout-Läufe + 1 Entwurf)
 *          node scout-spike.mjs --quick     nur 1 Scout-Lauf (Haiku) + 1 Entwurf
 *          node scout-spike.mjs --no-sonnet ohne den Sonnet-Scout
 *
 * Schlüssel: Datei .env (oder env.txt) im selben Ordner mit der Zeile
 *            ANTHROPIC_API_KEY=sk-ant-...
 * Der Schlüssel wird nie ausgegeben und nie in den Report geschrieben.
 * Keine Abhängigkeiten, braucht nur Node 18 oder neuer.
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ARGS = new Set(process.argv.slice(2));
const BASE = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
const MAX_USD = Number(process.env.SPIKE_MAX_USD || 4); // Notbremse für den ganzen Lauf
let API_VERSION = '2023-06-01';

const HAIKU = 'claude-haiku-5-5';
const SONNET = 'claude-sonnet-5-5';

// USD pro 1 Mio. Tokens, Stand 11.11.2026: platform.claude.com/docs/en/about-claude/pricing
const PRICES = {
  [HAIKU]: { in: 0.1, out: 0.5, cw: 0.125, cr: 0.01, long: { over: 100_000, in: 0.5, out: 2.5, cw: 0.625, cr: 0.05 } },
  [SONNET]: { in: 2, out: 10, cw: 2.5, cr: 0.1 },
  'claude-opus-5-5': { in: 4, out: 20, cw: 5, cr: 0.2 },
};
const SEARCH_USD = 0.01; // 10 $ pro 1.000 Suchen, Webseiten-Abruf kostet nur Tokens

const HEUTE = new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Erfundenes Testprofil (bewusst ein anderes Fach als bei Felix)
// ---------------------------------------------------------------------------
const PROFIL = {
  name: 'Lena Beispiel',
  abschluss: 'B.Sc. Wirtschaftsingenieurwesen Maschinenbau, TU Graz, Abschluss Februar 2027',
  erfahrung: [
    'Praktikum Qualitätsmanagement bei einem Automobilzulieferer, 6 Monate: 8D-Reports erstellt, Reklamationsquote in einem Projekt um 18 % gesenkt',
    'Werkstudentin Produktionsplanung, 12 Monate: SAP PP, Auswertungen in Excel und Power BI für die Fertigungssteuerung',
    'Formula-Student-Team der Uni, 2 Saisonen: Teilprojektleitung Fahrwerk mit 5 Personen',
  ],
  skills: 'SAP PP (Grundlagen), Power BI, Python (Grundlagen), SolidWorks, Lean, Six Sigma Yellow Belt',
  sprachen: 'Deutsch (Muttersprache), Englisch (C1)',
  zielrollen: 'Traineeprogramm oder Junior-Stelle in Qualitätsmanagement, Produktionsplanung, Operations oder Supply Chain; auch technische Beratung',
  orte: ['Graz', 'Linz', 'München'],
  start: 'ab März 2027',
  level: 'Berufseinstieg: Trainee, Graduate, Junior. Keine Stellen mit mehr als 2 Jahren verlangter Erfahrung.',
  ausschluesse: 'Werkstudentenstellen, unbezahlte Praktika, Zeitarbeit, reiner Außendienst',
  engagement: 'Formula-Student-Team (Teilprojektleitung Fahrwerk)',
  land: 'AT',
  zeitzone: 'Europe/Vienna',
};

function profilText(p) {
  return [
    `Name: ${p.name}`,
    `Abschluss: ${p.abschluss}`,
    `Erfahrung:\n${p.erfahrung.map((e) => `- ${e}`).join('\n')}`,
    `Fähigkeiten: ${p.skills}`,
    `Sprachen: ${p.sprachen}`,
    `Zielrollen: ${p.zielrollen}`,
    `Orte (Reihenfolge = Vorliebe): ${p.orte.join(', ')}`,
    `Start: ${p.start}`,
    `Level: ${p.level}`,
    `Ausschlüsse: ${p.ausschluesse}`,
    `Engagement neben dem Studium: ${p.engagement}`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Prompt-Vorlagen (lesen alles aus dem Profil, nichts ist auf eine Person zugeschnitten)
// ---------------------------------------------------------------------------
const N_TREFFER = 10;
const MAX_SUCHEN = 10;
const MAX_ABRUFE = 6;

const SCOUT_SUCHE = `Du bist der Stellen-Scout von „Jobbster“. Du suchst für eine Person aktuelle Einstiegsstellen, die zu ihrem Profil passen. Niemand beantwortet Rückfragen. Heute ist ${HEUTE}.

AUFTRAG
Finde bis zu ${N_TREFFER} aktuelle, konkrete Stellenanzeigen, die zum Profil passen. Die Menge ist eine Obergrenze: lieber 6 echte Treffer als 10 aufgefüllte.

REGELN
- Nur Orte aus dem Profil (die Reihenfolge ist die Vorliebe). Anzeigen ohne festen Ort („bundesweit“, nur ein Land) nicht aufnehmen.
- Nur Stellenarten und Level aus dem Profil. Die Ausschlüsse aus dem Profil gelten immer.
- Nur Anzeigen der letzten 30 Tage, frische zuerst. Start laut Profil oder flexibel.
- Der Link muss zur konkreten Anzeige führen (Karriereseite der Firma oder Jobbörse), nicht zu einer Ergebnisliste.
- Jede Firma höchstens einmal.
- Du loggst dich nirgends ein. Nur öffentlich sichtbare Anzeigen.
- Mischung: etwa die Hälfte bekannte Arbeitgeber oder strukturierte Programme, der Rest Stellen mit guter Chance (kleinere oder regionale Arbeitgeber, wenig Konkurrenz).

VORGEHEN (sparsam arbeiten)
- Höchstens ${MAX_SUCHEN} Suchen. Suche je Ort und Stellenart gezielt, zum Beispiel „Trainee Qualitätsmanagement Graz 2027“.
- Rufe eine Seite nur ab, wenn du prüfen musst, ob die Anzeige noch online ist, oder wenn wichtige Angaben fehlen. Höchstens ${MAX_ABRUFE} Abrufe.
- Erfinde nichts. Fehlt eine Angabe, schreibe „unbekannt“.

AUSGABE
Gib am Ende nur die Liste aus, ohne Einleitung und ohne Schlusswort. Pro Treffer genau dieser Block:
### <Firma> | <Titel>
Ort: …
Link: …
Quelle: … (zum Beispiel Karriereseite, StepStone, karriere.at)
Veröffentlicht: JJJJ-MM-TT oder unbekannt
Frist: JJJJ-MM-TT oder keine
Art: Trainee | Junior | Praktikum | Graduate | Sonstiges
Bewerbungsweg: Portal | E-Mail (<Adresse>) | LinkedIn | unbekannt
Sprache der Anzeige: de | en
Online geprüft: ja | nein
Inhalt: 2 Sätze
Anforderungen: 4 bis 8 Stichpunkte, mit Semikolon getrennt`;

const SCOUT_BEWERTUNG = `Du bewertest Stellen für eine Person ehrlich: wie gut die Stelle passt UND wie realistisch eine Einladung ist. Heute ist ${HEUTE}. Schreibe Deutsch und verwende keinen Gedankenstrich als Satzzeichen.

PUNKTE je Treffer
- rolle 0 bis 35: Wunschrolle laut Profil 26 bis 35, verwandte Rolle 18 bis 25, sonst darunter.
- lebenslauf 0 bis 20: Wert der Station im Lebenslauf. Bekannte Marke oder strukturiertes Programm 15 bis 20, solider Arbeitgeber 8 bis 14, sonst darunter.
- chance 0 bis 35: Wie wahrscheinlich ist eine Einladung? Plus: Einsteiger ausdrücklich gesucht, Muss-Anforderungen erfüllt, Anzeige höchstens 4 Tage alt, kleiner oder regionaler Arbeitgeber, Bewerbung per E-Mail an eine Person. Minus: sehr begehrtes Programm mit vielen Bewerbern, Muss-Anforderungen fehlen, verlangte Sprache fehlt, Anzeige älter als 21 Tage, mehr Erfahrung verlangt als im Profil.
- ort 0 bis 10: erster Wunschort 10, zweiter 5, weitere 0.
- chance_stufe: hoch (chance ab 24), mittel (14 bis 23), niedrig (unter 14).

TEXTE
- why_fit: genau 2 Sätze. Satz 1: warum es passt und was es für den Lebenslauf bringt. Satz 2 beginnt mit „Chance: hoch.“, „Chance: mittel.“ oder „Chance: niedrig.“ und nennt den wichtigsten Grund, auch Lücken.
- keywords: 8 bis 12 wichtige Begriffe aus der Anzeige (Fähigkeiten, Tools, Branche, Sprachen), je mit matched true oder false gegen das Profil.
- summary: 2 bis 3 Sätze. requirements: Stichpunkte.

WAHRHEIT
Übernimm Fakten nur aus der Trefferliste. Unbekanntes bleibt eine leere Zeichenkette. Daten im Format JJJJ-MM-TT. Ein Treffer, der gegen Ort, Level oder Ausschlüsse des Profils verstößt, kommt nicht in leads, sondern mit kurzem Grund in abgelehnt.`;

const SCHREIBER_RECHERCHE = `Du recherchierst für eine Bewerbung. Heute ist ${HEUTE}. Finde 2 konkrete Anknüpfungspunkte, warum genau diese Firma zur Person passt: ein Produkt, eine Technologie, ein Projekt, ein Standort, eine aktuelle Nachricht oder ein Programm, das wirklich zu einem Fakt aus dem Profil passt. Höchstens 3 Suchen. Erfinde nichts. Antworte nur mit 2 Stichpunkten, je 1 bis 2 Sätze: der Fakt über die Firma, dann die Verbindung zum Profil.`;

const SCHREIBER = `Du schreibst Bewerbungsentwürfe für „Jobbster“. Die Person prüft den Entwurf und sendet selbst. Heute ist ${HEUTE}.

WAHRHEIT
Verwende ausschließlich Fakten aus dem Profil. Erfinde keine Erfahrungen, Abschlüsse, Noten, Zahlen, Projekte, Sprachkenntnisse oder persönlichen Bezüge zur Firma. Fehlt etwas, lass es weg.

SCHREIBREGELN
Sprache wie die Anzeige. Kein Gedankenstrich als Satzzeichen. Keine Floskeln wie „hiermit bewerbe ich mich“. Kein Lob ohne Inhalt („innovativer Marktführer“).

AUFBAU (ein Leitgedanke trägt den ganzen Text)
1. Wer ich bin: 1 Satz, konkret.
2. Warum genau diese Firma: 1 bis 2 Anknüpfungspunkte aus der Recherche, je mit echter Verbindung zu einem Fakt aus dem Profil. Kein Satz, der so auch bei einer anderen Firma stehen könnte.
3. Warum es passt: 2 bis 3 Anforderungen der Anzeige, je mit belegtem Ergebnis und Zahl aus dem Profil. Das ist der Großteil.
4. Engagement neben dem Studium: genau 1 Satz, nur wenn das Profil etwas nennt.
5. Schluss: Starttermin laut Profil und Gesprächswunsch, kurz und selbstbewusst.

TON nach Arbeitgebertyp
Beratung: strukturiert, Ergebnis zuerst. Trainee-Programm: Bezug auf Programm und Stationen. Tech: direkt, mit Zahlen. Mittelstand und Konzern: förmlich, verlässlich.

LÄNGEN
- email_subject: „Bewerbung als <Titel>: <Name>“
- email_body: höchstens 160 Wörter, mit Anrede, Hinweis auf den Lebenslauf im Anhang, Grußformel und Namen.
- cover_letter: 200 bis 260 Wörter und höchstens 1.800 Zeichen, mit Betreffzeile, Anrede, 3 bis 4 kurzen Absätzen, Grußformel und Namen. Reiner Text.
- cv_highlights: 4 bis 6 Stichpunkte, welche Stationen für diese Stelle nach oben gehören.
- leitgedanke: der eine Gedanke, der den Text trägt, in einem Satz.`;

// ---------------------------------------------------------------------------
// JSON-Schemas (alle Felder Pflicht, additionalProperties false: Vorgabe der API)
// ---------------------------------------------------------------------------
const str = { type: 'string' };
const int = { type: 'integer' };
const LEADS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['leads', 'abgelehnt'],
  properties: {
    leads: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'company', 'title', 'location', 'url', 'source', 'posted_at', 'deadline', 'kind', 'apply_channel', 'apply_email',
          'language', 'verified_online', 'summary', 'requirements', 'keywords', 'rolle', 'lebenslauf', 'chance', 'ort',
          'chance_stufe', 'why_fit',
        ],
        properties: {
          company: str, title: str, location: str, url: str, source: str, posted_at: str, deadline: str,
          kind: { type: 'string', enum: ['trainee', 'junior', 'praktikum', 'graduate', 'sonstiges'] },
          apply_channel: { type: 'string', enum: ['portal', 'email', 'linkedin', 'unbekannt'] },
          apply_email: str,
          language: { type: 'string', enum: ['de', 'en'] },
          verified_online: { type: 'boolean' },
          summary: str,
          requirements: { type: 'array', items: str },
          keywords: {
            type: 'array',
            items: { type: 'object', additionalProperties: false, required: ['term', 'matched'], properties: { term: str, matched: { type: 'boolean' } } },
          },
          rolle: int, lebenslauf: int, chance: int, ort: int,
          chance_stufe: { type: 'string', enum: ['hoch', 'mittel', 'niedrig'] },
          why_fit: str,
        },
      },
    },
    abgelehnt: {
      type: 'array',
      items: { type: 'object', additionalProperties: false, required: ['company', 'title', 'grund'], properties: { company: str, title: str, grund: str } },
    },
  },
};

const ENTWURF_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['leitgedanke', 'email_subject', 'email_body', 'cover_letter', 'cv_highlights'],
  properties: { leitgedanke: str, email_subject: str, email_body: str, cover_letter: str, cv_highlights: { type: 'array', items: str } },
};

// ---------------------------------------------------------------------------
// Werkzeug-Varianten der API
// ---------------------------------------------------------------------------
function werkzeuge(variante, { suchen = MAX_SUCHEN, abrufe = MAX_ABRUFE } = {}) {
  const ort = { type: 'approximate', country: PROFIL.land, timezone: PROFIL.zeitzone };
  const sets = {
    // dynamisches Filtern: Claude filtert Suchergebnisse per Code, bevor sie in den Kontext kommen
    filter: [['web_search_20260318', 'web_fetch_20260318'], ['web_search_20260209', 'web_fetch_20260209']],
    // einfache Suche: alle Ergebnisse landen im Kontext
    einfach: [['web_search_20250305', 'web_fetch_20250910']],
  }[variante];
  return sets.map(([s, f]) => {
    const t = [{ type: s, name: 'web_search', max_uses: suchen, user_location: ort }];
    if (abrufe > 0) t.push({ type: f, name: 'web_fetch', max_uses: abrufe, max_content_tokens: 5000 });
    return { name: `${s}${abrufe > 0 ? ' + ' + f : ''}`, tools: t };
  });
}

// ---------------------------------------------------------------------------
// Schlüssel laden (wird nie ausgegeben)
// ---------------------------------------------------------------------------
function ladeSchluessel() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY.trim();
  for (const name of ['.env', 'env.txt', '.env.txt', 'key.txt']) {
    const p = path.join(DIR, name);
    if (!fs.existsSync(p)) continue;
    const raw = fs.readFileSync(p, 'utf8').replace(/^﻿/, '');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?ANTHROPIC_API_KEY\s*=\s*["']?([^"'\s#]+)["']?/);
      if (m) return m[1];
    }
    if (/^sk-ant-[\w-]+$/.test(raw.trim())) return raw.trim();
  }
  return null;
}
const KEY = ladeSchluessel();

// ---------------------------------------------------------------------------
// HTTP ohne Abhängigkeiten
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function post(body) {
  const url = new URL('/v1/messages', BASE);
  const lib = url.protocol === 'http:' ? http : https;
  const data = Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = lib.request(
      url,
      {
        method: 'POST',
        timeout: 20 * 60 * 1000,
        headers: { 'content-type': 'application/json', 'content-length': data.length, 'x-api-key': KEY, 'anthropic-version': API_VERSION },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch { /* kein JSON */ }
          resolve({ status: res.statusCode, json, text, headers: res.headers });
        });
      },
    );
    req.on('socket', (s) => s.setKeepAlive(true, 30_000));
    req.on('timeout', () => req.destroy(new Error('Zeitüberschreitung nach 20 min')));
    req.on('error', reject);
    req.end(data);
  });
}

class ApiFehler extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function api(body) {
  let letzter = null;
  for (let versuch = 0; versuch < 4; versuch++) {
    let res;
    try {
      res = await post(body);
    } catch (e) {
      letzter = new ApiFehler(0, `Netzwerk: ${e.message}`);
      await sleep(5000 * (versuch + 1));
      continue;
    }
    if (res.status === 200 && res.json) return res.json;
    const msg = res.json?.error?.message || res.text.slice(0, 300);
    if (res.status === 400 && /anthropic-version/i.test(msg) && API_VERSION !== '2023-06-01') {
      API_VERSION = '2023-06-01';
      continue;
    }
    if ([408, 409, 429, 500, 502, 503, 504, 529].includes(res.status)) {
      const warte = Number(res.headers['retry-after']) || 10 * (versuch + 1);
      console.log(`    … API ${res.status}, neuer Versuch in ${warte} s`);
      letzter = new ApiFehler(res.status, msg);
      await sleep(Math.min(warte, 90) * 1000);
      continue;
    }
    throw new ApiFehler(res.status, msg);
  }
  throw letzter || new ApiFehler(0, 'unbekannter Fehler');
}

// ---------------------------------------------------------------------------
// Kosten
// ---------------------------------------------------------------------------
function kosten(model, u) {
  const p = PRICES[model];
  const i = u.input_tokens || 0;
  const o = u.output_tokens || 0;
  const cw = u.cache_creation_input_tokens || 0;
  const cr = u.cache_read_input_tokens || 0;
  const suchen = u.server_tool_use?.web_search_requests || 0;
  const rechne = (q) => (i * q.in + o * q.out + cw * q.cw + cr * q.cr) / 1e6 + suchen * SEARCH_USD;
  const low = rechne(p);
  // Haiku 5.5 kostet bei Prompts über 100.000 Tokens das Fünffache. Ob die Schwelle bei Such-Schleifen
  // pro Anfrage oder pro Teilschritt gilt, zeigt nur die Konsole: deshalb beide Werte.
  const high = p.long && i + cw + cr > p.long.over ? rechne(p.long) : low;
  return { low, high };
}

let AUSGEGEBEN = 0; // obere Schätzung für den ganzen Lauf

// ---------------------------------------------------------------------------
// Ein „Zug“: eine Anfrage inklusive Fortsetzungen nach pause_turn
// ---------------------------------------------------------------------------
async function zug({ model, system, user, tools, format, maxTokens = 16000 }) {
  const messages = [{ role: 'user', content: user }];
  const t0 = Date.now();
  const anfragen = [];
  const texte = [];
  const fehlerCodes = [];
  let pausiert = [];
  let stop = null;

  for (let runde = 0; runde < 10; runde++) {
    const body = { model, max_tokens: maxTokens, system, messages: pausiert.length ? [...messages, { role: 'assistant', content: pausiert }] : messages };
    if (tools?.length) body.tools = tools;
    if (format) body.output_config = { format: { type: 'json_schema', schema: format } };
    const t = Date.now();
    const res = await api(body);
    const u = res.usage || {};
    const k = kosten(model, u);
    AUSGEGEBEN += k.high;
    anfragen.push({ ms: Date.now() - t, stop: res.stop_reason, usage: u, kosten: k });
    for (const b of res.content || []) {
      if (b.type === 'text') texte.push(b.text);
      const c = b.content;
      if (c && !Array.isArray(c) && typeof c === 'object' && /_error$/.test(c.type || '')) fehlerCodes.push(`${b.type}: ${c.error_code}`);
    }
    stop = res.stop_reason;
    if (stop === 'pause_turn') {
      pausiert = [...pausiert, ...(res.content || [])];
      continue;
    }
    break;
  }

  const sum = (f) => anfragen.reduce((a, r) => a + (f(r) || 0), 0);
  return {
    text: texte.join(''),
    stop,
    ms: Date.now() - t0,
    anfragen: anfragen.length,
    laengsteAnfrageMs: Math.max(...anfragen.map((r) => r.ms)),
    tokensEin: sum((r) => (r.usage.input_tokens || 0) + (r.usage.cache_creation_input_tokens || 0) + (r.usage.cache_read_input_tokens || 0)),
    tokensAus: sum((r) => r.usage.output_tokens),
    suchen: sum((r) => r.usage.server_tool_use?.web_search_requests),
    abrufe: sum((r) => r.usage.server_tool_use?.web_fetch_requests),
    usdLow: sum((r) => r.kosten.low),
    usdHigh: sum((r) => r.kosten.high),
    fehlerCodes,
  };
}

function leseJson(text) {
  try { return JSON.parse(text); } catch { /* weiter */ }
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try { return JSON.parse(text.slice(a, b + 1)); } catch { /* weiter */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Links prüfen (vom eigenen Rechner aus, ohne API)
// ---------------------------------------------------------------------------
async function pruefeLink(url) {
  if (!/^https?:\/\//i.test(url || '')) return 'kein Link';
  if (BASE.startsWith('http://')) return 'nicht geprüft (Test)';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 9000);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', 'accept-language': 'de,en;q=0.8' },
    });
    return String(res.status);
  } catch (e) {
    return e.name === 'AbortError' ? 'Zeitüberschreitung' : 'nicht erreichbar';
  } finally {
    clearTimeout(timer);
  }
}

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Number.isFinite(n) ? n : 0));
const tageAlt = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(d || '') ? Math.round((Date.parse(HEUTE) - Date.parse(d)) / 86_400_000) : null);

// ---------------------------------------------------------------------------
// Scout: Suche (mit Werkzeugen) → Bewertung (strukturierte Ausgabe)
// ---------------------------------------------------------------------------
async function scout(model, variante) {
  const name = `Scout · ${model.replace('claude-', '')} · ${variante}`;
  console.log(`\n▶ ${name}`);
  const user = `PROFIL\n${profilText(PROFIL)}\n\nSuche jetzt und gib die Trefferliste aus.`;
  let suche = null;
  let werkzeugName = null;
  const hinweise = [];

  for (const set of werkzeuge(variante)) {
    try {
      suche = await zug({ model, system: SCOUT_SUCHE, user, tools: set.tools });
      werkzeugName = set.name;
      break;
    } catch (e) {
      if (e.status === 400) {
        hinweise.push(`${set.name}: abgelehnt (${e.message.slice(0, 160)})`);
        console.log(`    … ${set.name} wird von der API abgelehnt, nächste Variante`);
        continue;
      }
      throw e;
    }
  }
  if (!suche) return { name, model, variante, ok: false, hinweise, fehler: 'Keine Werkzeug-Variante wurde akzeptiert' };
  console.log(`    Suche: ${(suche.ms / 1000).toFixed(0)} s, ${suche.suchen} Suchen, ${suche.abrufe} Abrufe, ${suche.tokensEin.toLocaleString('de')} Tokens ein`);
  if (suche.stop !== 'end_turn') hinweise.push(`Suche endete mit stop_reason ${suche.stop}`);
  if (suche.fehlerCodes.length) hinweise.push(`Werkzeug-Fehler: ${[...new Set(suche.fehlerCodes)].join(', ')}`);

  const bewertung = await zug({
    model,
    system: SCOUT_BEWERTUNG,
    user: `PROFIL\n${profilText(PROFIL)}\n\nTREFFERLISTE\n${suche.text}`,
    format: LEADS_SCHEMA,
  });
  if (bewertung.stop !== 'end_turn') hinweise.push(`Bewertung endete mit stop_reason ${bewertung.stop}`);
  const daten = leseJson(bewertung.text) || { leads: [], abgelehnt: [] };
  if (!leseJson(bewertung.text)) hinweise.push('Bewertung lieferte kein lesbares JSON');

  const gesehen = new Set();
  const leads = [];
  for (const l of daten.leads || []) {
    const key = (l.company || '').toLowerCase().replace(/\b(gmbh|ag|se|kg|group|co)\b|[^a-z0-9äöüß]/g, '');
    if (!key || gesehen.has(key)) continue;
    gesehen.add(key);
    const match = clamp(l.rolle, 0, 35) + clamp(l.lebenslauf, 0, 20) + clamp(l.chance, 0, 35) + clamp(l.ort, 0, 10);
    leads.push({ ...l, match, alter_tage: tageAlt(l.posted_at) });
  }
  leads.sort((a, b) => b.match - a.match);
  const stati = await Promise.all(leads.map((l) => pruefeLink(l.url)));
  leads.forEach((l, i) => { l.link_status = stati[i]; });

  const r = {
    name, model, variante, ok: true, werkzeuge: werkzeugName, hinweise,
    sekunden: Math.round((suche.ms + bewertung.ms) / 1000),
    sekundenSuche: Math.round(suche.ms / 1000),
    laengsteAnfrageS: Math.round(Math.max(suche.laengsteAnfrageMs, bewertung.laengsteAnfrageMs) / 1000),
    anfragen: suche.anfragen + bewertung.anfragen,
    suchen: suche.suchen, abrufe: suche.abrufe,
    tokensEin: suche.tokensEin + bewertung.tokensEin, tokensAus: suche.tokensAus + bewertung.tokensAus,
    usdLow: suche.usdLow + bewertung.usdLow, usdHigh: suche.usdHigh + bewertung.usdHigh,
    treffer: leads.length,
    frisch: leads.filter((l) => l.alter_tage !== null && l.alter_tage <= 30).length,
    ohneDatum: leads.filter((l) => l.alter_tage === null).length,
    linksOk: leads.filter((l) => /^2\d\d$/.test(l.link_status)).length,
    linksTot: leads.filter((l) => /^(404|410)$/.test(l.link_status)).length,
    abgelehnt: daten.abgelehnt || [],
    leads,
    rohliste: suche.text,
  };
  console.log(`    ${r.treffer} Treffer in ${r.sekunden} s, ${usd(r.usdLow)}${r.usdHigh > r.usdLow ? ' bis ' + usd(r.usdHigh) : ''}`);
  return r;
}

// ---------------------------------------------------------------------------
// Schreiber: Recherche (Haiku, Websuche) → Entwurf (Sonnet, strukturierte Ausgabe)
// ---------------------------------------------------------------------------
async function entwurf(lead) {
  console.log(`\n▶ Entwurf · ${lead.company}: ${lead.title}`);
  const stelle = `STELLE\nFirma: ${lead.company}\nTitel: ${lead.title}\nOrt: ${lead.location}\nLink: ${lead.url}\nSprache der Anzeige: ${lead.language}\nInhalt: ${lead.summary}\nAnforderungen:\n${(lead.requirements || []).map((x) => `- ${x}`).join('\n')}`;
  const hinweise = [];
  let recherche = null;
  for (const set of werkzeuge('einfach', { suchen: 3, abrufe: 0 })) {
    try {
      recherche = await zug({ model: HAIKU, system: SCHREIBER_RECHERCHE, user: `PROFIL\n${profilText(PROFIL)}\n\n${stelle}`, tools: set.tools, maxTokens: 6000 });
      break;
    } catch (e) {
      hinweise.push(`Recherche fehlgeschlagen: ${e.message.slice(0, 160)}`);
    }
  }
  const text = await zug({
    model: SONNET,
    system: SCHREIBER,
    user: `PROFIL\n${profilText(PROFIL)}\n\n${stelle}\n\nRECHERCHE ZUR FIRMA\n${recherche?.text || 'keine'}`,
    format: ENTWURF_SCHEMA,
    maxTokens: 8000,
  });
  const e = leseJson(text.text);
  if (!e) hinweise.push('Entwurf lieferte kein lesbares JSON');
  const woerter = (s) => (s || '').trim().split(/\s+/).filter(Boolean).length;
  const r = {
    name: `Entwurf · ${lead.company}`, ok: Boolean(e), hinweise, lead: { company: lead.company, title: lead.title, url: lead.url },
    sekunden: Math.round(((recherche?.ms || 0) + text.ms) / 1000),
    sekundenRecherche: Math.round((recherche?.ms || 0) / 1000),
    sekundenSchreiben: Math.round(text.ms / 1000),
    suchen: recherche?.suchen || 0,
    tokensEin: (recherche?.tokensEin || 0) + text.tokensEin, tokensAus: (recherche?.tokensAus || 0) + text.tokensAus,
    usdLow: (recherche?.usdLow || 0) + text.usdLow, usdHigh: (recherche?.usdHigh || 0) + text.usdHigh,
    recherche: recherche?.text || '',
    entwurf: e,
    laengen: e ? { mailWoerter: woerter(e.email_body), briefWoerter: woerter(e.cover_letter), briefZeichen: (e.cover_letter || '').length, gedankenstriche: /[–—]/.test(`${e.email_body}${e.cover_letter}`) } : null,
  };
  console.log(`    ${r.sekunden} s (Recherche ${r.sekundenRecherche} s, Schreiben ${r.sekundenSchreiben} s), ${usd(r.usdLow)}`);
  return r;
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------
const usd = (n) => `${n.toFixed(n < 0.1 ? 3 : 2).replace('.', ',')} $`;
const spanne = (r) => (r.usdHigh > r.usdLow + 0.0005 ? `${usd(r.usdLow)} bis ${usd(r.usdHigh)}` : usd(r.usdLow));

function reportMd(scouts, brief, abbruch) {
  const ok = scouts.filter((s) => s.ok);
  const z = [];
  z.push(`# Jobbster · Spike-Report ${HEUTE}`, '');
  z.push(`Profil: erfunden (${PROFIL.name}, ${PROFIL.orte.join(', ')}). Obere Kostenschätzung für den ganzen Lauf: ${usd(AUSGEGEBEN)}. Maßgeblich ist die Abrechnung in der Claude Console.`, '');
  if (abbruch) z.push(`**Abbruch:** ${abbruch}`, '');

  z.push('## Läufe', '');
  z.push('| Lauf | Dauer | Längste Anfrage | Suchen | Abrufe | Tokens ein | Tokens aus | Kosten | Treffer | davon ≤ 30 Tage | Links 2xx | Links tot |');
  z.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const s of ok) {
    z.push(`| ${s.name} | ${s.sekunden} s | ${s.laengsteAnfrageS} s | ${s.suchen} | ${s.abrufe} | ${s.tokensEin.toLocaleString('de')} | ${s.tokensAus.toLocaleString('de')} | ${spanne(s)} | ${s.treffer} | ${s.frisch} (${s.ohneDatum} ohne Datum) | ${s.linksOk} | ${s.linksTot} |`);
  }
  if (brief) z.push(`| ${brief.name} | ${brief.sekunden} s | ${brief.sekundenSchreiben} s | ${brief.suchen} | 0 | ${brief.tokensEin.toLocaleString('de')} | ${brief.tokensAus.toLocaleString('de')} | ${spanne(brief)} | | | | |`);
  z.push('');
  for (const s of scouts.filter((x) => !x.ok)) z.push(`- **${s.name}: fehlgeschlagen.** ${s.fehler}`);
  for (const s of [...scouts, ...(brief ? [brief] : [])]) for (const h of s.hinweise || []) z.push(`- Hinweis (${s.name}): ${h}`);
  z.push('');

  z.push('## Annahmen aus PLAN.md 4.3', '');
  if (ok.length) {
    const guenstig = [...ok].sort((a, b) => a.usdHigh - b.usdHigh)[0];
    const laengster = Math.max(...ok.map((s) => s.sekunden));
    z.push(`1. **Websuche liefert brauchbare, aktuelle Stellen:** siehe Trefferlisten unten, bitte selbst ansehen. Bester Lauf: ${Math.max(...ok.map((s) => s.treffer))} Treffer.`);
    z.push(`2. **Scout unter 10 Minuten:** ${laengster <= 600 ? 'ja' : 'NEIN'} (längster Lauf ${laengster} s).`);
    const minuten = Math.ceil((guenstig.sekunden + 45) / 60); // + Start des Runners
    z.push(`3. **GitHub Actions:** ca. ${minuten} min pro Scout-Lauf inklusive Start. 10 Nutzer × 13 Läufe in 30 Tagen = ${minuten * 130} min von 2.000 Freiminuten (privates Repo).`);
    if (brief) z.push(`4. **Schreiber unter 150 s (Edge Function):** ${brief.sekunden <= 150 ? 'ja' : 'NEIN'} (${brief.sekunden} s gesamt, davon Schreiben ${brief.sekundenSchreiben} s).`);
    z.push('');
    z.push('## Hochrechnung pro Nutzer und 30 Tage (Beta-Grenzen)', '');
    const scoutMonat = guenstig.usdHigh * 13;
    const briefMonat = brief ? brief.usdHigh * 30 : 0;
    z.push(`- 13 Scout-Läufe (3 pro Woche) mit „${guenstig.name}“: ${usd(scoutMonat)}`);
    if (brief) z.push(`- 30 Entwürfe (Annahme, Grenze wäre 90): ${usd(briefMonat)}`);
    z.push(`- Summe ohne Gesprächsvorbereitung: **${usd(scoutMonat + briefMonat)}**. Preisregel (mindestens das Dreifache): ab ${usd((scoutMonat + briefMonat) * 3)}.`);
    z.push('');
  }

  for (const s of ok) {
    z.push(`## Treffer: ${s.name}`, '', `Werkzeuge: ${s.werkzeuge}`, '');
    for (const l of s.leads) {
      z.push(`- **${l.match}** · Chance ${l.chance_stufe} · ${l.company}: ${l.title} (${l.location}) · ${l.posted_at || 'ohne Datum'} · Link ${l.link_status}`);
      z.push(`  ${l.url}`);
      z.push(`  ${l.why_fit}`);
    }
    if (s.abgelehnt.length) z.push('', `Abgelehnt: ${s.abgelehnt.map((a) => `${a.company} (${a.grund})`).join('; ')}`);
    z.push('');
  }

  if (brief?.entwurf) {
    const e = brief.entwurf;
    const L = brief.laengen;
    z.push(`## Entwurf: ${brief.lead.company}, ${brief.lead.title}`, '');
    z.push(`Längen: Mail ${L.mailWoerter} Wörter (Ziel ≤ 160), Anschreiben ${L.briefWoerter} Wörter und ${L.briefZeichen} Zeichen (Ziel 200 bis 260, ≤ 1.800). Gedankenstriche: ${L.gedankenstriche ? 'JA' : 'keine'}.`, '');
    z.push(`**Leitgedanke:** ${e.leitgedanke}`, '', '**Recherche:**', '', brief.recherche, '', `**Betreff:** ${e.email_subject}`, '', '**Mail:**', '', e.email_body, '', '**Anschreiben:**', '', e.cover_letter, '', '**Lebenslauf-Hinweise:**', '', ...e.cv_highlights.map((x) => `- ${x}`), '');
  }
  return z.join('\n');
}

// ---------------------------------------------------------------------------
// Ablauf
// ---------------------------------------------------------------------------
async function main() {
  if (!KEY) {
    console.log('Kein Schlüssel gefunden. Lege im selben Ordner eine Datei .env (oder env.txt) an mit der Zeile:\nANTHROPIC_API_KEY=sk-ant-...');
    process.exit(1);
  }
  console.log(`Jobbster · Spike ${HEUTE} · Notbremse bei ${usd(MAX_USD)}`);
  const scouts = [];
  let brief = null;
  let abbruch = null;
  const frei = () => AUSGEGEBEN < MAX_USD;
  const sichere = () => {
    fs.writeFileSync(path.join(DIR, 'spike-report.json'), JSON.stringify({ datum: HEUTE, obereSchaetzungUsd: AUSGEGEBEN, abbruch, scouts, brief }, null, 2));
    fs.writeFileSync(path.join(DIR, 'spike-report.md'), reportMd(scouts, brief, abbruch));
  };

  try {
    // 1. Haiku mit dynamischem Filtern
    scouts.push(await scout(HAIKU, 'filter'));
    sichere();
    if (!ARGS.has('--quick')) {
      // 2. Haiku mit einfacher Suche (Vergleich)
      if (frei()) { scouts.push(await scout(HAIKU, 'einfach')); sichere(); }
      // 3. Sonnet mit der Variante, die bei Haiku pro Treffer günstiger war
      if (!ARGS.has('--no-sonnet') && frei()) {
        const ok = scouts.filter((s) => s.ok && s.treffer > 0);
        const beste = ok.sort((a, b) => a.usdHigh / a.treffer - b.usdHigh / b.treffer)[0]?.variante || 'einfach';
        scouts.push(await scout(SONNET, beste));
        sichere();
      }
    } else if (!scouts[0].ok || scouts[0].treffer === 0) {
      scouts.push(await scout(HAIKU, 'einfach'));
      sichere();
    }
    // 4. Ein Entwurf für den besten Treffer
    const alle = scouts.filter((s) => s.ok).flatMap((s) => s.leads).sort((a, b) => b.match - a.match);
    if (alle.length && frei()) brief = await entwurf(alle[0]);
    if (!frei()) abbruch = `Notbremse: obere Kostenschätzung ${usd(AUSGEGEBEN)} hat ${usd(MAX_USD)} erreicht.`;
  } catch (e) {
    abbruch = `Fehler: ${e.status ? `API ${e.status}: ` : ''}${String(e.message).slice(0, 400)}`;
    console.log(`\n✖ ${abbruch}`);
  }
  sichere();

  console.log('\n──────── Ergebnis ────────');
  for (const s of scouts) {
    console.log(s.ok ? `${s.name}: ${s.treffer} Treffer, ${s.sekunden} s, ${spanne(s)}, ${s.suchen} Suchen, Links ok ${s.linksOk}/${s.treffer}` : `${s.name}: fehlgeschlagen (${s.fehler})`);
  }
  if (brief) console.log(`${brief.name}: ${brief.sekunden} s, ${spanne(brief)}`);
  console.log(`Obere Kostenschätzung gesamt: ${usd(AUSGEGEBEN)}`);
  console.log('Report: spike-report.md und spike-report.json (im selben Ordner)');
  if (abbruch) process.exitCode = 2;
}

main();
