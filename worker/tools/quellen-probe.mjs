// Jobbster · Diagnose der Stellen-Quellen gegen die echten Schnittstellen. Ohne KI, ohne Schlüssel, schreibt nichts.
// Start: node worker/tools/quellen-probe.mjs "Controller,Controlling" "Innsbruck,München"
// Zeigt, was der Scout sehen würde: Anfragen, Ausfälle, Vorauswahl und zwei Anzeigen so, wie sie in die Bewertung gehen.
import * as Q from '../lib/quellen.mjs';

const [begriffeRoh = 'Controller,Controlling', orteRoh = 'Innsbruck,München'] = process.argv.slice(2);
const begriffe = Q.begriffeMischen(begriffeRoh.split(','));
const orte = Q.ortPlan(orteRoh.split(','));
console.log(`Begriffe: ${begriffe.join(' · ')}\nOrte: ${orte.map((o) => `${o.name} → ${o.quelle === 'eures' ? `EURES ${o.nuts.join('+')}` : 'Arbeitsagentur'}`).join(', ')}`);

const t0 = Date.now();
const roh = await Q.sammle({ holen: fetch, begriffe, orte });
const jeQuelle = Object.entries(Object.groupBy(roh.kandidaten, (k) => k.quelle)).map(([q, l]) => `${q}: ${l.length}`).join(', ');
console.log(`\n${roh.anfragen} Anfragen, ${roh.beantwortet} beantwortet, ${roh.kandidaten.length} Anzeigen (${jeQuelle || 'keine'}), ${Date.now() - t0} ms`);
for (const h of roh.hinweise) console.log(`Hinweis: ${h}`);

const auswahl = Q.vorauswahl(roh.kandidaten, { begriffe, max: 24 });
const t1 = Date.now();
const { kandidaten, fehlgeschlagen } = await Q.anreichern(fetch, auswahl);
console.log(`\nVorauswahl: ${auswahl.length}, mit Details: ${kandidaten.length} (${fehlgeschlagen} ohne), ${Date.now() - t1} ms`);
for (const k of kandidaten) console.log(`${String(k.punkte).padStart(3)}  ${k.datum}  ${k.quelle.slice(0, 5)}  ${k.firma ?? '(Firma im Text)'} | ${k.titel} | ${k.ort ?? '?'}${k.mail ? ' | Mail' : ''}`);

const liste = Q.trefferliste(kandidaten);
console.log(`\nTrefferliste für die Bewertung: ${liste.length} Zeichen (rund ${Math.round(liste.length / 3.3)} Tokens)\n`);
const zeigen = [kandidaten.find((k) => k.quelle.startsWith('EURES') && !k.firma), kandidaten.find((k) => k.quelle === 'Arbeitsagentur')].filter(Boolean);
console.log(Q.trefferliste(zeigen));

// Rohdaten einer EURES-Anzeige (ohne Langtext), um Feldnamen zu prüfen, wenn die Schnittstelle sich ändert
const eures = kandidaten.find((k) => k.quelle.startsWith('EURES'));
if (eures) {
  const d = await fetch(`https://europa.eu/eures/api/jv-searchengine/public/jv/id/${encodeURIComponent(eures.id)}?lang=de`, { headers: { Accept: 'application/json' } }).then((r) => r.json()).catch((e) => ({ fehler: e.message }));
  console.log('\nEURES roh:', JSON.stringify(d, (k, v) => (k === 'description' && typeof v === 'string' ? `${v.slice(0, 80)} …` : v)).slice(0, 2500));
}
// Führen die Links, die Nutzer anklicken, wirklich zu einer Seite?
for (const k of zeigen) {
  const status = await fetch(k.url, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0 (Jobbster Linkprüfung)' } }).then((r) => r.status).catch((e) => e.message);
  console.log(`Link ${status}: ${k.url}`);
}
// Morgendliche Prüfung: Jede Quelle muss antworten und etwas liefern, sonst schlägt der Lauf fehl
const jeQuelleAnzahl = Object.groupBy(roh.kandidaten, (k) => (k.quelle.startsWith('EURES') ? 'EURES' : 'Arbeitsagentur'));
const fehlt = ['Arbeitsagentur', 'EURES'].filter((q) => orte.some((o) => (q === 'EURES') === (o.quelle === 'eures')) && !(jeQuelleAnzahl[q]?.length));
if (fehlt.length) console.log(`\nACHTUNG: keine Anzeigen von ${fehlt.join(' und ')}. Schnittstelle prüfen (BETRIEB.md, Stellensuche).`);
if (!roh.beantwortet || fehlt.length) process.exitCode = 1;
