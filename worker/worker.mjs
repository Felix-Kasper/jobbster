#!/usr/bin/env node
/**
 * Jobbster · Worker
 * Arbeitet die Warteschlange ab: Scout, Entwurf, Gesprächsvorbereitung.
 * Läuft in GitHub Actions (nach Zeitplan und auf Anstoß). Schlüssel nur als Secrets.
 *
 *   node worker/worker.mjs          offene Aufträge abarbeiten
 *   node worker/worker.mjs --plan   vorher aufräumen (Anzeigen nicht mehr online) und für alle aktiven Nutzer den fälligen Scout-Lauf einreihen
 *   node worker/worker.mjs --aufraeumen   nur aufräumen, dann die Warteschlange
 *
 * Umgebung: SUPABASE_URL, SUPABASE_SERVICE_KEY, ANTHROPIC_API_KEY
 * Optional: SCOUT_VARIANTE (filter|einfach), SCOUT_MODELL (zum Testen), SCOUT_QUELLEN=aus (nur Websuche),
 *   TEXT_MODELL, TEXT_AUFWAND (low|medium|high), TEXT_DENKEN=aus (Anschreiben, zum Testen), WORKER_MAX_AUFTRAEGE (8), WORKER_MAX_MINUTEN (25)
 *
 * Im Protokoll stehen nur Kennungen, Mengen und Kosten. Keine Namen, keine Lebensläufe.
 */
import http from 'node:http';
import https from 'node:https';
import { pathToFileURL } from 'node:url';
import { createClaude, schluesselOk, verdecke } from './lib/claude.mjs';
import { aufraeumen, bearbeiteNaechsten, datenbank, haengendeFreigeben, plane, schalterLesen, usd } from './lib/betrieb.mjs';


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

/**
 * @param {Record<string, string | undefined>} env
 * @param {string[]} argv
 * @param {{ holen?: typeof fetch }} [dienste] Abruf der Stellen-Quellen, in Tests eine Attrappe
 */
export async function main(env = process.env, argv = process.argv.slice(2), { holen = globalThis.fetch } = {}) {
  env = { ...env, ANTHROPIC_API_KEY: String(env.ANTHROPIC_API_KEY ?? '').trim() };
  const fehlt = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'ANTHROPIC_API_KEY'].filter((k) => !env[k]);
  if (fehlt.length) {
    console.log(`Es fehlen: ${fehlt.join(', ')}`);
    return 1;
  }
  if (!schluesselOk(env.ANTHROPIC_API_KEY) && !env.ANTHROPIC_BASE_URL) {
    console.log('ANTHROPIC_API_KEY hat ein ungültiges Format. Nur den Schlüssel eintragen, ohne Vorspann und ohne Zeilenumbruch.');
    return 1;
  }
  const db = datenbank(env.SUPABASE_URL.replace(/\/$/, ''), env.SUPABASE_SERVICE_KEY);
  const claude = createClaude({
    post: nodePost(env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com', env.ANTHROPIC_API_KEY),
    log: (m) => console.log(`    … ${m}`),
    wartenMaxS: Number(env.WORKER_WARTEN_MAX_S || 90),
  });
  const cfg = {
    ...(env.SCOUT_VARIANTE ? { variante: env.SCOUT_VARIANTE } : {}),
    ...(/^claude-[a-z0-9-]+$/.test(env.SCOUT_MODELL || '') ? { modellScout: env.SCOUT_MODELL } : {}),
    ...(env.SCOUT_QUELLEN === 'aus' ? { quellen: false } : {}),
    ...(/^claude-[a-z0-9-]+$/.test(env.TEXT_MODELL || '') ? { modellText: env.TEXT_MODELL } : {}),
    ...(['low', 'medium', 'high'].includes(env.TEXT_AUFWAND || '') ? { textAufwand: env.TEXT_AUFWAND } : {}),
    ...(env.TEXT_DENKEN === 'aus' ? { textDenken: false } : {}),
  };
  const maxAuftraege = Number(env.WORKER_MAX_AUFTRAEGE || 8);
  const ende = Date.now() + Number(env.WORKER_MAX_MINUTEN || 25) * 60_000;

  // Betriebsschalter
  const schalter = await schalterLesen(db);
  if (schalter.pausiert === true) {
    console.log('Not-Aus ist an (app_config.pausiert). Nichts zu tun.');
    return 0;
  }
  const tageslimit = Number(schalter.tageslimit_usd ?? 3);

  await haengendeFreigeben(db, 40);

  // Jeden Morgen zuerst aufräumen: offene Treffer, deren Anzeige nicht mehr online ist, fliegen raus
  if (argv.includes('--plan') || argv.includes('--aufraeumen')) {
    try {
      await aufraeumen({ db, holen, max: Number(env.AUFRAEUMEN_MAX || 600) });
    } catch (e) {
      console.log(`Aufräumen fehlgeschlagen: ${verdecke(e.message)}`); // die Suche läuft trotzdem
    }
  }

  // Fällige Scout-Läufe einreihen (Zeitplan)
  if (argv.includes('--plan')) await plane({ db });

  let erledigt = 0;
  let fehler = 0;
  let gesamtUsd = 0;

  while (erledigt + fehler < maxAuftraege && Date.now() < ende) {
    const r = await bearbeiteNaechsten({ db, claude, cfg, holen, tageslimit });
    if (r.ergebnis === 'limit') {
      console.log(`Tageslimit erreicht: ${usd(r.heute)} von ${usd(tageslimit)}. Offene Aufträge warten bis morgen.`);
      return 3; // Fehlschlag, damit GitHub eine Mail schickt
    }
    if (r.ergebnis === 'leer') break;
    if (r.ergebnis === 'verloren') continue;
    gesamtUsd += r.usd;
    if (r.ergebnis === 'ok') erledigt++;
    else fehler++;
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
