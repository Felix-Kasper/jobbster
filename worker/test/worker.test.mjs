// Jobbster · Test des Workers gegen eine Attrappe (Claude API + Datenbank). Nur erfundene Daten.
// Start: node worker/test/worker.test.mjs
import http from 'node:http';
import assert from 'node:assert/strict';
import { main } from '../worker.mjs';
import { traumjobFelder } from '../lib/traumjob.mjs';
import { profilText } from '../lib/prompts.mjs';
import { schluesselOk, verdecke } from '../lib/claude.mjs';

const A = 'aaaaaaaa-0000-4000-8000-000000000001'; // Mitglied mit Profil
const B = 'bbbbbbbb-0000-4000-8000-000000000002'; // kein Mitglied
const LEAD = '11111111-0000-4000-8000-000000000001';
const LEAD2 = '22222222-0000-4000-8000-000000000002';
const frueher = (min) => new Date(Date.now() - min * 60_000).toISOString();

function frisch() {
  return {
    app_config: [
      { key: 'pausiert', value: false },
      { key: 'tageslimit_usd', value: 3 },
      { key: 'grenzen', value: { scout: { anzahl: 2, tage: 1 }, entwurf: { anzahl: 12, tage: 1 }, vorbereitung: { anzahl: 2, tage: 7 } } },
    ],
    members: [{ user_id: A, status: 'aktiv' }],
    job_profile: [{ user_id: A, full_name: 'Lena Beispiel', cv_text: 'Erfundener Lebenslauf. '.repeat(20), onboarded_at: frueher(60), languages: 'Deutsch', preferences: { zielrollen: 'Trainee Qualität', orte: ['Graz', 'Linz'], start: 'ab März 2027', pro_tag: 12 } }],
    job_leads: [
      { id: LEAD, user_id: A, dedup_key: 'stelle|altfirma gmbh|junior|graz', company: 'Altfirma GmbH', title: 'Junior Qualität', location: 'Graz', url: 'https://example.com/a', status: 'neu', language: 'de', summary: 'Kurz.', requirements: '- SAP', created_at: frueher(500) },
      { id: LEAD2, user_id: A, dedup_key: 'stelle|gespraech ag|trainee|linz', company: 'Gespräch AG', title: 'Trainee', location: 'Linz', url: 'https://example.com/b', status: 'interview', language: 'de', cover_letter_md: 'Mein Anschreiben.', interview1_input: { mail: 'Einladung am 20.11. um 10 Uhr per Teams mit Frau Muster (HR).' }, prep_requested_at: frueher(5), created_at: frueher(400) },
    ],
    queue: [
      { id: 'q1', user_id: A, kind: 'scout', lead_id: null, stage: null, status: 'wartet', created_at: frueher(9) },
      { id: 'q2', user_id: A, kind: 'entwurf', lead_id: LEAD, stage: null, status: 'wartet', created_at: frueher(8) },
      { id: 'q3', user_id: A, kind: 'vorbereitung', lead_id: LEAD2, stage: 'interview1', status: 'wartet', created_at: frueher(7) },
      { id: 'q4', user_id: B, kind: 'scout', lead_id: null, stage: null, status: 'wartet', created_at: frueher(6) },
      { id: 'q5', user_id: A, kind: 'scout', lead_id: null, stage: null, status: 'laeuft', started_at: frueher(90), created_at: frueher(95) },
    ],
    runs: [],
  };
}
let DB = frisch();
const apiLog = [];

// --- sehr kleine PostgREST-Nachbildung -------------------------------------
function filter(rows, params) {
  let r = rows;
  for (const [k, v] of params) {
    if (['select', 'order', 'limit', 'on_conflict'].includes(k)) continue;
    const [op, ...rest] = v.split('.');
    const wert = rest.join('.');
    r = r.filter((row) => {
      const x = row[k];
      if (op === 'eq') return String(x) === wert;
      if (op === 'neq') return String(x) !== wert;
      if (op === 'lt') return x != null && String(x) < wert;
      if (op === 'gte') return x != null && String(x) >= wert;
      if (op === 'not' && wert === 'is.null') return x != null;
      throw new Error(`Filter nicht nachgebildet: ${k}=${v}`);
    });
  }
  const order = params.get('order');
  if (order) {
    const [feld, richtung] = order.split('.');
    r = [...r].sort((a, b) => String(a[feld]).localeCompare(String(b[feld])) * (richtung === 'desc' ? -1 : 1));
  }
  const limit = params.get('limit');
  return limit ? r.slice(0, Number(limit)) : r;
}
const firmaKey = (s) => String(s).toLowerCase().replace(/\b(gmbh|ag)\b|[^a-z0-9äöüß]/g, '');

