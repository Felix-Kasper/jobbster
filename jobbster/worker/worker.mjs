#!/usr/bin/env node
/**
 * Jobbster · Worker
 * Arbeitet die Warteschlange ab: Scout, Entwurf, Gesprächsvorbereitung.
 * Läuft in GitHub Actions (nach Zeitplan und auf Anstoß). Schlüssel nur als Secrets.
 *
 *   node worker/worker.mjs          offene Aufträge abarbeiten
 *   node worker/worker.mjs --plan   vorher für alle aktiven Nutzer den fälligen Scout-Lauf einreihen
 *
 * Umgebung: SUPABASE_URL, SUPABASE_SERVICE_KEY, ANTHROPIC_API_KEY
 * Optional: SCOUT_VARIANTE (filter|einfach), WORKER_MAX_AUFTRAEGE (8), WORKER_MAX_MINUTEN (25)
 *
 * Im Protokoll stehen nur Kennungen, Mengen und Kosten. Keine Namen, keine Lebensläufe.
 */
import http from 'node:http';
import https from 'node:https';
import { pathToFileURL } from 'node:url';
import { createClaude } from './lib/claude.mjs';
import { scout, entwurf, vorbereitung } from './lib/agents.mjs';

const kurzId = (id) => String(id || '').slice(0, 8);
const usd = (n) => `${Number(n || 0).toFixed(3)} $`;

function nodePost(base, key) {
  return (body, version) => {
    const url = new URL('/v1/messages', base);
    const lib = url.protocol === 'http:' ? http : https;
    const data = Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
      const req = lib.request(
        url,
        { method: 'POST', timeout: 20 * 60 * 1000, headers: { 'content-type': 'application/json', 'content-length': data.length, 'x-api-key': key, 'anthropic-version': version } },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let json = null;
            try { json = JSON.parse(text); } catch { /* kein JSON */ }
            resolve({ status: res.statusCode, json, text, retryAfter: res.headers['retry-after'] });
          });
        },
      );
      req.on('socket', (s) => s.setKeepAlive(true, 30_000));
      req.on('timeout', () => req.destroy(new Error('Zeitüberschreitung nach 20 min')));
      req.on('error', reject);
      req.end(data);
    });
  };
}

