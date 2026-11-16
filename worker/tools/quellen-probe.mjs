// Jobbster · Diagnose: Welche Stellen-Schnittstellen antworten von hier aus, und was liefern sie?
// Start: node worker/tools/quellen-probe.mjs   (kein Schlüssel nötig, schreibt nichts)
const UA = 'Jobbster/1.0 (+https://github.com/Felix-Kasper/jobbster)';
const kurz = (s, n = 300) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n);

async function probe(name, url, init = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { ...init, headers: { 'User-Agent': UA, Accept: 'application/json', ...(init.headers || {}) }, signal: AbortSignal.timeout(20_000) });
    const text = await res.text();
    console.log(`\n== ${name}\n${res.status} ${res.headers.get('content-type')} ${text.length} Zeichen, ${Date.now() - t0} ms`);
    try { return JSON.parse(text); } catch { console.log(kurz(text)); return null; }
  } catch (e) {
    console.log(`\n== ${name}\nFEHLER ${e.name}: ${e.message}`);
    return null;
  }
}

const EURES = 'https://europa.eu/eures/api/jv-searchengine/public';
const basis = { resultsPerPage: 8, page: 1, sortSearch: 'BEST_MATCH', keywords: [], publicationPeriod: null, occupationUris: [], skillUris: [], requiredExperienceCodes: [], positionScheduleCodes: [], sectorCodes: [], educationAndQualificationLevelCodes: [], positionOfferingCodes: [], locationCodes: [], euresFlagCodes: [], otherBenefitsCodes: [], requiredLanguages: [], minNumberPost: null, sessionId: 'jobbster-probe' };
const suche = (name, extra) => probe(`EURES ${name}`, `${EURES}/jv-search/search`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...basis, ...extra }) });
const zeile = (j) => `${j.employer?.name ?? j.employerName ?? '?'} | ${j.title} | ${JSON.stringify(j.locationMap ?? j.locations ?? null)} | ${j.creationDate ?? j.publicationDate ?? ''}`;
const kw = (k, code = 'EVERYWHERE') => [{ keyword: k, specificSearchCode: code }];

const a = await suche('Controller in at, EVERYWHERE', { keywords: kw('Controller'), locationCodes: ['at'] });
const erster = a?.jvs?.[0];
if (erster) {
  const ohne = { ...erster, description: kurz(erster.description, 200) };
  console.log('SCHLÜSSEL:', Object.keys(erster).join(','), '\nEINTRAG:', JSON.stringify(ohne).slice(0, 2500));
}
console.log('gesamt:', a?.numberRecords, '\n' + (a?.jvs || []).map(zeile).join('\n'));
console.log('FACETTEN:', JSON.stringify(a?.facets ?? null).slice(0, 1500));

for (const code of ['TITLE', 'JOB_TITLE', 'TITLE_ONLY']) {
  const r = await suche(`Controller in at, ${code}`, { keywords: kw('Controller', code), locationCodes: ['at'] });
  console.log('gesamt:', r?.numberRecords, '\n' + (r?.jvs || []).slice(0, 5).map(zeile).join('\n'));
}
for (const [name, k, orte] of [['Junior Controller Tirol at33', 'Junior Controller', ['at33']], ['Controlling Innsbruck at332', 'Controlling', ['at332']], ['Controller AT33 gross', 'Controller', ['AT33']], ['Controller München de212', 'Controller', ['de212']], ['Trainee Controlling Oberbayern de21', 'Trainee Controlling', ['de21']], ['Controller Tirol+Oberbayern', 'Controller', ['at33', 'de21']]]) {
  const r = await suche(name, { keywords: kw(k), locationCodes: orte });
  console.log('gesamt:', r?.numberRecords, '\n' + (r?.jvs || []).slice(0, 6).map(zeile).join('\n'));
}
const neu = await suche('Controller at33, neueste, letzte Woche', { keywords: kw('Controller'), locationCodes: ['at33'], sortSearch: 'MOST_RECENT', publicationPeriod: 'LAST_WEEK' });
console.log('gesamt:', neu?.numberRecords, '\n' + (neu?.jvs || []).slice(0, 5).map(zeile).join('\n'));

if (erster?.id) {
  for (const u of [`${EURES}/jv/id/${erster.id}?lang=de`, `${EURES}/jv/id/${erster.id}`, `${EURES}/jv-details/${erster.id}?lang=de`]) {
    const d = await probe(`EURES Details ${u.slice(EURES.length, EURES.length + 30)}`, u);
    if (d) { console.log('DETAIL-SCHLÜSSEL:', Object.keys(d).join(',')); console.log(JSON.stringify(d).replace(/"description":"[^"]{300,}?"/g, '"description":"…"').slice(0, 4000)); break; }
  }
}