function rest(req, res, url, body) {
  const tabelle = url.pathname.replace('/rest/v1/', '');
  const rows = DB[tabelle];
  if (!rows) return send(res, 404, { message: `Tabelle ${tabelle} fehlt` });
  if (req.headers.apikey !== 'dienst-schluessel') return send(res, 401, { message: 'Schlüssel fehlt' });
  const prefer = req.headers.prefer || '';
  if (req.method === 'GET') return send(res, 200, filter(rows, url.searchParams));
  if (req.method === 'POST') {
    const neu = [];
    for (const row of Array.isArray(body) ? body : [body]) {
      if (tabelle === 'job_leads' && rows.some((x) => x.user_id === row.user_id && (x.dedup_key === row.dedup_key || firmaKey(x.company) === firmaKey(row.company)))) continue;
      const voll = { id: `${tabelle}-${rows.length + 1}`, created_at: new Date().toISOString(), status: tabelle === 'queue' ? 'wartet' : tabelle === 'job_leads' ? 'neu' : undefined, ...row };
      rows.push(voll);
      neu.push(voll);
    }
    return prefer.includes('return=representation') ? send(res, 201, neu) : send(res, 201, null);
  }
  if (req.method === 'PATCH') {
    const treffer = filter(rows, url.searchParams);
    for (const row of treffer) Object.assign(row, body);
    return prefer.includes('return=representation') ? send(res, 200, treffer) : send(res, 204, null);
  }
  return send(res, 405, { message: 'Methode' });
}

// --- Claude-Attrappe ---------------------------------------------------------
const liste = `### Neuwerk GmbH | Trainee Qualitätsmanagement
Ort: Graz
Link: https://example.com/jobs/1
Quelle: Karriereseite
Veröffentlicht: 2026-11-08
Frist: keine
Art: Trainee
Bewerbungsweg: Portal
Sprache der Anzeige: de
Online geprüft: ja
Gehalt: unbekannt
Inhalt: Trainee im QM. 18 Monate.
Anforderungen: Studium; SAP`;
const leadJson = (company, title, url, extra = {}) => ({
  company, title, location: 'Graz', url, source: 'Karriereseite', posted_at: '2026-11-08', deadline: 'keine', salary: 'unbekannt', kind: 'trainee',
  apply_channel: 'unbekannt', apply_email: '', language: 'de', verified_online: false, summary: 'Trainee im QM – 18 Monate.', requirements: ['Studium', 'SAP'],
  keywords: [{ term: 'SAP', matched: true }], rolle: 30, lebenslauf: 14, chance: 99, ort: 10, chance_stufe: 'hoch', why_fit: 'Passt. Chance: hoch. Grund.', pre_info: '', ...extra,
});

