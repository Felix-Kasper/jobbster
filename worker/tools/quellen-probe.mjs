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
if (!roh.beantwortet) process.exitCode = 1;
