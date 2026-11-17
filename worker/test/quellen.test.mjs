// Jobbster · Tests der Stellen-Quellen und des Scouts darauf. Ohne Netz: Schnittstellen und KI sind Attrappen.
// Start: node --test worker/test/quellen.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Q from '../lib/quellen.mjs';
import { scout, leadsAusBewertung, retteLeads } from '../lib/agents.mjs';

const JETZT = Date.parse('2026-11-16T10:00:00Z');
const vorTagen = (n) => new Date(JETZT - n * 86_400_000).toISOString().slice(0, 10);
const antwort = (json, status = 200) => new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });

// --- Attrappen der Schnittstellen ---------------------------------------------------------------------------------
const baEintrag = (ref, titel, firma, ort = 'München', tage = 3) => ({
  verguetungsangabe: 'JAHRESGEHALT', gehaltsspanneVon: 42000, gehaltsspanneBis: 48000, eintrittszeitraum: { von: '2027-03-01' },
  referenznummer: ref, stellenangebotsTitel: titel, firma: `${firma}   `, datumErsteVeroeffentlichung: vorTagen(tage),
  stellenlokationen: [{ adresse: { ort, region: 'BAYERN', land: 'DEUTSCHLAND' } }],
});
const euresEintrag = (id, title, firma, tage = 2, text = 'Aufgaben im Controlling: Reporting, Forecast und Abweichungsanalysen für das Werk. Bewerbung an jobs@beispielwerk.at.') => ({
  id, title, creationDate: JETZT - tage * 86_400_000, employer: { name: firma }, locationMap: { AT: ['AT332'] }, translations: { de: { title, description: `<p>${text}</p>` } },
});

/** Baut einen Abruf, der Arbeitsagentur und EURES nachbildet, und merkt sich alle Anfragen. */
function attrappe({ ba = {}, eures = {}, baFehler = null, kaputt = () => false } = {}) {
  const anfragen = [];
  const holen = async (url, init = {}) => {
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : null;
    anfragen.push({ url, kopf: init.headers, body });
    if (kaputt(url)) return antwort({ fehler: true }, 500);
    if (u.hostname === 'rest.arbeitsagentur.de' && u.pathname.endsWith('/v6/jobs')) {
      if (baFehler) return antwort({}, baFehler);
      const wo = u.searchParams.get('wo');
      if (wo === 'Wien') return antwort({ maxErgebnisse: 1, woOutput: { bereinigterOrt: 'Sien', suchmodus: 'UMKREISSUCHE' }, ergebnisliste: [baEintrag('X-1', 'Kauffrau', 'Kirn GmbH')] });
      if (wo === 'Paris') return antwort({ maxErgebnisse: 0, woOutput: { suchmodus: 'UNGUELTIG' } });
      const liste = ba[`${u.searchParams.get('was')}|${u.searchParams.get('angebotsart')}`] ?? [];
      return antwort({ maxErgebnisse: liste.length, woOutput: { bereinigterOrt: wo, suchmodus: 'UMKREISSUCHE' }, ergebnisliste: liste });
    }
    if (u.hostname === 'rest.arbeitsagentur.de' && u.pathname.includes('/v4/jobdetails/')) {
      const ref = atob(decodeURIComponent(u.pathname.split('/').pop()));
      return antwort({ referenznummer: ref, stellenangebotsBeschreibung: `**Aufgaben**\n\n- Monatsberichte und Soll-Ist-Vergleiche für ${ref}\n- Forecast und Budgetplanung\n\nBewerbung an karriere@firma-${ref.toLowerCase()}.de`, allianzpartnerName: 'Partnerportal', allianzpartnerUrl: 'https://partner.example/anzeige' });
    }
    if (u.hostname === 'europa.eu' && u.pathname.endsWith('/jv-search/search')) {
      const kw = body.keywords[0].keyword;
      const passt = eures[kw] ?? (body.keywords[0].specificSearchCode === 'TITLE' ? Object.entries(eures).find(([k]) => k.startsWith(kw))?.[1] : null);
      return antwort({ numberRecords: 1, jvs: passt ?? [] });
    }
    if (u.hostname === 'europa.eu' && u.pathname.includes('/jv/id/')) {
      const id = decodeURIComponent(u.pathname.split('/').pop());
      return antwort({ id, preferredLanguage: 'de', jvProfiles: { de: { description: `Volltext zu ${id}: Reporting, Forecast, Abweichungsanalysen und Kostenrechnung im Werk Innsbruck der Beispielwerk GmbH.`, locations: [{ cityName: 'Innsbruck' }], employer: { name: 'siehe Beschreibung' }, applicationInstructions: ['Bewerbung <b>per E-Mail</b>'], employmentPeriod: { startDate: Date.parse('2026-12-01') }, offeredRemunerationPackage: { salaries: [{ minimumSalary: 45738, currencyCode: 'EUR' }] }, personContacts: [{ communications: { emails: [{ uri: 'mailto:personal@beispielwerk.at' }] } }] } } });
    }
    return antwort({}, 404);
  };
  return { holen, anfragen };
}

