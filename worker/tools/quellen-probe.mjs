// Jobbster · Diagnose: Welche Stellen-Schnittstellen antworten von hier aus, und was liefern sie?
// Start: node worker/tools/quellen-probe.mjs   (kein Schlüssel nötig, schreibt nichts)
const UA = 'Jobbster/1.0 (+https://github.com/Felix-Kasper/jobbster)';
const kurz = (s, n = 700) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n);

async function probe(name, url, init = {}) {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { ...init, headers: { 'User-Agent': UA, Accept: 'application/json', ...(init.headers || {}) }, signal: AbortSignal.timeout(20_000) });
    const text = await res.text();
    console.log(`\n== ${name}\n${res.status} ${res.headers.get('content-type')} ${text.length} Zeichen, ${Date.now() - t0} ms`);
    console.log(kurz(text));
    try { return JSON.parse(text); } catch { return null; }
  } catch (e) {
    console.log(`\n== ${name}\nFEHLER ${e.name}: ${e.message}`);
    return null;
  }
}

const BA = 'https://rest.arbeitsagentur.de/jobboerse/jobsuche-service';
const baKopf = { headers: { 'X-API-Key': 'jobboerse-jobsuche' } };
const q = (o) => new URLSearchParams(o).toString();

const m = await probe('BA München Controller', `${BA}/pc/v4/jobs?${q({ was: 'Controller', wo: 'München', umkreis: 25, size: 5, veroeffentlichtseit: 30, angebotsart: 1 })}`, baKopf);
console.log('Felder:', JSON.stringify(m?.stellenangebote?.[0] ?? null), 'gesamt:', m?.maxErgebnisse);
const i = await probe('BA Innsbruck Controller', `${BA}/pc/v4/jobs?${q({ was: 'Controller', wo: 'Innsbruck', umkreis: 50, size: 5, veroeffentlichtseit: 30 })}`, baKopf);
console.log('gesamt:', i?.maxErgebnisse, (i?.stellenangebote || []).map((s) => `${s.arbeitgeber} | ${s.titel} | ${s.arbeitsort?.ort} ${s.arbeitsort?.land}`).join(' ;; '));
await probe('BA Trainee Controlling ohne Ort Österreich', `${BA}/pc/v4/jobs?${q({ was: 'Controlling', arbeitsort: 'Österreich', size: 3 })}`, baKopf);
await probe('BA app-Pfad', `${BA}/pc/v4/app/jobs?${q({ was: 'Junior Controller', wo: 'München', size: 2 })}`, baKopf);
const ref = m?.stellenangebote?.[0]?.refnr;
if (ref) {
  const b64 = Buffer.from(ref).toString('base64');
  await probe('BA Details v4', `${BA}/pc/v4/jobdetails/${b64}`, baKopf);
  await probe('BA Details v2', `${BA}/pc/v2/jobdetails/${b64}`, baKopf);
  await probe('BA Details v3', `${BA}/pc/v3/jobdetails/${b64}`, baKopf);
}

await probe('AMS Suche A', `https://jobs.ams.at/public/emps/api/search?${q({ page: 1, query: 'Controller', location: 'Innsbruck', sortField: '_SCORE' })}`);
await probe('AMS Suche B', `https://jobs.ams.at/public/emps/api/search?${q({ page: 1, query: 'Controller', location: 'Innsbruck' })}`, { headers: { 'X-Requested-With': 'XMLHttpRequest', Referer: 'https://jobs.ams.at/public/emps/jobs' } });

const eures = { resultsPerPage: 5, page: 1, sortSearch: 'MOST_RECENT', keywords: [{ keyword: 'Controller', specificSearchCode: 'EVERYWHERE' }], publicationPeriod: null, occupationUris: [], skillUris: [], requiredExperienceCodes: [], positionScheduleCodes: [], sectorCodes: [], educationAndQualificationLevelCodes: [], positionOfferingCodes: [], locationCodes: ['at'], euresFlagCodes: [], otherBenefitsCodes: [], requiredLanguages: [], minNumberPost: null, sessionId: 'jobbster-probe' };
const e = await probe('EURES Österreich Controller', 'https://europa.eu/eures/eures-apps/searchengine/page/jv-search/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(eures) });
console.log('Felder:', JSON.stringify(e?.jvs?.[0] ?? null)?.slice(0, 1500), 'gesamt:', e?.numberRecords);
await probe('EURES Tirol (at33)', 'https://europa.eu/eures/eures-apps/searchengine/page/jv-search/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...eures, locationCodes: ['at33'] }) });

const a = await probe('Arbeitnow', 'https://www.arbeitnow.com/api/job-board-api?page=1');
console.log('Felder:', Object.keys(a?.data?.[0] ?? {}).join(','), 'Anzahl:', a?.data?.length, 'Orte:', [...new Set((a?.data || []).map((x) => x.location))].slice(0, 15).join(' | '));
