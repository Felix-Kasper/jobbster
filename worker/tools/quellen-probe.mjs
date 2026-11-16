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
    console.log(kurz(text, 300));
    try { return JSON.parse(text); } catch { return null; }
  } catch (e) {
    console.log(`\n== ${name}\nFEHLER ${e.name}: ${e.message}`);
    return null;
  }
}

const BA = 'https://rest.arbeitsagentur.de/jobboerse/jobsuche-service';
const baKopf = { headers: { 'X-API-Key': 'jobboerse-jobsuche' } };
const q = (o) => new URLSearchParams(o).toString();

const liste = (r) => (r?.ergebnisliste || []).map((s) => `${s.firma} | ${s.stellenangebotsTitel} | ${(s.stellenlokationen || []).map((l) => `${l.adresse?.ort} ${l.adresse?.land ?? ''}`).join('+')}`).join(' ;; ');
const m = await probe('BA v6 München Controller', `${BA}/pc/v6/jobs?${q({ was: 'Junior Controller', wo: 'München', umkreis: 25, size: 5, veroeffentlichtseit: 28, angebotsart: 1 })}`, baKopf);
console.log('SCHLÜSSEL oben:', Object.keys(m ?? {}).join(','), 'gesamt:', m?.maxErgebnisse);
console.log('EINTRAG:', JSON.stringify(m?.ergebnisliste?.[0] ?? null));
console.log(liste(m));
for (const [was, wo, umkreis] of [['Controller', 'Innsbruck', 50], ['Controlling', 'Wien', 25], ['Trainee Controlling', 'München', 50], ['Controller', 'Österreich', 0]]) {
  const r = await probe(`BA v6 ${was} in ${wo}`, `${BA}/pc/v6/jobs?${q({ was, wo, ...(umkreis ? { umkreis } : {}), size: 6, veroeffentlichtseit: 28 })}`, baKopf);
  console.log('gesamt:', r?.maxErgebnisse, 'woOutput:', JSON.stringify(r?.woOutput), '\n', liste(r));
}
const ref = m?.ergebnisliste?.[0]?.referenznummer;
if (ref) {
  const b64 = Buffer.from(ref).toString('base64');
  for (const v of ['v4', 'v6', 'v5']) {
    const d = await probe(`BA Details ${v}`, `${BA}/pc/${v}/jobdetails/${b64}`, baKopf);
    if (d) { console.log('DETAIL-SCHLÜSSEL:', Object.keys(d).join(',')); console.log('DETAIL:', JSON.stringify(d).slice(0, 3000)); break; }
  }
}

await probe('AMS Suche', `https://jobs.ams.at/public/emps/api/search?${q({ page: 1, query: 'Controller', location: 'Innsbruck', sortField: '_SCORE' })}`);
const amsSeite = await fetch('https://jobs.ams.at/public/emps/jobs?query=Controller&location=Innsbruck', { headers: { 'User-Agent': UA } }).then(async (r) => ({ status: r.status, cookies: r.headers.getSetCookie?.() ?? [], text: await r.text() })).catch((e) => ({ status: 0, cookies: [], text: e.message }));
console.log('\n== AMS Seite', amsSeite.status, amsSeite.text.length, 'Cookies:', amsSeite.cookies.map((c) => c.split('=')[0]).join(','), '\nSkripte:', [...amsSeite.text.matchAll(/src="([^"]+\.js[^"]*)"/g)].map((x) => x[1]).slice(0, 8).join(' '), '\nAPI-Hinweise:', [...new Set([...amsSeite.text.matchAll(/["'](\/public\/emps\/api[^"']*)["']/g)].map((x) => x[1]))].join(' '));

const eures = { resultsPerPage: 5, page: 1, sortSearch: 'MOST_RECENT', keywords: [{ keyword: 'Controller', specificSearchCode: 'EVERYWHERE' }], publicationPeriod: null, occupationUris: [], skillUris: [], requiredExperienceCodes: [], positionScheduleCodes: [], sectorCodes: [], educationAndQualificationLevelCodes: [], positionOfferingCodes: [], locationCodes: ['at'], euresFlagCodes: [], otherBenefitsCodes: [], requiredLanguages: [], minNumberPost: null, sessionId: 'jobbster-probe' };
for (const u of ['https://europa.eu/eures/api/jv-searchengine/public/jv-search/search', 'https://europa.eu/eures/eures-apps/searchengine/page/jv-search/search?lang=de', 'https://europa.eu/eures/portal/jv-se/api/jv-search/search']) {
  const e = await probe(`EURES ${u.slice(22, 70)}`, u, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(eures) });
  if (e) { console.log('SCHLÜSSEL:', Object.keys(e).join(','), 'gesamt:', e.numberRecords, '\nEINTRAG:', JSON.stringify(e.jvs?.[0] ?? null).slice(0, 2500)); break; }
}

const a = await probe('Arbeitnow', 'https://www.arbeitnow.com/api/job-board-api?page=1');
console.log('Felder:', Object.keys(a?.data?.[0] ?? {}).join(','), 'Anzahl:', a?.data?.length, 'Orte:', [...new Set((a?.data || []).map((x) => x.location))].slice(0, 15).join(' | '));
