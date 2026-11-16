// Vorübergehend: erkundet weitere Quellen und freie Domains. Wird nach der Auswertung wieder entfernt.
const kurz = (s, n = 400) => String(s ?? '').replace(/\s+/g, ' ').slice(0, n);
async function hol(name, url, init = {}) {
  try {
    const r = await fetch(url, { ...init, headers: { 'User-Agent': 'Jobbster/1.0', Accept: 'application/json', ...(init.headers || {}) }, signal: AbortSignal.timeout(20000) });
    const t = await r.text();
    let j = null; try { j = JSON.parse(t); } catch {}
    console.log(`\n== ${name}: ${r.status} ${r.headers.get('content-type')} ${t.length} Zeichen`);
    if (!j) console.log(kurz(t, 200));
    return { status: r.status, j, t, kopf: r.headers };
  } catch (e) { console.log(`\n== ${name}: FEHLER ${e.message}`); return { status: 0, j: null, t: '' }; }
}

// --- Domains (RDAP: 404 = frei) ---
const rdap = { com: 'https://rdap.verisign.com/com/v1/domain/', net: 'https://rdap.verisign.com/net/v1/domain/', de: 'https://rdap.denic.de/domain/', at: 'https://rdap.nic.at/domain/', io: 'https://rdap.identitydigital.services/rdap/domain/', app: 'https://pubapi.registry.google/rdap/domain/', ai: 'https://rdap.identitydigital.services/rdap/domain/', co: 'https://rdap.registry.co/co/domain/', jobs: 'https://rdap.org/domain/' };
const namen = ['jobbster', 'jobstar', 'jobbstar', 'getjobbster', 'jobbster-app', 'joinjobbster', 'jobbsta', 'jobbzter'];
for (const n of namen) {
  const zeile = [];
  for (const [tld, basis] of Object.entries(rdap)) {
    if (!['jobbster', 'jobstar', 'jobbstar'].includes(n) && !['com', 'de', 'at', 'app'].includes(tld)) continue;
    const s = await fetch(`${basis}${n}.${tld}`, { headers: { Accept: 'application/rdap+json' }, signal: AbortSignal.timeout(15000) }).then((r) => r.status).catch((e) => `x(${e.message.slice(0, 20)})`);
    zeile.push(`.${tld}=${s === 404 ? 'FREI' : s === 200 ? 'vergeben' : s}`);
  }
  console.log(`DOMAIN ${n}: ${zeile.join('  ')}`);
}

// --- Repo öffentlich? ---
const repo = await fetch('https://api.github.com/repos/Felix-Kasper/jobbster', { headers: { 'User-Agent': 'x' } }).then((r) => r.status).catch(() => 0);
console.log(`\nREPO ohne Anmeldung: ${repo} (200 = öffentlich, 404 = privat)`);
const pages = await fetch('https://felix-kasper.github.io/jobbster/', { redirect: 'manual' }).then((r) => r.status).catch(() => 0);
console.log(`PAGES: ${pages}`);

// --- Arbeitnow ---
const a = await hol('Arbeitnow Seite 1', 'https://www.arbeitnow.com/api/job-board-api?page=1');
if (a.j) {
  const d = a.j.data ?? [];
  console.log('Felder:', Object.keys(d[0] ?? {}).join(','), '| Anzahl:', d.length, '| links:', JSON.stringify(a.j.links), '| meta:', JSON.stringify(a.j.meta)?.slice(0, 200));
  console.log('Beispiel:', JSON.stringify({ ...d[0], description: kurz(d[0]?.description, 120) }));
  console.log('Controlling/Finance:', d.filter((x) => /controll|financ|accounting|buchhalt/i.test(x.title)).map((x) => `${x.company_name} | ${x.title} | ${x.location}`).slice(0, 8).join(' ;; '));
  console.log('München:', d.filter((x) => /münchen|munich/i.test(x.location)).length, 'Österreich:', d.filter((x) => /wien|vienna|austria|österreich|graz|linz|innsbruck|salzburg/i.test(x.location)).length, 'ältester:', new Date(Math.min(...d.map((x) => x.created_at)) * 1000).toISOString().slice(0, 10));
}
for (const p of ['?search=controller', '?page=1&search=controlling&location=munich', '?q=controller']) { const r = await hol(`Arbeitnow ${p}`, `https://www.arbeitnow.com/api/job-board-api${p}`); console.log('Titel:', (r.j?.data ?? []).slice(0, 5).map((x) => x.title).join(' | ')); }