function datenbank(url, key) {
  return async (method, pfad, body, prefer) => {
    const res = await fetch(`${url}/rest/v1/${pfad}`, {
      method,
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(prefer ? { Prefer: prefer } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Datenbank ${method} ${pfad.split('?')[0]}: ${res.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  };
}

function signaleText(leads) {
  const gut = leads.filter((l) => ['beworben', 'interview', 'interview2', 'vertrag', 'zusage'].includes(l.status)).slice(0, 20);
  const weg = leads.filter((l) => ['verworfen', 'geloescht'].includes(l.status) && l.archive_reason && !/nicht mehr online|doppelt/i.test(l.archive_reason)).slice(0, 20);
  const z = [];
  if (gut.length) z.push(`Beworben oder im Gespräch (mehr davon, bei anderen Firmen): ${gut.map((l) => `${l.title} bei ${l.company}`).join('; ')}`);
  if (weg.length) z.push(`Aussortiert mit Grund (das Muster meiden): ${weg.map((l) => `${l.title} bei ${l.company}: ${String(l.archive_reason).slice(0, 80)}`).join('; ')}`);
  return z.join('\n');
}

export async function main(env = process.env, argv = process.argv.slice(2)) {
  const fehlt = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'ANTHROPIC_API_KEY'].filter((k) => !env[k]);
  if (fehlt.length) {
    console.log(`Es fehlen: ${fehlt.join(', ')}`);
    return 1;
  }
  const db = datenbank(env.SUPABASE_URL.replace(/\/$/, ''), env.SUPABASE_SERVICE_KEY);
  const claude = createClaude({
    post: nodePost(env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com', env.ANTHROPIC_API_KEY),
    log: (m) => console.log(`    … ${m}`),
    wartenMaxS: Number(env.WORKER_WARTEN_MAX_S || 90),
  });
  const cfg = { ...(env.SCOUT_VARIANTE ? { variante: env.SCOUT_VARIANTE } : {}) };
  const maxAuftraege = Number(env.WORKER_MAX_AUFTRAEGE || 8);
  const ende = Date.now() + Number(env.WORKER_MAX_MINUTEN || 25) * 60_000;
  const jetzt = () => new Date().toISOString();

  // Betriebsschalter
  const schalter = Object.fromEntries((await db('GET', 'app_config?select=key,value')).map((r) => [r.key, r.value]));
  if (schalter.pausiert === true) {
    console.log('Not-Aus ist an (app_config.pausiert). Nichts zu tun.');
    return 0;
  }
  const tageslimit = Number(schalter.tageslimit_usd ?? 3);

  // Hängengebliebene Aufträge freigeben (zählen dann nicht gegen die Grenze des Nutzers)
  const alt = new Date(Date.now() - 40 * 60_000).toISOString();
  await db('PATCH', `queue?status=eq.laeuft&started_at=lt.${alt}`, { status: 'fehler', error: 'Abgebrochen: Zeitüberschreitung', finished_at: jetzt() });

  // Fällige Scout-Läufe einreihen (Zeitplan)
  if (argv.includes('--plan')) {
    const mitglieder = await db('GET', 'members?status=eq.aktiv&select=user_id,valid_until,limits');
    const profile = new Set((await db('GET', 'job_profile?onboarded_at=not.is.null&select=user_id')).map((p) => p.user_id));
    const jetztMs = Date.now();
    let n = 0;
    for (const m of mitglieder) {
      if (!profile.has(m.user_id)) continue;
      if (m.valid_until && Date.parse(m.valid_until) <= jetztMs) continue; // Zugang abgelaufen
      // Eigene Grenzen (Probe-Codes) gehen vor. Sonst sucht der Zeitplan einmal am Tag: kein neuer Lauf,
      // wenn in den letzten 12 Stunden schon einer lief (auch ein von Hand gestarteter).
      const g = m.limits?.scout || { anzahl: 1, tage: 0.5 };
      if (!(g.anzahl > 0)) continue;
      const seit = new Date(jetztMs - g.tage * 86_400_000).toISOString();
      const eigene = await db('GET', `queue?user_id=eq.${m.user_id}&kind=eq.scout&status=neq.fehler&created_at=gte.${seit}&select=status`);
      if (eigene.length >= g.anzahl || eigene.some((l) => ['wartet', 'laeuft'].includes(l.status))) continue;
      await db('POST', 'queue', { user_id: m.user_id, kind: 'scout' }, 'return=minimal');
      n++;
    }
    console.log(`Zeitplan: ${n} Scout-Läufe eingereiht (${mitglieder.length} aktive Mitglieder).`);
  }

  let erledigt = 0;
  let fehler = 0;
  let gesamtUsd = 0;

  while (erledigt + fehler < maxAuftraege && Date.now() < ende) {
    // Tagesbudget prüfen (UTC-Tag)
    const tag = `${jetzt().slice(0, 10)}T00:00:00Z`;
    const heute = (await db('GET', `runs?created_at=gte.${tag}&select=cost_usd`)).reduce((a, r) => a + Number(r.cost_usd || 0), 0);
    if (heute >= tageslimit) {
      console.log(`Tageslimit erreicht: ${usd(heute)} von ${usd(tageslimit)}. Offene Aufträge warten bis morgen.`);
      return 3; // Fehlschlag, damit GitHub eine Mail schickt
    }

    const [auftrag] = await db('GET', 'queue?status=eq.wartet&order=created_at.asc&limit=1');
    if (!auftrag) break;
    const [meiner] = await db('PATCH', `queue?id=eq.${auftrag.id}&status=eq.wartet`, { status: 'laeuft', started_at: jetzt() }, 'return=representation');
    if (!meiner) continue; // ein anderer Lauf war schneller

    const uid = auftrag.user_id;
    const agent = { scout: 'scout', entwurf: 'writer', vorbereitung: 'coach' }[auftrag.kind];
    const t0 = Date.now();
    console.log(`▶ ${auftrag.kind} · Auftrag ${kurzId(auftrag.id)} · Nutzer ${kurzId(uid)}`);
    let nutzung = null;
    let model = null;
    let anzahl = 0;
    const usdVorher = claude.usd();

    try {
      const [mitglied] = await db('GET', `members?user_id=eq.${uid}&status=eq.aktiv&select=user_id,valid_until`);
      if (!mitglied) throw new Error('Kein aktiver Zugang');
      if (mitglied.valid_until && Date.parse(mitglied.valid_until) <= Date.now()) throw new Error('Zugang abgelaufen');
      const [profil] = await db('GET', `job_profile?user_id=eq.${uid}`);
      if (!profil || String(profil.cv_text || '').length < 200) throw new Error('Profil ohne Lebenslauf');

      if (auftrag.kind === 'scout') {
        const alle = await db('GET', `job_leads?user_id=eq.${uid}&select=company,title,status,archive_reason&order=created_at.desc&limit=300`);
        const r = await scout({ claude, profil, bekannt: [...new Set(alle.map((l) => l.company))], signale: signaleText(alle), cfg });
        nutzung = r.nutzung;
        model = r.model;
        if (r.leads.length) {
          const neu = await db('POST', 'job_leads?on_conflict=user_id,dedup_key', r.leads.map((l) => ({ ...l, user_id: uid })), 'resolution=ignore-duplicates,return=representation');
          anzahl = neu?.length || 0;
        }
        for (const h of r.hinweise) console.log(`    Hinweis: ${h}`);
        console.log(`    ${anzahl} neue Treffer gespeichert (${r.leads.length} gefunden, ${r.abgelehnt.length} abgelehnt), Werkzeug ${r.werkzeug}`);
      } else {
        const [lead] = await db('GET', `job_leads?id=eq.${auftrag.lead_id}&user_id=eq.${uid}`);
        if (!lead) throw new Error('Treffer nicht gefunden');
        if (auftrag.kind === 'entwurf') {
          const r = await entwurf({ claude, profil, lead, cfg });
          nutzung = r.nutzung;
          model = r.model;
          await db('PATCH', `job_leads?id=eq.${lead.id}&user_id=eq.${uid}`, { ...r.felder, drafted_at: jetzt(), ...(lead.status === 'neu' ? { status: 'entwurf' } : {}) }, 'return=minimal');
          anzahl = 1;
          for (const h of r.hinweise) console.log(`    Hinweis: ${h}`);
          console.log(`    Entwurf gespeichert (${r.felder.cover_letter_md.length} Zeichen Anschreiben)`);
        } else {
          const stufe = auftrag.stage === 'interview2' ? 'interview2' : 'interview1';
          const r = await vorbereitung({ claude, profil, lead, stufe, cfg });
          nutzung = r.nutzung;
          model = r.model;
          await db('PATCH', `job_leads?id=eq.${lead.id}&user_id=eq.${uid}`, { [`${stufe}_prep`]: r.prep, prep_requested_at: null }, 'return=minimal');
          anzahl = 1;
          for (const h of r.hinweise) console.log(`    Hinweis: ${h}`);
          console.log('    Vorbereitung gespeichert');
        }
      }

      await db('POST', 'runs', {
        user_id: uid, queue_id: auftrag.id, agent, model, requests: nutzung.anfragen, searches: nutzung.suchen, fetches: nutzung.abrufe,
        input_tokens: nutzung.tokensEin, output_tokens: nutzung.tokensAus, cost_usd: Number(nutzung.usd.toFixed(4)), duration_ms: Date.now() - t0, result_count: anzahl, status: 'ok',
      }, 'return=minimal');
      await db('PATCH', `queue?id=eq.${auftrag.id}`, { status: 'fertig', finished_at: jetzt() }, 'return=minimal');
      gesamtUsd += nutzung.usd;
      erledigt++;
      console.log(`    fertig in ${Math.round((Date.now() - t0) / 1000)} s, ${usd(nutzung.usd)}`);
    } catch (e) {
      fehler++;
      const grund = String(e.message || e).slice(0, 300);
      console.log(`    ✖ ${grund}`);
      try {
        await db('POST', 'runs', {
          user_id: uid, queue_id: auftrag.id, agent, model, cost_usd: Number((claude.usd() - usdVorher).toFixed(4)), duration_ms: Date.now() - t0, status: 'fehler', error: grund,
        }, 'return=minimal');
        gesamtUsd += claude.usd() - usdVorher;
        await db('PATCH', `queue?id=eq.${auftrag.id}`, { status: 'fehler', error: grund, finished_at: jetzt() }, 'return=minimal');
      } catch (e2) {
        console.log(`    ✖ Fehler beim Protokollieren: ${String(e2.message).slice(0, 200)}`);
      }
    }
  }

  console.log(`Fertig: ${erledigt} erledigt, ${fehler} fehlgeschlagen, ${usd(gesamtUsd)}.`);
  return fehler ? 2 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().then((code) => { process.exitCode = code; }).catch((e) => {
    console.log(`✖ Worker abgebrochen: ${String(e.message).slice(0, 300)}`);
    process.exitCode = 1;
  });
}