// --- Attrappe der KI ----------------------------------------------------------------------------------------------
function kiAttrappe({ begriffe = ['Controller', 'Financial Analyst'], bewerte = null } = {}) {
  const zuege = [];
  const verbrauch = { model: 'claude-haiku-5-5', anfragen: 1, tokensEin: 1000, tokensAus: 300, suchen: 0, abrufe: 0, usd: 0.0003, ms: 5, stop: 'end_turn', werkzeugFehler: [], suchbegriffe: [] };
  return {
    zuege,
    zug: async (o) => {
      zuege.push(o);
      if (o.format.required.includes('begriffe')) return { ...verbrauch, text: JSON.stringify({ begriffe }) };
      const nummern = [...o.user.matchAll(/^### (\d+) \|/gm)].map((m) => Number(m[1]));
      const leads = (bewerte ?? ((n) => n.map((nr) => ({ nr }))))(nummern).map((l) => ({
        company: 'Von der KI', title: 'KI-Titel', location: 'KI-Ort', url: 'https://erfunden.example/x', source: 'KI', posted_at: '2020-01-01', deadline: 'keine', salary: 'unbekannt', kind: 'junior',
        apply_channel: 'email', apply_email: '', language: 'de', verified_online: false, summary: 'Kurz – knapp.', requirements: ['Studium'], keywords: [{ term: 'Excel', matched: true }],
        rolle: 30, lebenslauf: 10, chance: 20, ort: 10, chance_stufe: 'mittel', why_fit: 'Passt. Chance: mittel. Grund.', pre_info: '', ...l,
      }));
      return { ...verbrauch, text: JSON.stringify({ leads, abgelehnt: [] }) };
    },
    zugMitWerkzeugen: async (o) => {
      zuege.push({ ...o, websuche: true });
      return { ...verbrauch, usd: 0.3, suchen: 8, text: '', werkzeug: 'web_search_test' };
    },
  };
}
const PROFIL = { full_name: 'Lena Beispiel', cv_text: 'Erfundener Lebenslauf.', preferences: { zielrollen: 'Trainee Controlling, Junior Controller (m/w/d)', orte: ['Innsbruck', 'München'], land: 'AT', pro_tag: 3 } };

// --- Suchbegriffe und Orte ----------------------------------------------------------------------------------------
test('Suchbegriffe: Level-Wörter und (m/w/d) fallen weg, Schreibweise bleibt', () => {
  assert.deepEqual(Q.begriffeAusRollen('Trainee Controlling, Junior Controller (m/w/d); Business Analyst im Finanzbereich / FP&A'), ['Controlling', 'Controller', 'Business Analyst Finanzbereich', 'FP&A']);
  assert.deepEqual(Q.begriffeAusRollen(''), []);
  assert.deepEqual(Q.begriffeAusRollen(['Praktikum Marketing', 'Werkstudent Marketing']), ['Marketing']);
});

test('Suchbegriffe mischen: eigene zuerst, keine Doppelten, höchstens sechs, höchstens drei Wörter', () => {
  const b = Q.begriffeMischen(['Controlling'], ['controlling', 'Junior Controller', 'Finanzanalyst', 'A', 'Eins Zwei Drei Vier', 'B1x', 'C2x', 'D3x', '<script>']);
  assert.deepEqual(b, ['Controlling', 'Controller', 'Finanzanalyst', 'Eins Zwei Drei', 'B1x', 'C2x']);
});

test('Orte: Österreich geht an EURES, der Rest an die Arbeitsagentur, Reihenfolge bleibt', () => {
  const plan = Q.ortPlan(['Innsbruck', 'München', 'Remote', 'Wien', 'Hall in Tirol', 'Linz']);
  assert.deepEqual(plan.map((o) => [o.name, o.rang, o.quelle]), [['Innsbruck', 0, 'eures'], ['München', 1, 'ba'], ['Wien', 3, 'eures'], ['Hall in Tirol', 4, 'eures']]);
  assert.deepEqual([plan[0].nuts, plan[0].nah], [['at33'], ['at332']], 'Suche in ganz Tirol, nah ist die Region Innsbruck');
  assert.deepEqual([plan[2].nuts, plan[2].nah], [['at13', 'at12'], ['at130', 'at126', 'at127']], 'Wien mit Umland');
  assert.deepEqual(Q.ortPlan('Graz; Österreich; Tirol'), [{ name: 'Graz', rang: 0, quelle: 'eures', land: 'AT', nuts: ['at22'], nah: ['at221'] }, { name: 'Österreich', rang: 1, quelle: 'eures', land: 'AT', nuts: ['at'], nah: [] }, { name: 'Tirol', rang: 2, quelle: 'eures', land: 'AT', nuts: ['at33'], nah: [] }]);
  assert.deepEqual(Q.ortPlan('Zürich, Luzern, Schweiz').map((o) => [o.quelle, o.land, o.nuts]), [['eures', 'CH', ['ch04']], ['eures', 'CH', ['ch06']], ['eures', 'CH', ['ch']]]);
  assert.equal(Q.ortPlan('Freiburg', 'DE')[0].quelle, 'ba', 'Freiburg im Breisgau, nicht Fribourg');
  assert.equal(Q.regionName('CH040'), 'Zürich');
  assert.equal(Q.regionName('AT331'), 'Außerfern (Reutte)');
  assert.deepEqual(Q.ortPlan(undefined), []);
});

test('Klartext: HTML, Entitäten und Markdown raus', () => {
  assert.equal(Q.klartext('<p>Hallo&nbsp;<b>Welt</b></p><ul><li>**A**</li><li>B &amp; C</li></ul><script>x()</script>'), 'Hallo Welt\nA\nB & C\nx()');
  assert.equal(Q.klartext(null), '');
});

// --- Arbeitsagentur -----------------------------------------------------------------------------------------------
test('Arbeitsagentur: Felder sauber, Kennung in der Kopfzeile, Angebotsart wird gesendet', async () => {
  const { holen, anfragen } = attrappe({ ba: { 'Controller|34': [baEintrag('10001-1-S', 'Trainee Controlling (m/w/d)', 'Beispiel AG', 'Garching', 5)] } });
  const [k] = await Q.baSuche(holen, { was: 'Controller', wo: 'München', rang: 1, angebotsart: 34 });
  assert.deepEqual(k, { quelle: 'Arbeitsagentur', id: '10001-1-S', titel: 'Trainee Controlling (m/w/d)', firma: 'Beispiel AG', ort: 'Garching', land: 'DE', datum: vorTagen(5), url: 'https://www.arbeitsagentur.de/jobsuche/jobdetail/10001-1-S', beschreibung: '', mail: null, bewerbung: '', ortRang: 1, nah: true, gehalt: '42000 bis 48000 EUR pro Jahr', start: '2027-03-01', stufe: 1 });
  const u = new URL(anfragen[0].url);
  assert.deepEqual([u.searchParams.get('zeitarbeit'), u.searchParams.get('pav')], ['false', 'false'], 'ohne Zeitarbeit und private Vermittler');
  assert.equal(anfragen[0].kopf['X-API-Key'], 'jobboerse-jobsuche');
  assert.equal(u.searchParams.get('umkreis'), '40');
  assert.equal(u.searchParams.get('veroeffentlichtseit'), '28');
});

test('Arbeitsagentur: Auslandssuche Österreich ohne Umkreis, Treffer gelten als „nicht nah“', async () => {
  const { holen, anfragen } = attrappe({ ba: { 'Controller|1': [{ ...baEintrag('a1', 'Controller/in', 'Egger GmbH', 'Unterradlberg'), stellenlokationen: [{ adresse: { ort: 'Unterradlberg', land: 'ÖSTERREICH' } }] }] } });
  const [k] = await Q.baSuche(holen, { was: 'Controller', wo: 'Österreich', rang: 0, stufe: 2, landesweit: true });
  assert.equal(new URL(anfragen[0].url).searchParams.get('umkreis'), null);
  assert.deepEqual([k.land, k.nah, k.stufe], ['AT', false, 2]);
});

test('Arbeitsagentur: „verbesserte“ und unbekannte Orte werden abgelehnt statt falsch gesucht', async () => {
  const { holen } = attrappe();
  await assert.rejects(() => Q.baSuche(holen, { was: 'Controller', wo: 'Wien', rang: 0 }), /kennt die Arbeitsagentur nicht/);
  await assert.rejects(() => Q.baSuche(holen, { was: 'Controller', wo: 'Paris', rang: 0 }), /kennt die Arbeitsagentur nicht/);
});

// --- EURES --------------------------------------------------------------------------------------------------------
test('EURES: Suche im Titel und im Bundesland, anonyme Firma bleibt leer', async () => {
  const { holen, anfragen } = attrappe({ eures: { Controller: [euresEintrag('abc/1', 'Controller/in', 'siehe Beschreibung'), euresEintrag('abc2', 'Junior Controller', 'Tirolwerk GmbH')] } });
  const [anonym, offen] = await Q.euresSuche(holen, { was: 'Controller', nuts: ['at33'], rang: 0 });
  assert.deepEqual(anfragen[0].body.keywords, [{ keyword: 'Controll', specificSearchCode: 'TITLE' }], 'Wortanfang findet auch Controllerin und Controlling');
  assert.deepEqual(anfragen[0].body.locationCodes, ['at33']);
  assert.equal(anonym.firma, null);
  assert.equal(anonym.url, 'https://europa.eu/eures/portal/jv-se/jv-details/abc%2F1?lang=de');
  assert.equal(anonym.datum, vorTagen(2));
  assert.match(anonym.beschreibung, /^Aufgaben im Controlling/);
  assert.equal(offen.firma, 'Tirolwerk GmbH');
  assert.equal(anonym.ort, 'Region Innsbruck');
  assert.equal(anonym.nah, true);
  const [fern] = await Q.euresSuche(holen, { was: 'Controller', nuts: ['at33'], nah: ['at331'], rang: 0 });
  assert.equal(fern.nah, false, 'gleiches Bundesland, aber nicht die Region des Wunschorts');
  await Q.euresSuche(holen, { was: 'Power BI', nuts: ['at33'], rang: 0, imText: true });
  assert.deepEqual([anfragen.at(-1).body.keywords[0], anfragen.at(-1).body.sortSearch], [{ keyword: 'Power BI', specificSearchCode: 'EVERYWHERE' }, 'BEST_MATCH']);
  const [ch] = await Q.euresSuche(holen, { was: 'Controller', nuts: ['ch04'], rang: 0, land: 'CH' });
  assert.deepEqual([ch.quelle, ch.land], ['EURES', 'CH']);
});

test('Wortstamm: Endungen ab, kurze Wörter und Mehrwortbegriffe bleiben', () => {
  assert.deepEqual(['Controller', 'Controlling', 'Buchhaltung', 'Marketing', 'Analyst', 'Business Analyst', 'Einkäuferin'].map(Q.wortstamm), ['Controll', 'Controll', 'Buchhalt', 'Market', 'Analyst', 'Business Analyst', 'Einkäuf']);
});

// --- Sammeln ------------------------------------------------------------------------------------------------------
test('Sammeln: ohne Doppelte, alte Anzeigen raus, gleiches Gebiet nur einmal, Ausfälle als Hinweis', async () => {
  const { holen, anfragen } = attrappe({
    eures: { Controller: [euresEintrag('e1', 'Controller', 'A GmbH'), euresEintrag('alt', 'Controller', 'Alt GmbH', 60)], Controlling: [euresEintrag('e1', 'Controller', 'A GmbH')] },
    ba: { 'Controller|1': [baEintrag('b1', 'Junior Controller', 'B AG')], 'Controller|34': [baEintrag('b1', 'Junior Controller', 'B AG')] },
    kaputt: (url) => url.includes('was=Controlling&angebotsart=34'),
  });
  const r = await Q.sammle({ holen, begriffe: ['Controller', 'Controlling'], orte: Q.ortPlan(['Innsbruck', 'Hall in Tirol', 'München']), jetzt: JETZT });
  assert.deepEqual(r.kandidaten.map((k) => k.id).sort(), ['b1', 'e1']);
  // 2 EURES Titel (Innsbruck und Hall sind dasselbe Gebiet) + 2 BA + 2 BA Trainee + 2 EURES Volltext + 2 BA Österreich
  assert.equal(r.anfragen, 10);
  assert.equal(r.beantwortet, 9);
  assert.match(r.hinweise[0], /1 von 10 Anfragen ohne Ergebnis \(HTTP 500\)/);
  assert.equal(r.kandidaten.find((k) => k.id === 'e1').stufe, 1, 'Titeltreffer schlägt Volltexttreffer');
  assert.equal(r.kandidaten.find((k) => k.id === 'e1').imText, false);
  assert.equal(anfragen.filter((a) => a.url.includes('was=Controlling&angebotsart=34')).length, 2, 'ein zweiter Versuch bei 5xx');
});

test('Sammeln: Budget begrenzt die Zahl der Anfragen', async () => {
  const { holen, anfragen } = attrappe();
  const begriffe = ['A1x', 'B1x', 'C1x', 'D1x', 'E1x', 'F1x'];
  const verwandt = ['G1x', 'H1x', 'I1x', 'J1x', 'K1x', 'L1x'];
  const r = await Q.sammle({ holen, begriffe, verwandt, orte: Q.ortPlan(['München', 'Berlin', 'Hamburg', 'Köln']), jetzt: JETZT });
  assert.equal(r.anfragen, Q.GRENZEN.anfragen);
  assert.equal(anfragen.length, Q.GRENZEN.anfragen);
  assert.match(r.hinweise.join(' '), /12 Anfragen wegen Budget ausgelassen/, '24 Kern + 12 Trainee + 24 verwandt, 12 verwandte fallen weg');
  assert.ok(!anfragen.some((a) => /was=[G-L]1x/.test(a.url) && /wo=(Hamburg|K%C3%B6ln)/.test(a.url)), 'Kern vor verwandt: hinten wird abgeschnitten');
});

// --- Vorauswahl ---------------------------------------------------------------------------------------------------
test('Vorauswahl: Einstieg vor Leitung, bekannte Firmen raus, jede Firma einmal, Ausschlüsse zählen', () => {
  const k = (id, titel, firma, extra = {}) => ({ quelle: 'Arbeitsagentur', id, titel, firma, ort: 'München', land: 'DE', datum: vorTagen(3), url: `https://x/${id}`, beschreibung: '', mail: null, bewerbung: '', ortRang: 0, ...extra });
  const liste = [
    k('0', 'Fachbereichsleitung Controlling & Finanzen', 'Luft gGmbH'),
    k('01', 'Associate Director Controlling', 'Frisch SE'),
    k('1', 'Senior Controller', 'Gross AG'),
    k('2', 'Junior Controller (m/w/d)', 'Fein GmbH'),
    k('3', 'Controller Vertrieb Außendienst', 'Aussen KG'),
    k('4', 'Trainee Controlling', 'Bekannt GmbH'),
    k('5', 'Controller', 'Fein GmbH & Co. KG'),
    k('6', 'Ausbildung Industriekaufmann Controlling', 'Lehr AG'),
    k('7', 'Koch', 'Wirt GmbH'),
    k('8', 'Werkscontrollerin', null, { ortRang: 1, datum: vorTagen(20) }),
    k('9', 'Leiter Controlling', 'Chef AG'),
  ];
  const aus = Q.vorauswahl(liste, { begriffe: ['Controller', 'Controlling'], bekannt: ['Bekannt GmbH'], ausschluesse: 'Außendienst, Zeitarbeit', max: 10, jetzt: JETZT });
  assert.deepEqual(aus.map((x) => x.id), ['2', '8', '1'], 'Junior zuerst, dann Wortstamm, Senior als Reserve, Leitung nie');
  assert.ok(aus[0].punkte > aus[1].punkte && aus[1].punkte > aus[2].punkte);
  const breit = Q.vorauswahl([...liste, k('v1', 'Finanzbuchhalter', 'Buch AG'), k('v2', 'Sachbearbeiter', 'Text AG', { imText: true }), k('v3', 'Koch', 'Nur Titel AG')], { begriffe: ['Controller'], verwandt: ['Finanzbuchhaltung'], max: 20, jetzt: JETZT });
  assert.ok(breit.some((x) => x.id === 'v1'), 'verwandte Rolle über Wortstamm');
  assert.ok(breit.some((x) => x.id === 'v2'), 'Begriff nur im Anzeigentext');
  assert.ok(!breit.some((x) => x.id === 'v3'));
  assert.ok(breit.findIndex((x) => x.id === 'v1') > breit.findIndex((x) => x.id === '2'));
  const erfahren = Q.vorauswahl(liste, { begriffe: ['Controller', 'Controlling'], erfahren: true, max: 10, jetzt: JETZT });
  assert.ok(erfahren.some((x) => x.id === '1') && erfahren.some((x) => x.id === '9'), 'wer Leitung sucht, bekommt Leitung');
  assert.equal(Q.vorauswahl(liste, { begriffe: ['Controller'], max: 1, jetzt: JETZT }).length, 1);
  const mehr = [k('a', 'Praktikum Controlling', 'P AG'), k('b', 'Werkstudent Controlling', 'W AG'), k('c', 'Controller', 'Fern AG', { nah: false }), k('d', 'Controller', 'Nah AG', { datum: vorTagen(9) }), k('e', 'Controller', 'Frisch AG', { datum: vorTagen(6) })];
  assert.deepEqual(Q.vorauswahl(mehr, { begriffe: ['Controlling', 'Controller'], max: 10, jetzt: JETZT }).map((x) => x.id), ['a', 'e', 'd', 'c'], 'Praktikum ja, Werkstudent nein, nah vor fern, frisch vor alt');
  assert.deepEqual(Q.vorauswahl(mehr, { begriffe: ['Controlling'], praktikum: false, werkstudent: true, max: 10, jetzt: JETZT }).map((x) => x.id), ['b', 'e', 'd', 'c', 'a'], 'Werkstudent nur auf Wunsch, ungewolltes Praktikum ans Ende');
});

// --- Anreichern und Trefferliste ----------------------------------------------------------------------------------
test('Anreichern: Volltext, Ort und Kontakt kommen aus den Details, Anzeigen ohne Text fallen raus', async () => {
  const { holen } = attrappe({ kaputt: (url) => url.includes(encodeURIComponent(btoa('weg'))) });
  const basis = { ort: null, land: 'AT', datum: vorTagen(1), url: 'https://x', beschreibung: '', mail: null, bewerbung: '', ortRang: 0 };
  const r = await Q.anreichern(holen, [
    { ...basis, quelle: 'Arbeitsagentur', id: 'REF-9', titel: 'Junior Controller', firma: 'B AG', land: 'DE' },
    { ...basis, quelle: 'EURES (AMS)', id: 'e1', titel: 'Controller/in', firma: null },
    { ...basis, quelle: 'Arbeitsagentur', id: 'weg', titel: 'Controller', firma: 'Weg AG', land: 'DE' },
  ]);
  assert.equal(r.fehlgeschlagen, 1);
  assert.equal(r.kandidaten.length, 2);
  const [ba, eures] = r.kandidaten;
  assert.match(ba.beschreibung, /^Aufgaben\n- Monatsberichte/);
  assert.equal(ba.mail, 'karriere@firma-ref-9.de');
  assert.match(ba.bewerbung, /Partnerportal: https:\/\/partner\.example\/anzeige/);
  assert.equal(eures.ort, 'Innsbruck');
  assert.equal(eures.mail, 'personal@beispielwerk.at');
  assert.equal(eures.firma, null, '„siehe Beschreibung“ ist kein Firmenname');
  assert.equal(eures.bewerbung, 'Bewerbung per E-Mail');
  assert.equal(eures.gehalt, 'mindestens 45738 EUR laut Anzeige');
  assert.equal(eures.start, '2026-12-01');
  assert.equal(ba.bewerbung.includes('arbeitsagentur.de'), false);
});

test('Trefferliste: nummeriert, mit Link und gekürztem Anzeigentext', () => {
  const text = Q.trefferliste([{ quelle: 'EURES (AMS)', id: 'e1', titel: 'Controller/in', firma: null, ort: 'Innsbruck', land: 'AT', datum: '2026-11-14', url: 'https://europa.eu/x', beschreibung: 'x'.repeat(2000), mail: 'a@b.at', bewerbung: '', ortRang: 0, gehalt: 'mindestens 45738 EUR laut Anzeige', start: '2026-12-01' }]);
  assert.match(text, /^### 1 \| Firma steht im Text \| Controller\/in\nOrt: Innsbruck \(AT\)\nLink: https:\/\/europa\.eu\/x\nQuelle: EURES \(AMS\)\nVeröffentlicht: 2026-11-14\nBewerbungsweg: E-Mail \(a@b\.at\)\nOnline geprüft: ja\nGehalt: mindestens 45738 EUR laut Anzeige\nStart laut Anzeige: 2026-12-01\nAnzeigentext: x+ …$/);
  assert.ok(text.length < Q.GRENZEN.beschreibung + 300);
});

// --- Bewertung zu Treffern ----------------------------------------------------------------------------------------
test('Treffer: Fakten kommen aus der Quelle, nicht von der KI', () => {
  const kandidaten = [
    { quelle: 'Arbeitsagentur', id: 'b1', titel: 'Junior Controller', firma: 'B AG', ort: 'München', land: 'DE', datum: '2026-11-12', url: 'https://www.arbeitsagentur.de/jobsuche/jobdetail/b1', beschreibung: 'x', mail: 'jobs@b.de', bewerbung: '', ortRang: 0 },
    { quelle: 'EURES (AMS)', id: 'e1', titel: 'Controller/in', firma: null, ort: 'Innsbruck', land: 'AT', datum: '2026-11-14', url: 'https://europa.eu/e1', beschreibung: 'x', mail: null, bewerbung: '', ortRang: 0 },
  ];
  const ki = (extra) => ({ company: 'Erfunden AG', title: 'Erfundener Titel', location: 'Erfunden', url: 'https://erfunden.example', source: 'KI', posted_at: '2020-01-01', deadline: 'keine', salary: '', apply_channel: 'email', apply_email: '', language: 'de', verified_online: false, summary: 'S – s', requirements: ['a'], keywords: [], rolle: 30, lebenslauf: 10, chance: 20, ort: 10, why_fit: 'w', pre_info: '', ...extra });
  const leads = leadsAusBewertung([ki({ nr: 1 }), ki({ nr: 2, company: 'Tirolwerk GmbH', rolle: 35 }), ki({ nr: 7 }), ki({ nr: 0, url: 'https://europa.eu/e1', company: 'Doppelt GmbH' })], { kandidaten });
  assert.equal(leads.length, 3, 'Nummer 7 gab es nie');
  const [eures, ba] = leads;
  assert.deepEqual([ba.company, ba.title, ba.location, ba.url, ba.source, ba.posted_at, ba.apply_email, ba.apply_channel], ['B AG', 'Junior Controller', 'München', 'https://www.arbeitsagentur.de/jobsuche/jobdetail/b1', 'Arbeitsagentur', '2026-11-12', 'jobs@b.de', 'email']);
  assert.deepEqual([eures.company, eures.url, eures.location, eures.apply_channel], ['Tirolwerk GmbH', 'https://europa.eu/e1', 'Innsbruck', 'portal'], 'Firma aus dem Text darf die KI nennen, den Rest nicht');
  assert.equal(ba.pre_info, null, 'kein „nicht geprüft“-Hinweis bei Anzeigen aus der Quelle');
  assert.equal(ba.summary, 'S, s');
  assert.equal(leadsAusBewertung([ki({ nr: 2, company: 'unbekannt' })], { kandidaten }).length, 0, 'ohne Firmennamen kein Treffer');
});

test('Abgeschnittene Bewertung: vollständige Treffer bleiben erhalten', () => {
  const voll = JSON.stringify({ leads: [{ nr: 1, company: 'A', keywords: [{ term: 'x', matched: true }], why_fit: 'a' }, { nr: 2, company: 'B', keywords: [{ term: 'y', matched: false }], why_fit: 'b' }, { nr: 3, company: 'C', keywords: [], why_fit: 'lang' }], abgelehnt: [] });
  const schnitt = voll.slice(0, voll.indexOf('"company":"C"') + 8);
  assert.deepEqual(retteLeads(schnitt).leads.map((l) => l.nr), [1, 2]);
  assert.equal(retteLeads('{"leads":[{"nr":1,"comp'), null);
  assert.equal(retteLeads(''), null);
});

// --- Scout von Anfang bis Ende ------------------------------------------------------------------------------------
test('Scout: Treffer aus den Quellen, ohne Websuche, für Bruchteile eines Cents', async () => {
  const { holen, anfragen } = attrappe({
    eures: { Controller: [euresEintrag('e1', 'Junior Controller', 'Tirolwerk GmbH'), euresEintrag('e2', 'Controller/in', 'Alpen AG'), euresEintrag('e3', 'Senior Controller', 'Gross AG')] },
    ba: { 'Controlling|34': [baEintrag('b1', 'Trainee Controlling', 'Isar AG')], 'Controller|1': [baEintrag('b2', 'Junior Controller', 'Schon Da GmbH')] },
  });
  const ki = kiAttrappe({ bewerte: (nummern) => nummern.map((nr) => ({ nr, rolle: 35 - nr })) });
  const r = await scout({ claude: ki, profil: PROFIL, bekannt: ['Schon Da GmbH'], holen, cfg: { heute: '2026-11-16', webErgaenzung: false } });
  assert.equal(r.werkzeug, 'quellen');
  assert.equal(r.leads.length, 3, 'pro_tag 3 begrenzt die Treffer');
  assert.ok(r.leads.every((l) => /^https:\/\/(europa\.eu|www\.arbeitsagentur\.de)\//.test(l.url)));
  assert.ok(!r.leads.some((l) => l.company === 'Schon Da GmbH'));
  assert.ok(!ki.zuege.some((z) => z.websuche), 'keine Websuche');
  assert.equal(ki.zuege.length, 2, 'ein Suchplan, eine Bewertung');
  assert.ok(r.nutzung.usd < 0.01);
  assert.ok(ki.zuege[1].user.includes('### 1 | Tirolwerk GmbH | Junior Controller'));
  assert.match(ki.zuege[1].user, /Gib 4 davon in leads aus/, 'alle 4, weil 3 + 4 mehr als die Liste hat');
  assert.ok(!ki.zuege[1].user.includes('Schon Da GmbH'));
  assert.match(r.hinweise.join('\n'), /Quellen: \d+ Anfragen \(Controlling · Controller · Financial Analyst in Innsbruck, München\), 5 Anzeigen, 4 in der Bewertung/);
  assert.ok(anfragen.length <= Q.GRENZEN.anfragen + 28);
});

test('Scout: Liste wird voll, in der Reihenfolge passt, ähnlich oder anspruchsvoller, leichter', async () => {
  const { holen } = attrappe({ eures: { Controller: [euresEintrag('e1', 'Junior Controller', 'Tirolwerk GmbH'), euresEintrag('e2', 'Controller/in', 'Alpen AG'), euresEintrag('e3', 'Controller', 'Berg AG')] } });
  const ki = kiAttrappe({ bewerte: () => [{ nr: 1, passung: 'leichter', rolle: 35 }, { nr: 2, passung: 'anspruchsvoller', rolle: 10, chance: 5 }, { nr: 3, passung: 'passt', rolle: 20 }] });
  const r = await scout({ claude: ki, profil: PROFIL, holen, cfg: { webErgaenzung: false } });
  assert.deepEqual(r.leads.map((l) => l.company), ['Berg AG', 'Alpen AG', 'Tirolwerk GmbH'], 'auch niedrige Punkte kommen durch, Stufe vor Punkten');
  assert.match(r.leads[1].why_fit, /^Anspruchsvoller: /);
  assert.match(r.leads[2].why_fit, /^Leichter als das Profil: /);
  assert.equal(JSON.stringify(r.leads[0]).includes('stufe'), false, 'Stufe landet nicht in der Datenbank');
  assert.match(ki.zuege[0].system, /verwandt/);
});

test('Scout: fehlen Treffer, ergänzt eine kleine Websuche, ohne Abrufe und ohne Nachdenken', async () => {
  const { holen } = attrappe({ eures: { Controller: [euresEintrag('e1', 'Junior Controller', 'Tirolwerk GmbH')] } });
  const ki = kiAttrappe();
  const web = [];
  ki.zugMitWerkzeugen = async (o, tools) => {
    web.push({ o, tools });
    return { model: 'h', anfragen: 1, tokensEin: 5000, tokensAus: 500, tokensDenken: 0, suchen: 4, abrufe: 0, usd: 0.045, ms: 5, stop: 'end_turn', werkzeugFehler: [], suchbegriffe: ['a'], werkzeug: 'web_search_test',
      text: '### 1 | Webfirma GmbH | Junior Controller\nOrt: Innsbruck\nLink: https://karriere.example/1\nOnline geprüft: nein' };
  };
  const r = await scout({ claude: ki, profil: { ...PROFIL, preferences: { ...PROFIL.preferences, pro_tag: 5 } }, holen });
  assert.equal(web.length, 1);
  assert.match(web[0].o.system, /Bis zu 4 Suchen/);
  assert.match(web[0].o.system, /Ziel sind 4 gute Treffer/);
  assert.equal(web[0].o.aufwand, 'low');
  assert.notEqual(web[0].o.denken, false, 'mit Suchwerkzeug nicht ganz ohne Nachdenken');
  assert.match(web[0].o.user, /karriere\.at, StepStone, LinkedIn Jobs/);
  assert.match(web[0].o.user, /SCHON BEKANNT[^]*Tirolwerk GmbH/, 'Quellen-Treffer nicht doppelt');
  assert.equal(r.werkzeug, 'quellen+web');
  assert.match(r.hinweise.join('\n'), /Websuche ergänzt 4 fehlende Treffer/);
  assert.deepEqual(r.leads.map((l) => l.company), ['Tirolwerk GmbH', 'Von der KI']);

  const ki2 = kiAttrappe();
  ki2.zugMitWerkzeugen = async () => { throw new Error('Netz weg'); };
  const r2 = await scout({ claude: ki2, profil: PROFIL, holen });
  assert.equal(r2.leads.length, 1, 'Fehler der Ergänzung kostet die Quellen-Treffer nicht');
  assert.match(r2.hinweise.join('\n'), /Websuche zur Ergänzung fehlgeschlagen \(Netz weg\)/);

  const ki3 = kiAttrappe();
  await scout({ claude: ki3, profil: { ...PROFIL, preferences: { ...PROFIL.preferences, pro_tag: 2 } }, holen });
  assert.ok(!ki3.zuege.some((z) => z.websuche), 'ein einzelner fehlender Treffer lohnt keine Websuche');
});

test('Scout: Ort außerhalb der Quellen oder Ausfall führt zur Websuche als Reserve', async () => {
  const { holen } = attrappe();
  const ki = kiAttrappe();
  const r = await scout({ claude: ki, profil: { ...PROFIL, preferences: { ...PROFIL.preferences, orte: ['Paris'] } }, holen });
  assert.ok(ki.zuege.some((z) => z.websuche));
  assert.match(r.hinweise.join('\n'), /kennt die Arbeitsagentur nicht/);
  assert.match(r.hinweise.join('\n'), /Websuche als Reserve/);
  assert.equal(r.werkzeug, 'web_search_test');

  const aus = attrappe({ baFehler: 403, kaputt: (url) => url.includes('europa.eu') });
  const ki2 = kiAttrappe();
  await scout({ claude: ki2, profil: PROFIL, holen: aus.holen });
  assert.ok(ki2.zuege.some((z) => z.websuche), 'beide Quellen ausgefallen');

  const ki3 = kiAttrappe();
  await scout({ claude: ki3, profil: PROFIL, holen: aus.holen, cfg: { websucheWennLeer: false } });
  assert.ok(!ki3.zuege.some((z) => z.websuche), 'Reserve lässt sich abschalten');
});

test('Scout: fällt der Suchplan der KI aus, reichen die Begriffe aus den Zielrollen', async () => {
  const { holen } = attrappe({ eures: { Controller: [euresEintrag('e1', 'Junior Controller', 'Tirolwerk GmbH')] } });
  const ki = kiAttrappe();
  const zug = ki.zug;
  ki.zug = async (o) => { if (o.format.required.includes('begriffe')) throw new Error('überlastet'); return zug(o); };
  const r = await scout({ claude: ki, profil: PROFIL, holen });
  assert.equal(r.leads.length, 1);
  assert.match(r.hinweise.join('\n'), /Suchplan ohne KI \(überlastet\)/);
});