// --- EURES: Schweiz, Deutschland, Stichwort im Text ---
const EURES = 'https://europa.eu/eures/api/jv-searchengine/public/jv-search/search';
const basis = { resultsPerPage: 6, page: 1, sortSearch: 'MOST_RECENT', publicationPeriod: null, occupationUris: [], skillUris: [], requiredExperienceCodes: [], positionScheduleCodes: [], sectorCodes: [], educationAndQualificationLevelCodes: [], positionOfferingCodes: [], euresFlagCodes: [], otherBenefitsCodes: [], requiredLanguages: [], minNumberPost: null, sessionId: 'jobbster' };
const eu = async (name, keyword, code, orte, extra = {}) => {
  const r = await hol(`EURES ${name}`, EURES, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...basis, keywords: [{ keyword, specificSearchCode: code }], locationCodes: orte, ...extra }) });
  console.log('gesamt:', r.j?.numberRecords, '|', (r.j?.jvs ?? []).map((j) => `${j.employer?.name} / ${j.title} / ${JSON.stringify(j.locationMap)}`).join(' ;; ').slice(0, 900));
};
await eu('Schweiz Controller Titel', 'Controller', 'TITLE', ['ch']);
await eu('Zürich ch04 Controller Titel', 'Controller', 'TITLE', ['ch04']);
await eu('Bayern de2 Controller Titel', 'Controller', 'TITLE', ['de2']);
await eu('Oberbayern de21 Controller Titel', 'Controller', 'TITLE', ['de21']);
await eu('Südtirol ith1 Controller Titel', 'Controller', 'TITLE', ['ith1']);
await eu('Liechtenstein Controller', 'Controller', 'TITLE', ['li']);
await eu('Tirol Controlling überall, beste zuerst', 'Controlling', 'EVERYWHERE', ['at33'], { sortSearch: 'BEST_MATCH' });
await eu('Tirol "Power BI" überall', 'Power BI', 'EVERYWHERE', ['at33'], { sortSearch: 'BEST_MATCH' });
await eu('Tirol Buchhaltung Titel', 'Buchhaltung', 'TITLE', ['at33']);
await eu('Tirol Finanz Titel', 'Finanz', 'TITLE', ['at33']);
await eu('Tirol Controll Titel (Wortanfang?)', 'Controll', 'TITLE', ['at33']);

// --- Arbeitsagentur: Auslandssuche Österreich, Umkreis 50, ohne Filter ---
const BA = 'https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v6/jobs';
const ba = async (name, q) => { const r = await hol(`BA ${name}`, `${BA}?${new URLSearchParams(q)}`, { headers: { 'X-API-Key': 'jobboerse-jobsuche' } }); console.log('gesamt:', r.j?.maxErgebnisse, 'wo:', JSON.stringify(r.j?.woOutput), '|', (r.j?.ergebnisliste ?? []).slice(0, 8).map((s) => `${s.firma} / ${s.stellenangebotsTitel} / ${s.stellenlokationen?.[0]?.adresse?.ort}`).join(' ;; ').slice(0, 900)); };
await ba('Österreich Controller', { was: 'Controller', wo: 'Österreich', veroeffentlichtseit: '28', size: '10' });
await ba('Österreich Controlling', { was: 'Controlling', wo: 'Österreich', veroeffentlichtseit: '28', size: '10' });
await ba('Tirol Controller', { was: 'Controller', wo: 'Tirol', veroeffentlichtseit: '28', size: '10' });
await ba('Schweiz Controller', { was: 'Controller', wo: 'Schweiz', veroeffentlichtseit: '28', size: '10' });
await ba('Rosenheim 50km Controller', { was: 'Controller', wo: 'Rosenheim', umkreis: '50', veroeffentlichtseit: '28', size: '5' });
await ba('homeoffice Controller', { was: 'Controller', arbeitszeit: 'ho', veroeffentlichtseit: '28', size: '5' });

// --- Offene Feeds einzelner Arbeitgeber-Systeme (Beispiele) ---
await hol('Personio XML Beispiel', 'https://personio.jobs.personio.de/xml', { headers: { Accept: 'application/xml' } });
await hol('Greenhouse Beispiel', 'https://boards-api.greenhouse.io/v1/boards/celonis/jobs');
await hol('SmartRecruiters Beispiel', 'https://api.smartrecruiters.com/v1/companies/BoschGroup/postings?country=at&limit=5');
await hol('karriere.at RSS?', 'https://www.karriere.at/jobs/controlling/innsbruck?feed=rss', { headers: { Accept: 'application/rss+xml' } });
