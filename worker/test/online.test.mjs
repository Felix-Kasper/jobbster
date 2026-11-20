// Jobbster · Tests der Prüfung, ob Anzeigen noch online sind. Ohne Netz.
// Start: node --test worker/test/online.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { anzeigeStatus, entscheide, fristVorbei, pruefeAlle } from '../lib/online.mjs';

const antwort = (status, text = '') => new Response(text, { status });
const JETZT = new Date('2026-11-21T03:30:00Z');

test('Arbeitsagentur: Referenz aus dem Link, 404 heißt weg, 200 online, 500 unklar', async () => {
  const gefragt = [];
  const holen = async (url, init) => {
    gefragt.push({ url, kennung: init.headers['X-API-Key'] });
    const ref = atob(decodeURIComponent(url.split('/').pop()));
    return antwort({ 'A-1-S': 200, 'B-2-S': 404, 'C-3-S': 500 }[ref] ?? 418);
  };
  const s = (ref) => anzeigeStatus(holen, `https://www.arbeitsagentur.de/jobsuche/jobdetail/${ref}`);
  assert.equal((await s('A-1-S')).status, 'online');
  assert.deepEqual(await s('B-2-S'), { status: 'weg', grund: 'Arbeitsagentur kennt die Anzeige nicht mehr (404)' });
  assert.equal((await s('C-3-S')).status, 'unklar');
  assert.equal(gefragt[0].kennung, 'jobboerse-jobsuche');
  assert.match(gefragt[0].url, /^https:\/\/rest\.arbeitsagentur\.de\/jobboerse\/jobsuche-service\/pc\/v4\/jobdetails\//);
});

test('EURES: Kennung aus dem Link, 404 heißt weg', async () => {
  let gefragt = '';
  const holen = async (url) => { gefragt = url; return antwort(404); };
  const b = await anzeigeStatus(holen, 'https://europa.eu/eures/portal/jv-se/jv-details/QUJD?lang=de');
  assert.equal(b.status, 'weg');
  assert.equal(gefragt, 'https://europa.eu/eures/api/jv-searchengine/public/jv/id/QUJD?lang=de');
});

test('Andere Seiten: 404 oder eindeutiger Satz heißt weg, gesperrt oder still heißt nie weg', async () => {
  const seiten = {
    'https://a.example/404': antwort(404),
    'https://a.example/410': antwort(410),
    'https://a.example/gesperrt': antwort(403),
    'https://a.example/lebt': antwort(200, '<h1>Junior Controller</h1><p>Jetzt bewerben</p><footer>Artikel nicht verfügbar</footer>'),
    'https://a.example/de': antwort(200, '<main><div class="hinweis">Diese Stelle ist leider nicht mehr verfügbar.</div></main>'),
    'https://a.example/en': antwort(200, '<p>This job is no longer available</p>'),
    'https://a.example/linkedin': antwort(200, '<span>No longer accepting applications</span>'),
    'https://a.example/skript': antwort(200, '<script>const t = "Diese Stelle ist nicht mehr verfügbar"</script><h1>Lebt</h1>'),
  };
  const holen = async (url) => seiten[url] ?? antwort(500);
  const st = async (u) => (await anzeigeStatus(holen, u)).status;
  assert.equal(await st('https://a.example/404'), 'weg');
  assert.equal(await st('https://a.example/410'), 'weg');
  assert.equal(await st('https://a.example/gesperrt'), 'unklar');
  assert.equal(await st('https://a.example/lebt'), 'online', 'ein allgemeines „nicht verfügbar“ reicht nicht');
  assert.equal(await st('https://a.example/de'), 'weg');
  assert.equal(await st('https://a.example/en'), 'weg');
  assert.equal(await st('https://a.example/linkedin'), 'weg');
  assert.equal(await st('https://a.example/skript'), 'online', 'Text in Skripten zählt nicht');
});

test('Netzfehler, fehlender oder kaputter Link: unklar', async () => {
  const holen = async () => { throw Object.assign(new Error('weg'), { name: 'TimeoutError' }); };
  assert.deepEqual(await anzeigeStatus(holen, 'https://a.example/x'), { status: 'unklar', grund: 'nicht erreichbar (TimeoutError)' });
  assert.equal((await anzeigeStatus(holen, null)).status, 'unklar');
  assert.equal((await anzeigeStatus(holen, 'kein link')).status, 'unklar');
});

test('Frist: am selben Tag noch gültig, ohne Datum nie vorbei', () => {
  assert.equal(fristVorbei('2026-11-20', '2026-11-21'), true);
  assert.equal(fristVorbei('2026-11-21', '2026-11-21'), false);
  assert.equal(fristVorbei(null, '2026-11-21'), false);
  assert.equal(fristVorbei('keine', '2026-11-21'), false);
});

test('Entscheidung: neu wird gelöscht, Entwurf archiviert, unklar nur wenn alt', () => {
  const t = (extra) => ({ id: 'x', status: 'neu', url: 'u', deadline: null, posted_at: null, created_at: '2026-11-15T10:00:00Z', ...extra });
  const weg = { status: 'weg', grund: '404' };
  const unklar = { status: 'unklar', grund: '403' };
  assert.deepEqual(entscheide(t({}), weg, JETZT).aenderung, { online_geprueft_at: JETZT.toISOString(), status: 'geloescht', archive_reason: 'Anzeige nicht mehr online, geprüft 21.11.' });
  assert.equal(entscheide(t({ status: 'entwurf' }), weg, JETZT).aenderung.status, 'verworfen');
  assert.deepEqual(entscheide(t({}), unklar, JETZT).aenderung, { online_geprueft_at: JETZT.toISOString() }, 'junge, nicht prüfbare Anzeige bleibt');
  assert.match(entscheide(t({ posted_at: '2026-09-01' }), unklar, JETZT).warum, /vermutlich abgelaufen \(über 6 Wochen alt/);
  assert.equal(entscheide(t({ posted_at: '2026-09-01' }), { status: 'online', grund: '200' }, JETZT).warum, null, 'alt, aber nachweislich online: bleibt');
  assert.match(entscheide(t({ deadline: '2026-11-01' }), { status: 'online', grund: '200' }, JETZT).warum, /^Bewerbungsfrist vorbei/);
});

test('Alle prüfen: jede Anzeige genau einmal, auch bei vielen auf einem Host', async () => {
  const gefragt = [];
  const holen = async (url) => { gefragt.push(url); return antwort(url.includes('tot') ? 404 : 200); };
  const anzeigen = [...Array.from({ length: 95 }, (_, i) => ({ id: `a${i}`, url: `https://viel.example/${i}` })), { id: 't', url: 'https://b.example/tot' }, { id: 'n', url: null }];
  const aus = await pruefeAlle(holen, anzeigen, { pauseMs: 0 });
  assert.equal(aus.length, 97);
  assert.equal(new Set(aus.map((a) => a.id)).size, 97);
  assert.equal(gefragt.length, 96);
  assert.equal(aus.find((a) => a.id === 't').befund.status, 'weg');
  assert.equal(aus.find((a) => a.id === 'n').befund.status, 'unklar');
});
