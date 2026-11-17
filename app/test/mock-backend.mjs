// Jobbster · Nachgebildetes Backend für Ende-zu-Ende-Tests (Auth, REST, RPC, Funktionen, Speicher).
// Bildet nur das nach, was die App nutzt, mit erfundenen Daten. Liefert außerdem den Build (dist) aus.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function createMock({ dist }) {
  const db = {
    users: [], // { id, email, password }
    tokens: new Map(), // token -> user id
    members: [], job_profile: [], job_leads: [], queue: [], consents: [], feedback: [], runs: [],
    waitlist: [{ id: 'w-1', email: 'neu@beispiel.at', note: 'Suche Trainee in Graz', source: 'landing', created_at: '2026-11-17T10:00:00Z', invited_at: null, hat_konto: false }],
    invites: [{ code: 'ZS-TEST-0000-0000-0001', days: 30, plan: 'beta', used: 0, max: 5 }, { code: 'ZS-PASS-0000-0000-0002', days: 30, plan: 'pass', used: 0, max: 5 }],
    admins: new Set(),
    files: new Map(),
    log: [],
  };
  const now = () => new Date().toISOString();

  function send(res, status, body, headers = {}) {
    res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*', 'access-control-expose-headers': '*', ...headers });
    res.end(body === null || body === undefined ? '' : typeof body === 'string' ? body : JSON.stringify(body));
  }
  function userOf(req) {
    const t = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    return db.tokens.get(t) ?? null;
  }
  function session(u) {
    const t = `tok-${randomUUID()}`;
    db.tokens.set(t, u.id);
    return { access_token: t, token_type: 'bearer', expires_in: 3600, expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_token: `ref-${randomUUID()}`, user: authUser(u) };
  }
  const authUser = (u) => ({ id: u.id, aud: 'authenticated', role: 'authenticated', email: u.email, email_confirmed_at: now(), created_at: u.created_at, app_metadata: { provider: 'email' }, user_metadata: {}, identities: [] });

  function filter(rows, params) {
    let r = rows;
    for (const [k, v] of params) {
      if (['select', 'order', 'limit', 'on_conflict', 'columns'].includes(k)) continue;
      const i = v.indexOf('.');
      const op = v.slice(0, i), w = v.slice(i + 1);
      r = r.filter((row) => {
        const x = row[k];
        if (op === 'eq') return String(x) === w;
        if (op === 'neq') return String(x) !== w;
        if (op === 'is') return w === 'null' ? x == null : String(x) === w;
        if (op === 'in') return w.replace(/^\(|\)$/g, '').split(',').includes(String(x));
        throw new Error(`Filter fehlt: ${k}=${v}`);
      });
    }
    const order = params.get('order');
    if (order) {
      const [f, dir] = order.split('.');
      r = [...r].sort((a, b) => String(a[f] ?? '').localeCompare(String(b[f] ?? '')) * (dir === 'desc' ? -1 : 1));
    }
    const lim = params.get('limit');
    return lim ? r.slice(0, Number(lim)) : r;
  }

  const OWN = new Set(['members', 'job_profile', 'job_leads', 'queue', 'consents', 'feedback']);

  function rest(req, res, url, body) {
    const tab = url.pathname.replace('/rest/v1/', '');
    const uid = userOf(req);
    if (tab.startsWith('rpc/')) return rpc(tab.slice(4), uid, body, res);
    if (!OWN.has(tab)) return send(res, 403, { code: '42501', message: 'permission denied' });
    if (!uid) return send(res, 401, { code: '42501', message: 'JWT missing' });
    const rows = db[tab];
    const eigene = rows.filter((r) => r.user_id === uid); // wie RLS
    const objekt = (req.headers.accept ?? '').includes('vnd.pgrst.object');
    const prefer = req.headers.prefer ?? '';
    const antworte = (list, status = 200) => {
      if (objekt) {
        if (list.length !== 1) return send(res, 406, { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: `The result contains ${list.length} rows` });
        return send(res, status, list[0]);
      }
      return send(res, status, list);
    };
    if (req.method === 'GET') return antworte(filter(eigene, url.searchParams));
    if (req.method === 'POST') {
      const neu = [];
      for (const row of Array.isArray(body) ? body : [body]) {
        if (row.user_id && row.user_id !== uid) return send(res, 403, { code: '42501', message: 'new row violates row-level security policy' });
        if (tab === 'job_profile' && !db.members.some((m) => m.user_id === uid && m.status === 'aktiv')) return send(res, 403, { code: '42501', message: 'new row violates row-level security policy' });
        const vorhanden = tab === 'job_profile' ? rows.find((r) => r.user_id === uid) : null;
        if (vorhanden && prefer.includes('merge-duplicates')) { Object.assign(vorhanden, row, { updated_at: now() }); neu.push(vorhanden); continue; }
        const voll = { id: randomUUID(), created_at: now(), updated_at: now(), ...row, user_id: uid };
        if (tab === 'job_profile') voll.preferences ??= {};
        rows.push(voll);
        neu.push(voll);
      }
      return prefer.includes('return=representation') ? antworte(neu, 201) : send(res, 201, null);
    }
    if (req.method === 'PATCH') {
      if (tab !== 'job_leads' && tab !== 'job_profile') return send(res, 403, { code: '42501', message: 'permission denied' });
      const treffer = filter(eigene, url.searchParams);
      for (const r of treffer) Object.assign(r, body, { updated_at: now() });
      return prefer.includes('return=representation') ? antworte(treffer) : send(res, 204, null);
    }
    return send(res, 405, { message: 'Methode' });
  }

  function rpc(name, uid, body, res) {
    const m = db.members.find((x) => x.user_id === uid);
    if (name === 'public_config') return send(res, 200, { offene_registrierung: false, preis: { betrag_eur: 19, intervall: 'monat', probe_tage: 7 }, pausiert: false });
    if (!uid) return send(res, 401, { code: '42501', message: 'JWT missing' });
    if (name === 'is_admin') return send(res, 200, db.admins.has(uid));
    if (name === 'admin_overview') {
      if (!db.admins.has(uid)) return send(res, 403, { code: '42501', message: 'kein_admin' });
      return send(res, 200, { stand: now(), nutzer: db.members.length, aktiv: db.members.length, probe: 0, zahlend: 0, gekuendigt: 0, zahlung_offen: 0, aktiv_7_tage: 1, kosten_heute: 0.12, kosten_7_tage: 0.5, kosten_30_tage: 1.2, laeufe_30_tage: { scout: 3, writer: 4 }, warteschlange: 0, warteliste: 2, fehler: [], mitglieder: db.members.map((x) => ({ id: x.user_id.slice(0, 8), email: db.users.find((u) => u.id === x.user_id)?.email, plan: x.plan, sub_status: null, valid_until: x.valid_until, cancel_at_period_end: false, joined_at: x.joined_at, treffer: db.job_leads.filter((l) => l.user_id === x.user_id).length, beworben: 0, kosten_30: 0.4 })) });
    }
    if (name.startsWith('admin_') && !db.admins.has(uid)) return send(res, 403, { code: '42501', message: 'kein_admin' });
    if (name === 'admin_warteliste') return send(res, 200, db.waitlist);
    if (name === 'admin_einladen') {
      const w = db.waitlist.find((x) => x.id === body.p_id);
      if (!w) return send(res, 404, { code: 'P0002', message: 'nicht_gefunden' });
      w.invited_at = now();
      const code = `JB-${randomUUID().slice(0, 4).toUpperCase()}-0000-0000-0001`;
      db.invites.push({ code, days: 30, plan: 'beta', used: 0, max: 1 });
      return send(res, 200, JSON.stringify(code));
    }
    if (name === 'admin_codes') {
      const neu = Array.from({ length: body.p_anzahl }, (_, i) => `JB-TEST-${String(i).padStart(4, '0')}-0000-0000`);
      neu.forEach((code) => db.invites.push({ code, days: body.p_tage, plan: 'beta', used: 0, max: 1, note: body.p_notiz, created_at: now() }));
      return send(res, 200, neu);
    }
    if (name === 'admin_offene_codes') return send(res, 200, db.invites.filter((i) => i.used < i.max).map((i) => ({ code: i.code, note: i.note ?? null, days: i.days, expires_at: null, created_at: i.created_at ?? now() })));
    if (name === 'redeem_code') {
      const inv = db.invites.find((i) => i.code === body.p_code && i.used < i.max);
      if (!inv) return send(res, 200, { ok: false, grund: 'code' });
      inv.used++;
      m.valid_until = new Date(Math.max(Date.parse(m.valid_until ?? now()), Date.now()) + inv.days * 86400000).toISOString();
      m.plan = inv.plan;
      return send(res, 200, { ok: true, gueltig_bis: m.valid_until, tarif: inv.plan });
    }
    if (name === 'request_run') {
      if (!m) return send(res, 200, { ok: false, grund: 'kein_zugang' });
      const p = db.job_profile.find((x) => x.user_id === uid);
      if (!p || (p.cv_text ?? '').length < 200) return send(res, 200, { ok: false, grund: 'profil_fehlt' });
      if (db.queue.some((q) => q.user_id === uid && q.kind === body.p_kind && q.status === 'wartet' && (body.p_kind === 'scout' || q.lead_id === body.p_lead))) return send(res, 200, { ok: false, grund: 'laeuft_schon' });
      const q = { id: randomUUID(), user_id: uid, kind: body.p_kind, lead_id: body.p_lead ?? null, stage: body.p_stage ?? null, status: 'wartet', created_at: now() };
      db.queue.push(q);
      db.log.push(`request_run ${body.p_kind}`);
      if (body.p_kind === 'scout') simuliereScout(uid, q);
      if (body.p_kind === 'vorbereitung') { const l = db.job_leads.find((x) => x.id === body.p_lead); l.prep_requested_at = now(); }
      return send(res, 200, { ok: true, queue_id: q.id, rest: 2 });
    }
    return send(res, 404, { message: `rpc ${name} fehlt` });
  }

  // So, wie der Worker es später tut: zwei erfundene Treffer
  function simuliereScout(uid, q) {
    const basis = { user_id: uid, kind: 'stelle', source: 'Karriereseite', apply_email: null, contact_name: null, salary: null, language: 'de', keywords: [{ term: 'SAP', matched: true }, { term: 'IATF 16949', matched: false }], requirements: '- Studium\n- SAP', pre_info: null, status: 'neu', email_subject: null, email_body: null, cover_letter_md: null, cv_highlights: null, drafted_at: null, applied_at: null, notes: null, archive_reason: null, requested_at: null, next_at: null, stage_updated_at: null, interview1_input: null, interview1_prep: null, interview2_input: null, interview2_prep: null, prep_requested_at: null, created_at: now(), updated_at: now() };
    db.job_leads.push(
      { ...basis, id: randomUUID(), company: 'Beispielwerk GmbH', title: 'Trainee Qualitätsmanagement', location: 'Graz', url: 'https://example.com/jobs/1', apply_channel: 'portal', posted_at: '2026-11-10', deadline: null, match_score: 88, summary: 'Trainee im QM, 18 Monate.', why_fit: 'Passt zum Praktikum. Chance: hoch. Einsteiger gesucht.' },
      { ...basis, id: randomUUID(), company: 'Muster AG', title: 'Junior Produktionsplanerin', location: 'Linz', url: 'https://example.com/jobs/2', apply_channel: 'email', apply_email: 'jobs@example.com', posted_at: '2026-11-08', deadline: '2026-11-30', match_score: 74, summary: 'Planung in der Fertigung.', why_fit: 'Passt zur Werkstudentenzeit. Chance: mittel. SAP PP verlangt.' },
    );
    q.status = 'fertig';
  }

  function functions(req, res, url, body) {
    const name = url.pathname.replace('/functions/v1/', '');
    db.log.push(`function ${name}`);
    if (name === 'signup') {
      if (body.consent !== true) return send(res, 400, { ok: false, grund: 'einwilligung' });
      if (!body.code) return send(res, 403, { ok: false, grund: 'code_noetig' });
      const inv = db.invites.find((i) => i.code === body.code && i.used < i.max);
      if (!inv) return send(res, 403, { ok: false, grund: 'code' });
      if (db.users.some((u) => u.email === body.email.toLowerCase())) return send(res, 409, { ok: false, grund: 'konto_existiert' });
      inv.used++;
      const u = { id: randomUUID(), email: body.email.toLowerCase(), password: body.password, created_at: now() };
      db.users.push(u);
      db.members.push({ user_id: u.id, plan: inv.plan, status: 'aktiv', valid_until: new Date(Date.now() + inv.days * 86400000).toISOString(), limits: null, sub_status: null, cancel_at_period_end: false, trial_used: false, joined_at: now() });
      db.consents.push({ user_id: u.id, kind: 'datenschutz', version: '2026-11-beta', accepted_at: now() });
      return send(res, 200, { ok: true });
    }
    const uid = userOf(req);
    if (!uid) return send(res, 401, { ok: false, grund: 'nicht_angemeldet' });
    if (name === 'profil-vorschlag') {
      const t = String(body.text ?? '');
      if (t.trim().length < 40) return send(res, 400, { ok: false, grund: 'zu_kurz', text: 'Beschreib deinen perfekten Job in zwei, drei Sätzen.' });
      // Nachbildung: liest nur, was wirklich im Text steht
      const orte = ['Innsbruck', 'Graz', 'Linz', 'Wien', 'München'].filter((o) => t.includes(o));
      return send(res, 200, { ok: true, felder: {
        zielrollen: /qualität/i.test(t) ? 'Trainee Qualitätsmanagement, Junior Qualitätsingenieur' : '',
        stellenarten: /trainee/i.test(t) ? ['Trainee'] : [],
        orte, start: /märz/i.test(t) ? 'ab März 2027' : '', ausschluesse: /kein außendienst/i.test(t) ? 'Außendienst' : '', wuensche: 'Produzierende Industrie, Team vor Ort',
      } });
    }
    if (name === 'run-now') {
      const q = db.queue.find((x) => x.id === body.queue_id && x.user_id === uid && x.status === 'wartet');
      if (!q) return send(res, 409, { ok: false, grund: 'nicht_verfuegbar' });
      const l = db.job_leads.find((x) => x.id === q.lead_id);
      Object.assign(l, { status: 'entwurf', drafted_at: now(), email_subject: `Bewerbung als ${l.title}: Lena Beispiel`, email_body: 'Sehr geehrte Damen und Herren,\n\nkurz und knapp.\n\nMit freundlichen Grüßen\nLena Beispiel', cover_letter_md: 'Bewerbung als Trainee Qualitätsmanagement\n\nSehr geehrte Frau Muster,\n\nich schließe im Februar ab und will Qualität dort verbessern, wo sie entsteht.\n\nIn meinem Praktikum habe ich die Reklamationsquote um 18 % gesenkt.\n\nMit freundlichen Grüßen\nLena Beispiel', cv_highlights: '- QM-Praktikum nach oben\n- SAP PP nennen', pre_info: 'Zeugnisse hochladen.' });
      q.status = 'fertig';
      return send(res, 200, { ok: true, sekunden: 42 });
    }
    if (name === 'billing') return send(res, 503, { ok: false, grund: 'zahlung_nicht_eingerichtet' });
    if (name === 'delete-account') {
      if (String(body.confirm).toUpperCase() !== 'LÖSCHEN') return send(res, 400, { ok: false, grund: 'bestaetigung' });
      for (const t of OWN) db[t] = db[t].filter((r) => r.user_id !== uid);
      db.users = db.users.filter((u) => u.id !== uid);
      return send(res, 200, { ok: true, dateien: 1 });
    }
    return send(res, 404, { ok: false, grund: 'unbekannt' });
  }

  function authRoute(req, res, url, body) {
    const p = url.pathname.replace('/auth/v1/', '');
    if (p === 'token' && url.searchParams.get('grant_type') === 'password') {
      const u = db.users.find((x) => x.email === String(body.email).toLowerCase() && x.password === body.password);
      if (!u) return send(res, 400, { error: 'invalid_grant', error_description: 'Invalid login credentials', code: 'invalid_credentials', msg: 'Invalid login credentials' });
      return send(res, 200, session(u));
    }
    if (p === 'token' && url.searchParams.get('grant_type') === 'refresh_token') return send(res, 400, { error: 'invalid_grant', msg: 'Refresh Token Not Found' });
    const uid = userOf(req);
    const u = db.users.find((x) => x.id === uid);
    if (p === 'user' && req.method === 'GET') return u ? send(res, 200, authUser(u)) : send(res, 401, { msg: 'invalid JWT' });
    if (p === 'user' && req.method === 'PUT') { if (!u) return send(res, 401, { msg: 'invalid JWT' }); if (body.password) u.password = body.password; return send(res, 200, authUser(u)); }
    if (p === 'logout') { db.tokens.delete((req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')); return send(res, 204, null); }
    return send(res, 404, { msg: `auth ${p} fehlt` });
  }

  function storage(req, res, url, raw) {
    const uid = userOf(req);
    const p = decodeURIComponent(url.pathname.replace(/^\/storage\/v1\/object\/(authenticated\/)?/, ''));
    const [bucket, ordner] = p.split('/');
    if (bucket !== 'cvs' && bucket !== 'contracts') return send(res, 404, { message: 'Bucket not found' });
    if (!uid || ordner !== uid) return send(res, 403, { statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy' });
    if (req.method === 'POST' || req.method === 'PUT') { db.files.set(p, raw); return send(res, 200, { Key: p, Id: randomUUID() }); }
    if (req.method === 'GET') { const f = db.files.get(p); return f ? send(res, 200, f, { 'content-type': 'application/pdf' }) : send(res, 404, { message: 'Object not found' }); }
    return send(res, 405, {});
  }

  const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.txt': 'text/plain', '.svg': 'image/svg+xml' };
  function statisch(res, url) {
    let f = path.join(dist, decodeURIComponent(url.pathname));
    if (!f.startsWith(dist) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) f = path.join(dist, 'index.html');
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] ?? 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  }

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const url = new URL(req.url, 'http://x');
      if (req.method === 'OPTIONS') return send(res, 204, null);
      let body;
      try { body = raw.length && /json/.test(req.headers['content-type'] ?? '') ? JSON.parse(raw.toString('utf8')) : undefined; } catch { body = undefined; }
      try {
        if (url.pathname.startsWith('/auth/v1/')) return authRoute(req, res, url, body ?? {});
        if (url.pathname.startsWith('/rest/v1/')) return rest(req, res, url, body);
        if (url.pathname.startsWith('/functions/v1/')) return functions(req, res, url, body ?? {});
        if (url.pathname.startsWith('/storage/v1/')) return storage(req, res, url, raw);
        return statisch(res, url);
      } catch (e) {
        db.log.push(`FEHLER ${e.message}`);
        return send(res, 500, { message: e.message });
      }
    });
  });
  return { server, db };
}