function claude(req, res, body) {
  const tools = (body.tools || []).map((t) => t.type);
  const hatAssistant = body.messages.some((m) => m.role === 'assistant');
  apiLog.push({ model: body.model, tools, format: Boolean(body.output_config), system: body.system.slice(0, 30), bisZu: /Finde bis zu (\d+) aktuelle/.exec(body.system)?.[1] });
  if (!req.headers['x-api-key']) return send(res, 401, { error: { message: 'x-api-key fehlt' } });
  if (tools.includes('web_search_20260318')) return send(res, 400, { error: { message: 'web_search_20260318 requires allowed_callers' } });
  const ok = (text, usage) => send(res, 200, { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage });

  if (body.output_config) {
    const pflicht = body.output_config.format.schema.required;
    if (pflicht.includes('leads')) {
      return ok(JSON.stringify({
        leads: [
          leadJson('Neuwerk GmbH', 'Trainee Qualitätsmanagement', 'https://example.com/jobs/1'),
          leadJson('Altfirma AG', 'Schon bekannt', 'https://example.com/jobs/2'),
          leadJson('Ohne Link KG', 'Trainee', 'unbekannt'),
          leadJson('Zweitwerk AG', 'Junior Planung', 'https://example.com/jobs/3', { apply_channel: 'email', apply_email: 'jobs@example.com', rolle: 20, chance: 10 }),
        ],
        abgelehnt: [{ company: 'Fern GmbH', title: 'Trainee', grund: 'Ort Wien' }],
      }), { input_tokens: 3000, output_tokens: 1500 });
    }
    if (pflicht.includes('cover_letter')) {
      return ok(JSON.stringify({ leitgedanke: 'Qualität messbar machen.', email_subject: 'Bewerbung als Junior Qualität: Lena Beispiel', email_body: 'Sehr geehrte Damen und Herren, kurz – und knapp.', cover_letter: `Betreff\n\n${'Ein langer Satz – mit Strich. '.repeat(80)}`, cv_highlights: ['QM-Praktikum'], pre_info: 'Zeugnisse hochladen.' }), { input_tokens: 4000, output_tokens: 900 });
    }
    if (pflicht.includes('must_say')) {
      return ok(JSON.stringify({ headline: 'Zeig Qualität mit Zahlen', format: 'Video (Teams), 45 min', people: [{ name: 'Frau Muster', role: 'HR', about: 'Recruiting.', link: 'kein Link' }], company: ['Baut Teile'], process: ['45 min'], they_want: ['Einsteiger'], must_say: ['18 % weniger Reklamationen'], questions: [{ q: 'Warum wir?', a: 'Weil – es passt.' }], ask_back: ['Wie sieht Woche 1 aus?'], watch_out: ['Teams testen'], salary: 'egal in Runde 1', sources: [{ title: 'Firma', url: 'https://example.com' }, { title: 'kaputt', url: 'nichts' }] }), { input_tokens: 6000, output_tokens: 2000 });
    }
  }
  if (body.system.startsWith('Kürze das Anschreiben')) return ok(`Betreff\n\n${'Kurzer Satz. '.repeat(60)}`, { input_tokens: 900, output_tokens: 400 });
  if (tools.length && !hatAssistant) {
    return send(res, 200, {
      role: 'assistant', stop_reason: 'pause_turn',
      content: [{ type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'x' } }, { type: 'web_search_tool_result', tool_use_id: 's1', content: [{ type: 'web_search_result', url: 'https://example.com/jobs/1', title: 'T', encrypted_content: 'abc' }] }],
      usage: { input_tokens: 50000, output_tokens: 500, server_tool_use: { web_search_requests: 4, web_fetch_requests: 1 } },
    });
  }
  if (tools.length) return ok(body.system.includes('Stellen-Scout') ? liste : '- Fakt eins.\n- Fakt zwei.', { input_tokens: 20000, output_tokens: 800, server_tool_use: { web_search_requests: 2 } });
  return ok('ok', { input_tokens: 10, output_tokens: 5 });
}

function send(res, status, json) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(json === null ? '' : JSON.stringify(json));
}

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    const body = raw ? JSON.parse(raw) : undefined;
    try {
      if (url.pathname === '/v1/messages') return claude(req, res, body);
      return rest(req, res, url, body);
    } catch (e) {
      return send(res, 500, { message: e.message });
    }
  });
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const env = { SUPABASE_URL: base, SUPABASE_SERVICE_KEY: 'dienst-schluessel', ANTHROPIC_API_KEY: 'sk-ant-test', ANTHROPIC_BASE_URL: base, WORKER_WARTEN_MAX_S: '1' };
const still = console.log;
const ausgabe = [];
console.log = (...a) => ausgabe.push(a.join(' '));
let bestanden = 0;
const pruefe = (name, fn) => { fn(); bestanden++; still(`  ok  ${name}`); };

try {
  // 1. Normaler Lauf
  const code = await main(env, []);
  const q = Object.fromEntries(DB.queue.map((x) => [x.id, x]));
  pruefe('Lauf endet mit Code 2, weil ein Auftrag fehlschlug', () => assert.equal(code, 2));
  pruefe('Scout, Entwurf und Vorbereitung sind fertig', () => assert.deepEqual([q.q1.status, q.q2.status, q.q3.status], ['fertig', 'fertig', 'fertig']));
  pruefe('Auftrag eines Nicht-Mitglieds schlägt fehl, ohne API-Kosten', () => { assert.equal(q.q4.status, 'fehler'); assert.match(q.q4.error, /Zugang/); assert.equal(DB.runs.find((r) => r.queue_id === 'q4').cost_usd, 0); });
  pruefe('Hängengebliebener Auftrag wird als Fehler freigegeben', () => assert.equal(q.q5.status, 'fehler'));
  const neu = DB.job_leads.filter((l) => !['11111111-0000-4000-8000-000000000001', '22222222-0000-4000-8000-000000000002'].includes(l.id));
  pruefe('Scout speichert 2 neue Treffer: bekannte Firma und Treffer ohne Link fallen raus', () => assert.deepEqual(neu.map((l) => l.company), ['Neuwerk GmbH', 'Zweitwerk AG']));
  pruefe('Match wird im Code gerechnet und gedeckelt (30 + 14 + 35 + 10)', () => assert.equal(neu[0].match_score, 89));
  pruefe('Treffer gehören dem Nutzer und haben saubere Felder', () => {
    assert.equal(neu[0].user_id, A);
    assert.equal(neu[0].deadline, null);
    assert.equal(neu[0].salary, null);
    assert.equal(neu[0].apply_channel, 'portal');
    assert.equal(neu[1].apply_channel, 'email');
    assert.match(neu[0].pre_info, /nicht geprüft/);
    assert.ok(!/[–—]/.test(neu[0].summary));
  });
  const entwurfLead = DB.job_leads.find((l) => l.id === LEAD);
  pruefe('Entwurf: Status entwurf, Anschreiben gekürzt, kein Gedankenstrich', () => {
    assert.equal(entwurfLead.status, 'entwurf');
    assert.ok(entwurfLead.cover_letter_md.length <= 1800, `Länge ${entwurfLead.cover_letter_md.length}`);
    assert.ok(!/[–—]/.test(entwurfLead.email_body + entwurfLead.cover_letter_md));
    assert.ok(entwurfLead.drafted_at);
  });
  const prepLead = DB.job_leads.find((l) => l.id === LEAD2);
  pruefe('Vorbereitung: gespeichert, Anforderung zurückgesetzt, Status bleibt interview', () => {
    assert.equal(prepLead.status, 'interview');
    assert.equal(prepLead.prep_requested_at, null);
    assert.deepEqual(prepLead.interview1_prep.must_say, ['18 % weniger Reklamationen']);
    assert.equal(prepLead.interview1_prep.salary, null);
    assert.equal(prepLead.interview1_prep.people[0].link, '');
    assert.equal(prepLead.interview1_prep.sources.length, 1);
    assert.ok(!/[–—]/.test(JSON.stringify(prepLead.interview1_prep)));
  });
  const okRuns = DB.runs.filter((r) => r.status === 'ok');
  pruefe('Kosten-Protokoll: 3 Läufe ok mit Kosten, Suchen und Dauer', () => {
    assert.equal(okRuns.length, 3);
    assert.ok(okRuns.every((r) => r.cost_usd > 0 && r.requests >= 2 && r.duration_ms >= 0));
    assert.deepEqual(okRuns.map((r) => r.agent), ['scout', 'writer', 'coach']);
    assert.equal(okRuns[0].searches, 6);
    assert.equal(okRuns[0].result_count, 2);
  });
  pruefe('Suche richtet sich nach „Bewerbungen pro Tag“ im Profil', () => assert.ok(apiLog.some((x) => x.bisZu === '12')));
  pruefe('Scout läuft auf Haiku, Texte auf Sonnet', () => {
    assert.ok(apiLog.filter((x) => x.system.startsWith('Du bist der Stellen-Scout')).every((x) => x.model === 'claude-haiku-5-5'));
    assert.ok(apiLog.filter((x) => x.system.startsWith('Du schreibst Bewerbung')).every((x) => x.model === 'claude-sonnet-5-5'));
  });
  pruefe('Abgelehnter Werkzeug-Satz führt zum nächsten statt zum Abbruch', () => assert.ok(apiLog.some((x) => x.tools.includes('web_search_20260318')) && apiLog.some((x) => x.tools.includes('web_search_20260209'))));
  pruefe('Protokoll enthält weder Namen noch Lebenslauf', () => assert.ok(!ausgabe.join('\n').includes('Lena') && !ausgabe.join('\n').includes('Erfundener Lebenslauf')));

  // 2. Tageslimit
  DB = frisch();
  DB.runs.push({ cost_usd: 3.2, created_at: new Date().toISOString() });
  const code2 = await main(env, []);
  pruefe('Tageslimit erreicht: Code 3, nichts wird bearbeitet', () => { assert.equal(code2, 3); assert.equal(DB.queue.find((x) => x.id === 'q1').status, 'wartet'); });

  // 3. Not-Aus
  DB = frisch();
  DB.app_config[0].value = true;
  const code3 = await main(env, []);
  pruefe('Not-Aus: Code 0, nichts wird bearbeitet', () => { assert.equal(code3, 0); assert.equal(DB.queue.find((x) => x.id === 'q1').status, 'wartet'); });

  // 4. Zeitplan
  DB = frisch();
  DB.queue = [];
  DB.members.push({ user_id: B, status: 'aktiv' }); // Mitglied ohne Profil: wird übersprungen
  await main(env, ['--plan']);
  pruefe('Zeitplan reiht genau einen Scout-Lauf ein und arbeitet ihn ab', () => { assert.equal(DB.queue.length, 1); assert.equal(DB.queue[0].user_id, A); assert.equal(DB.queue[0].status, 'fertig'); });
  DB.queue = [1, 2, 3].map((i) => ({ id: `alt${i}`, user_id: A, kind: 'scout', status: 'fertig', created_at: frueher(60 * i) }));
  await main(env, ['--plan']);
  pruefe('Zeitplan sucht höchstens einmal in 12 Stunden', () => assert.equal(DB.queue.length, 3));
  DB.queue = [{ id: 'gestern', user_id: A, kind: 'scout', status: 'fertig', created_at: frueher(60 * 13) }];
  await main(env, ['--plan']);
  pruefe('Zeitplan sucht jeden Tag neu', () => assert.equal(DB.queue.filter((q) => q.kind === 'scout').length, 2));

  // 5. Laufzeit und Probe
  DB = frisch();
  DB.queue = [];
  DB.members[0].valid_until = frueher(60);
  await main(env, ['--plan']);
  pruefe('Zeitplan überspringt abgelaufene Zugänge', () => assert.equal(DB.queue.length, 0));
  DB.members[0].valid_until = new Date(Date.now() + 86_400_000).toISOString();
  DB.members[0].limits = { scout: { anzahl: 1, tage: 7 }, entwurf: { anzahl: 1, tage: 7 }, vorbereitung: { anzahl: 0, tage: 7 } };
  await main(env, ['--plan']);
  await main(env, ['--plan']);
  pruefe('Probe-Zugang bekommt genau einen Suchlauf in 7 Tagen', () => assert.equal(DB.queue.length, 1));

  // 6. Schlüssel nie in Fehlermeldungen
  pruefe('Schlüssel und Kopfzeilen werden in Fehlern verdeckt', () => {
    assert.equal(verdecke('Invalid header value: "Schlüssel: \nsk-ant-abc_DEF-123"'), 'Invalid header value: (verdeckt)');
    assert.equal(verdecke('kaputt sk-ant-api03-abcdefghijklmnop rest'), 'kaputt sk-ant-*** rest');
    assert.ok(schluesselOk('sk-ant-api03-' + 'a'.repeat(40)));
    assert.ok(!schluesselOk('Schlüssel: sk-ant-api03-' + 'a'.repeat(40)));
    assert.ok(!schluesselOk('sk-ant-api03-' + 'a'.repeat(40) + '\n'));
  });

  // 7. Perfekter Job: fließt in jedes Profil ein und füllt die Suchfelder
  pruefe('Perfekter Job steht im Profil für die KI', () => assert.match(profilText({ preferences: { traumjob: 'Qualität in der Fertigung, Graz' }, cv_text: 'x' }), /Perfekter Job in eigenen Worten.*Qualität in der Fertigung, Graz/));
  let gesehen = null;
  const attrappe = { zug: async (o) => { gesehen = o; return { text: JSON.stringify({ zielrollen: 'Trainee Qualität – Industrie', stellenarten: ['Trainee', 'Vollzeit'], orte: ['Graz', ' '], start: '', ausschluesse: 'Außendienst', wuensche: 'Unbekannt' }), model: 'claude-haiku-5-5', anfragen: 1, tokensEin: 100, tokensAus: 50, usd: 0.0004 }; } };
  const v = await traumjobFelder({ claude: attrappe, text: 'Ich will als Trainee in die Qualität eines Industriebetriebs in Graz, kein Außendienst.' });
  pruefe('Vorschlag aus dem perfekten Job: nur erlaubte Werte, nichts erfunden, ohne Gedankenstrich', () => {
    assert.equal(gesehen.model, 'claude-haiku-5-5');
    assert.ok(gesehen.format, 'mit Schema');
    assert.deepEqual(v.felder.stellenarten, ['Trainee']);
    assert.deepEqual(v.felder.orte, ['Graz']);
    assert.equal(v.felder.zielrollen, 'Trainee Qualität, Industrie');
    assert.equal(v.felder.wuensche, '');
  });
  await assert.rejects(() => traumjobFelder({ claude: attrappe, text: 'zu kurz' }));

  still(`\n${bestanden} Prüfungen bestanden.`);
} catch (e) {
  still(`\nFEHLGESCHLAGEN: ${e.message}\n--- Protokoll des Workers ---\n${ausgabe.join('\n')}`);
  process.exitCode = 1;
} finally {
  console.log = still;
  server.close();
}
