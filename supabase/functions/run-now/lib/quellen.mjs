// @ts-check
// Jobbster · Stellen-Quellen: echte Anzeigen aus öffentlichen Schnittstellen statt aus der Websuche.
//   Deutschland: Jobsuche der Bundesagentur für Arbeit (dokumentiert unter jobsuche.api.bund.dev)
//   Österreich:  EURES, das europäische Jobportal (enthält die Stellen des AMS)
// Ohne Abhängigkeiten, läuft in Node und in Deno. Der Abruf (holen) wird übergeben, damit Tests ohne Netz laufen.
// Beide Schnittstellen sind öffentlich, aber ohne Vertrag: Fällt eine aus, meldet dieses Modul einen Hinweis
// und liefert, was die andere hergibt. `node worker/tools/quellen-probe.mjs` prüft beide von Hand.

/**
 * @typedef {(url: string, init?: RequestInit) => Promise<Response>} Holen
 * @typedef {{ quelle: string, id: string, titel: string, firma: string | null, ort: string | null, land: 'DE' | 'AT',
 *   datum: string | null, url: string, beschreibung: string, mail: string | null, bewerbung: string, ortRang: number,
 *   nah?: boolean, gehalt?: string | null, start?: string | null, punkte?: number }} Kandidat
 * @typedef {{ name: string, rang: number, quelle: 'ba', wo: string } | { name: string, rang: number, quelle: 'eures', nuts: string[], nah: string[] }} Suchort
 */

const BA = 'https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc';
/** Öffentliche Kennung der Jobsuche (steht in der Dokumentation der Schnittstelle). Kein Geheimnis. */
const BA_KENNUNG = 'jobboerse-jobsuche';
const EURES = 'https://europa.eu/eures/api/jv-searchengine/public';
const UA = 'Jobbster/1.0 (Stellensuche für Bewerber)';

export const GRENZEN = {
  begriffe: 6, // Suchbegriffe je Lauf
  orte: 4, // Orte je Lauf
  anfragen: 36, // Suchanfragen je Lauf über alle Quellen
  gleichzeitig: 4,
  wartenMs: 15_000,
  alterTage: 42, // ältere Anzeigen fallen raus
  umkreisKm: 30,
  jeAnfrage: 40,
  beschreibung: 1300, // Zeichen je Anzeige für die Bewertung
};

// ---------------------------------------------------------------------------------------------------------------------
// Kleine Helfer

const norm = (/** @type {unknown} */ s) => String(s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, ' ').trim();

/** Firmenname ohne Rechtsform und Sonderzeichen: Schlüssel für „jede Firma nur einmal“. */
export const firmaKey = (/** @type {unknown} */ s) => String(s || '').toLowerCase().replace(/\(.*?\)|\b(gmbh|mbh|ag|se|kg|kgaa|co|inc|ltd|group|gruppe|holding)\b|[^a-z0-9äöüß]/g, '');

/** HTML und Markdown-Zeichen raus, Leerraum glätten. Anzeigentexte sind fremde Daten und werden nie ausgeführt. */
export function klartext(/** @type {unknown} */ s) {
  return String(s ?? '')
    .replace(/<(br|\/p|\/li|\/h\d|\/div)\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/[*_#`]{1,3}/g, '')
    .replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

const MAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const tag = (/** @type {number | string | null | undefined} */ t) => {
  const d = new Date(t ?? NaN);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};
const alterTage = (/** @type {string | null} */ datum, /** @type {number} */ jetzt) => (datum ? Math.floor((jetzt - Date.parse(datum)) / 86_400_000) : null);

/**
 * JSON abrufen: Zeitlimit, ein zweiter Versuch bei Netzfehler oder 5xx, sonst ein Fehler mit Status.
 * @param {Holen} holen @param {string} url @param {RequestInit} [init]
 */
async function json(holen, url, init = {}) {
  let letzter = new Error('kein Versuch');
  for (let versuch = 0; versuch < 2; versuch++) {
    try {
      const res = await holen(url, { ...init, headers: { 'User-Agent': UA, Accept: 'application/json', ...(init.headers || {}) }, signal: AbortSignal.timeout(GRENZEN.wartenMs) });
      if (res.ok) return await res.json();
      letzter = new Error(`HTTP ${res.status}`);
      if (res.status < 500) break;
    } catch (e) {
      letzter = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw letzter;
}

/**
 * Aufgaben mit begrenzter Gleichzeitigkeit abarbeiten. Fehler einzelner Aufgaben brechen nichts ab.
 * @template T @template R
 * @param {T[]} liste @param {number} gleichzeitig @param {(x: T) => Promise<R>} fn
 * @returns {Promise<({ ok: true, wert: R } | { ok: false, fehler: string })[]>}
 */
async function parallel(liste, gleichzeitig, fn) {
  /** @type {({ ok: true, wert: R } | { ok: false, fehler: string })[]} */
  const aus = new Array(liste.length);
  let i = 0;
  const arbeiter = async () => {
    while (i < liste.length) {
      const n = i++;
      try { aus[n] = { ok: true, wert: await fn(liste[n]) }; } catch (e) { aus[n] = { ok: false, fehler: e instanceof Error ? e.message : String(e) }; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(gleichzeitig, liste.length) }, arbeiter));
  return aus;
}

// ---------------------------------------------------------------------------------------------------------------------
// Orte: Welche Quelle ist zuständig?

/** Österreichs Regionen (NUTS 3) mit Namen und den größeren Orten darin. EURES nennt bei AMS-Stellen nur die Region. */
const AT_REGIONEN = {
  at111: ['Mittelburgenland', 'oberpullendorf'],
  at112: ['Nordburgenland', 'eisenstadt', 'neusiedl', 'mattersburg'],
  at113: ['Südburgenland', 'oberwart', 'gussing', 'jennersdorf'],
  at121: ['Mostviertel', 'amstetten', 'waidhofen', 'scheibbs', 'melk'],
  at122: ['Niederösterreich Süd', 'wiener neustadt', 'neunkirchen', 'ternitz'],
  at123: ['St. Pölten', 'st polten', 'sankt polten'],
  at124: ['Waldviertel', 'krems', 'zwettl', 'horn', 'gmund'],
  at125: ['Weinviertel', 'mistelbach', 'hollabrunn'],
  at126: ['Wiener Umland Nord', 'klosterneuburg', 'korneuburg', 'stockerau', 'tulln', 'ganserndorf'],
  at127: ['Wiener Umland Süd', 'modling', 'baden', 'schwechat', 'wiener neudorf', 'vosendorf', 'perchtoldsdorf', 'traiskirchen', 'brunn am gebirge'],
  at130: ['Wien', 'wien', 'vienna'],
  at211: ['Klagenfurt-Villach', 'klagenfurt', 'villach'],
  at212: ['Oberkärnten', 'spittal', 'feldkirchen', 'hermagor'],
  at213: ['Unterkärnten', 'wolfsberg', 'st veit', 'sankt veit', 'volkermarkt'],
  at221: ['Graz', 'graz'],
  at222: ['Liezen', 'liezen', 'schladming'],
  at223: ['Östliche Obersteiermark', 'leoben', 'kapfenberg', 'bruck an der mur', 'murzzuschlag'],
  at224: ['Oststeiermark', 'weiz', 'feldbach', 'gleisdorf', 'hartberg', 'furstenfeld'],
  at225: ['West- und Südsteiermark', 'leibnitz', 'deutschlandsberg', 'voitsberg'],
  at226: ['Westliche Obersteiermark', 'knittelfeld', 'judenburg', 'murau'],
  at311: ['Innviertel', 'braunau', 'ried', 'scharding'],
  at312: ['Linz-Wels', 'linz', 'wels', 'leonding', 'traun', 'ansfelden', 'enns', 'pasching'],
  at313: ['Mühlviertel', 'freistadt', 'perg', 'rohrbach'],
  at314: ['Steyr-Kirchdorf', 'steyr', 'kirchdorf'],
  at315: ['Traunviertel', 'vocklabruck', 'gmunden', 'bad ischl'],
  at321: ['Lungau', 'tamsweg'],
  at322: ['Pinzgau-Pongau', 'saalfelden', 'zell am see', 'bischofshofen', 'st johann im pongau', 'sankt johann im pongau'],
  at323: ['Salzburg und Umgebung', 'salzburg', 'hallein', 'wals', 'seekirchen'],
  at331: ['Außerfern (Reutte)', 'reutte'],
  at332: ['Innsbruck', 'innsbruck', 'hall in tirol', 'hall', 'wattens', 'rum', 'telfs', 'zirl', 'vols', 'absam', 'kematen', 'fulpmes'],
  at333: ['Osttirol (Lienz)', 'lienz'],
  at334: ['Tiroler Oberland', 'imst', 'landeck'],
  at335: ['Tiroler Unterland', 'kufstein', 'worgl', 'schwaz', 'jenbach', 'kitzbuhel', 'st johann in tirol', 'sankt johann in tirol', 'kundl', 'brixlegg'],
  at341: ['Bludenz-Bregenzerwald', 'bludenz'],
  at342: ['Rheintal-Bodensee', 'bregenz', 'dornbirn', 'feldkirch', 'hohenems', 'lustenau', 'rankweil', 'gotzis', 'hard', 'lauterach', 'wolfurt'],
};
// Wien fehlt hier mit Absicht: Es ist Stadt und Bundesland zugleich und läuft über die Orte (mit Umland).
const AT_LAND = { at11: 'burgenland', at12: 'niederosterreich', at21: 'karnten', at22: 'steiermark', at31: 'oberosterreich', at32: 'salzburg', at33: 'tirol', at34: 'vorarlberg' };
const AT_ORT = new Map(Object.entries(AT_REGIONEN).flatMap(([nuts, [, ...orte]]) => orte.map((o) => /** @type {[string, string]} */ ([o, nuts]))));
const AT_BUNDESLAND = new Map(Object.entries(AT_LAND).map(([nuts, name]) => [name, nuts]));
/** Wer in Wien sucht, pendelt auch ins Umland: mit durchsuchen und als nah werten. */
const AT_UMLAND = { at130: { nuts: ['at12'], nah: ['at126', 'at127'] } };
/** Name einer Region für die Anzeige, zum Beispiel „Region Innsbruck“. */
export const regionName = (/** @type {unknown} */ nuts3) => /** @type {Record<string, string[]>} */ (AT_REGIONEN)[String(nuts3 ?? '').toLowerCase()]?.[0] ?? null;

/**
 * Orte aus dem Profil den Quellen zuordnen. Reihenfolge = Vorliebe.
 * Österreichische Orte gehen an EURES, alles andere prüft die Arbeitsagentur selbst (sie lehnt unbekannte Orte ab).
 * @param {unknown} orte @param {string} [heimat] Land aus dem Profil, entscheidet nur bei doppeldeutigen Namen
 * @returns {Suchort[]}
 */
export function ortPlan(orte, heimat = 'AT') {
  const liste = (Array.isArray(orte) ? orte : String(orte ?? '').split(/[,;/]/)).map((o) => String(o).trim()).filter(Boolean);
  /** @type {Suchort[]} */
  const plan = [];
  liste.forEach((name, rang) => {
    const n = norm(name).replace(/\b(umgebung|und umgebung|raum|grossraum|region|stadt)\b/g, '').trim();
    if (!n || /^(remote|homeoffice|home office|egal|uberall|ueberall)$/.test(n)) return;
    if (n === 'osterreich' || n === 'oesterreich' || n === 'austria') return void plan.push({ name, rang, quelle: 'eures', nuts: ['at'], nah: [] });
    if (n === 'deutschland' || n === 'germany') return void plan.push({ name, rang, quelle: 'ba', wo: '' });
    const land = AT_BUNDESLAND.get(n);
    if (land) return void plan.push({ name, rang, quelle: 'eures', nuts: [land], nah: [] });
    const region = AT_ORT.get(n) ?? AT_ORT.get(n.split(' ')[0]);
    if (region && !(heimat === 'DE' && n === 'hall')) {
      const umland = /** @type {Record<string, { nuts: string[], nah: string[] }>} */ (AT_UMLAND)[region];
      return void plan.push({ name, rang, quelle: 'eures', nuts: [region.slice(0, 4), ...(umland?.nuts ?? [])], nah: [region, ...(umland?.nah ?? [])] });
    }
    plan.push({ name, rang, quelle: 'ba', wo: name });
  });
  return plan.slice(0, GRENZEN.orte);
}

// ---------------------------------------------------------------------------------------------------------------------
// Suchbegriffe

const LEVEL_WORT = /^(junior|jr|trainee|traineeprogramm|graduate|praktikum|praktikant|praktikantin|berufseinstieg|berufseinsteiger|berufseinsteigerin|einstieg|einsteiger|absolvent|absolventin|werkstudent|werkstudentin|intern|internship|young|professional|als|im|in|der|fur|und|oder)$/;
const GESCHLECHT = /\(?\b[mwfdx]\s*\/\s*[mwfdx](\s*\/\s*[mwfdx])?\b\)?|\(?\ball genders\b\)?/gi;
/** Level-Wörter und „(m/w/d)“ aus einer Rolle entfernen, Schreibweise sonst behalten. */
const ohneLevel = (/** @type {string} */ rolle) => rolle.replace(GESCHLECHT, ' ').replace(/[()]/g, ' ').split(/\s+/).filter((w) => w && !LEVEL_WORT.test(norm(w))).join(' ');

/**
 * Suchbegriffe ohne KI aus den Zielrollen ableiten: Level-Wörter raus, damit die Schnittstellen genug finden.
 * „Trainee Controlling, Junior Controller (m/w/d)“ wird zu ["Controlling", "Controller"].
 * @param {unknown} zielrollen @returns {string[]}
 */
export function begriffeAusRollen(zielrollen) {
  const rollen = (Array.isArray(zielrollen) ? zielrollen.join(',') : String(zielrollen ?? '')).replace(GESCHLECHT, ' ').split(/[,;/\n]| oder | und /i);
  return begriffeMischen(rollen.map(ohneLevel));
}

/**
 * Begriffe zusammenführen: eigene zuerst, dann Vorschläge der KI, ohne Doppelte, je höchstens 3 Wörter.
 * @param {...unknown[]} listen @returns {string[]}
 */
export function begriffeMischen(...listen) {
  /** @type {Map<string, string>} */
  const aus = new Map();
  for (const b of listen.flat()) {
    const sauber = ohneLevel(String(b ?? '').replace(/[^\p{L}\p{N}&+\-/() ]/gu, ' ')).replace(/\//g, ' ').split(/\s+/).filter(Boolean).slice(0, 3).join(' ').replace(/\s(und|oder|&)$/i, '');
    const k = norm(sauber);
    if (k.length >= 3 && sauber.length <= 40 && !aus.has(k)) aus.set(k, sauber);
  }
  return [...aus.values()].slice(0, GRENZEN.begriffe);
}

// ---------------------------------------------------------------------------------------------------------------------
// Bundesagentur für Arbeit (Deutschland)

const baKopf = { headers: { 'X-API-Key': BA_KENNUNG } };
const b64 = (/** @type {string} */ s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

/**
 * @param {Holen} holen
 * @param {{ was: string, wo: string, rang: number, angebotsart?: number }} p
 * @returns {Promise<Kandidat[]>}
 */
export async function baSuche(holen, { was, wo, rang, angebotsart = 1 }) {
  // zeitarbeit und pav (private Arbeitsvermittlung) aus: Bewerber wollen den Arbeitgeber kennen, nicht einen Vermittler
  const q = new URLSearchParams({ was, angebotsart: String(angebotsart), veroeffentlichtseit: '28', zeitarbeit: 'false', pav: 'false', size: String(GRENZEN.jeAnfrage), page: '1' });
  if (wo) { q.set('wo', wo); q.set('umkreis', String(GRENZEN.umkreisKm)); }
  const r = await json(holen, `${BA}/v6/jobs?${q}`, baKopf);
  // Die Arbeitsagentur „verbessert“ unbekannte Orte (aus Wien wird Sien). Nur übernehmen, wenn sie den Ort wirklich kennt.
  if (wo) {
    const erkannt = norm(r?.woOutput?.bereinigterOrt);
    if (r?.woOutput?.suchmodus === 'UNGUELTIG' || (erkannt && !erkannt.includes(norm(wo)) && !norm(wo).includes(erkannt))) throw new Error(`Ort „${wo}“ kennt die Arbeitsagentur nicht`);
  }
  return (r?.ergebnisliste ?? []).filter((/** @type {any} */ s) => s?.referenznummer && s?.stellenangebotsTitel).map((/** @type {any} */ s) => {
    const adresse = s.stellenlokationen?.[0]?.adresse ?? {};
    return {
      quelle: 'Arbeitsagentur', id: String(s.referenznummer), titel: klartext(s.stellenangebotsTitel), firma: klartext(s.firma) || null,
      ort: klartext(adresse.ort) || null, land: /** @type {'DE' | 'AT'} */ (adresse.land === 'OESTERREICH' ? 'AT' : 'DE'),
      datum: tag(s.datumErsteVeroeffentlichung ?? s.veroeffentlichungszeitraum?.von),
      url: `https://www.arbeitsagentur.de/jobsuche/jobdetail/${encodeURIComponent(s.referenznummer)}`,
      beschreibung: '', mail: null, bewerbung: '', ortRang: rang, nah: true, gehalt: baGehalt(s), start: tag(s.eintrittszeitraum?.von),
    };
  });
}

/** Gehaltsangabe der Arbeitsagentur als kurzer Text, nur wenn die Anzeige eine nennt. */
function baGehalt(/** @type {any} */ s) {
  const art = { JAHRESGEHALT: 'pro Jahr', MONATSGEHALT: 'pro Monat', STUNDENLOHN: 'pro Stunde' }[String(s?.verguetungsangabe)];
  const zahl = (/** @type {unknown} */ n) => (Number(n) > 0 ? Math.round(Number(n)) : null);
  const [fest, von, bis] = [zahl(s?.festgehalt), zahl(s?.gehaltsspanneVon), zahl(s?.gehaltsspanneBis)];
  const betrag = fest ? `${fest}` : von && bis ? `${von} bis ${bis}` : von ? `ab ${von}` : bis ? `bis ${bis}` : null;
  return betrag && art ? `${betrag} EUR ${art}` : null;
}

/** Volltext einer Anzeige der Arbeitsagentur nachladen. @param {Holen} holen @param {Kandidat} k */
async function baDetails(holen, k) {
  const d = await json(holen, `${BA}/v4/jobdetails/${b64(k.id)}`, baKopf);
  const text = klartext(d?.stellenangebotsBeschreibung);
  const fremd = /^https?:\/\//i.test(d?.allianzpartnerUrl || '') && !/arbeitsagentur\.de/i.test(d.allianzpartnerUrl);
  const partner = fremd ? `Anzeige stammt von ${klartext(d.allianzpartnerName) || 'einem Partnerportal'}: ${d.allianzpartnerUrl}` : '';
  return { ...k, beschreibung: text, mail: MAIL.exec(text)?.[0] ?? null, bewerbung: partner };
}

// ---------------------------------------------------------------------------------------------------------------------
// EURES (Österreich, mit den Stellen des AMS)

const EURES_LEER = { sortSearch: 'MOST_RECENT', publicationPeriod: null, occupationUris: [], skillUris: [], requiredExperienceCodes: [], positionScheduleCodes: [], sectorCodes: [], educationAndQualificationLevelCodes: [], positionOfferingCodes: [], euresFlagCodes: [], otherBenefitsCodes: [], requiredLanguages: [], minNumberPost: null, sessionId: 'jobbster' };

/**
 * @param {Holen} holen
 * @param {{ was: string, nuts: string[], nah?: string[], rang: number }} p
 * @returns {Promise<Kandidat[]>}
 */
export async function euresSuche(holen, { was, nuts, nah = [], rang }) {
  const body = { ...EURES_LEER, resultsPerPage: GRENZEN.jeAnfrage, page: 1, keywords: [{ keyword: was, specificSearchCode: 'TITLE' }], locationCodes: nuts };
  const r = await json(holen, `${EURES}/jv-search/search`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return (r?.jvs ?? []).filter((/** @type {any} */ j) => j?.id && j?.title).map((/** @type {any} */ j) => {
    const firma = klartext(j.employer?.name);
    const regionen = Object.values(j.locationMap ?? {}).flat().filter(Boolean).map((r) => String(r).toLowerCase());
    const region = regionen.find((r) => nah.includes(r)) ?? regionen[0];
    return {
      quelle: 'EURES (AMS)', id: String(j.id), titel: klartext(j.title), firma: firma && !/^siehe beschreibung$/i.test(firma) ? firma : null,
      ort: regionName(region) ? `Region ${regionName(region)}` : null, land: /** @type {'DE' | 'AT'} */ ('AT'), datum: tag(j.creationDate),
      url: `https://europa.eu/eures/portal/jv-se/jv-details/${encodeURIComponent(j.id)}?lang=de`,
      beschreibung: klartext(j.translations?.de?.description ?? j.description), mail: null, bewerbung: '', ortRang: rang,
      nah: !nah.length || regionen.some((r) => nah.includes(r)), gehalt: null, start: null,
    };
  });
}

/** Ort, Kontakt und Bewerbungsweg einer EURES-Anzeige nachladen. @param {Holen} holen @param {Kandidat} k */
async function euresDetails(holen, k) {
  const d = await json(holen, `${EURES}/jv/id/${encodeURIComponent(k.id)}?lang=de`);
  const p = d?.jvProfiles?.[d?.preferredLanguage] ?? Object.values(d?.jvProfiles ?? {})[0] ?? {};
  const text = klartext(p.description) || k.beschreibung;
  const bewerbung = klartext((p.applicationInstructions ?? []).join('\n')).slice(0, 400);
  const kontakt = (p.personContacts ?? []).flatMap((/** @type {any} */ c) => c?.communications?.emails ?? []).map((/** @type {any} */ e) => e?.uri).find((/** @type {unknown} */ u) => MAIL.test(String(u)));
  const firma = klartext(p.employer?.name);
  const lohn = (p.offeredRemunerationPackage?.salaries ?? []).find((/** @type {any} */ x) => Number(x?.minimumSalary) > 0);
  return {
    ...k, beschreibung: text, bewerbung,
    gehalt: lohn ? `mindestens ${Math.round(Number(lohn.minimumSalary))} ${lohn.currencyCode || 'EUR'} laut Anzeige` : k.gehalt ?? null,
    start: tag(p.employmentPeriod?.startDate) ?? k.start ?? null,
    ort: klartext((p.locations ?? []).map((/** @type {any} */ l) => l?.cityName).filter(Boolean).join(', ')) || k.ort,
    firma: k.firma ?? (firma && !/^siehe beschreibung$/i.test(firma) ? firma : null),
    mail: kontakt ? String(MAIL.exec(String(kontakt))?.[0]) : MAIL.exec(`${bewerbung} ${text}`)?.[0] ?? null,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Sammeln, vorsortieren, anreichern

/**
 * Alle Quellen abfragen: je Ort und Suchbegriff eine Anfrage, bis das Budget aufgebraucht ist.
 * @param {{ holen: Holen, begriffe: string[], orte: Suchort[], mitPraktikum?: boolean, jetzt?: number }} p
 * @returns {Promise<{ kandidaten: Kandidat[], hinweise: string[], anfragen: number, beantwortet: number }>}
 */
export async function sammle({ holen, begriffe, orte, mitPraktikum = true, jetzt = Date.now() }) {
  /** @type {{ name: string, lauf: () => Promise<Kandidat[]> }[]} */
  const aufgaben = [];
  /** @type {Set<string>} */
  const gebiete = new Set(); // zwei Orte im selben Gebiet (Innsbruck und Hall) nur einmal abfragen
  for (const ort of orte) {
    const gebiet = ort.quelle === 'eures' ? `eures|${ort.nuts.join('+')}` : `ba|${norm(ort.wo)}`;
    if (gebiete.has(gebiet)) continue;
    gebiete.add(gebiet);
    for (const was of begriffe) {
      if (ort.quelle === 'eures') {
        aufgaben.push({ name: `EURES ${was} ${ort.name}`, lauf: () => euresSuche(holen, { was, nuts: ort.nuts, nah: ort.nah, rang: ort.rang }) });
        continue;
      }
      aufgaben.push({ name: `Arbeitsagentur ${was} ${ort.name}`, lauf: () => baSuche(holen, { was, wo: ort.wo, rang: ort.rang }) });
      // Trainee-Programme und Praktika führt die Arbeitsagentur als eigene Angebotsart (34)
      if (mitPraktikum) aufgaben.push({ name: `Arbeitsagentur Trainee ${was} ${ort.name}`, lauf: () => baSuche(holen, { was, wo: ort.wo, rang: ort.rang, angebotsart: 34 }) });
    }
  }
  const geplant = aufgaben.slice(0, GRENZEN.anfragen);
  const antworten = await parallel(geplant, GRENZEN.gleichzeitig, (a) => a.lauf());

  /** @type {Map<string, Kandidat>} */
  const gefunden = new Map();
  /** @type {Map<string, number>} */
  const fehler = new Map();
  for (const a of antworten) {
    if (!a.ok) {
      fehler.set(a.fehler, (fehler.get(a.fehler) ?? 0) + 1);
      continue;
    }
    for (const k of a.wert) {
      const alter = alterTage(k.datum, jetzt);
      if (alter !== null && alter > GRENZEN.alterTage) continue;
      const key = `${k.quelle}|${k.id}`;
      const alt = gefunden.get(key);
      if (!alt || k.ortRang < alt.ortRang) gefunden.set(key, k);
    }
  }
  const hinweise = [...fehler].map(([f, n]) => `Quelle: ${n} von ${geplant.length} Anfragen ohne Ergebnis (${f})`);
  if (aufgaben.length > geplant.length) hinweise.push(`Quelle: ${aufgaben.length - geplant.length} Anfragen wegen Budget ausgelassen`);
  return { kandidaten: [...gefunden.values()], hinweise, anfragen: geplant.length, beantwortet: antworten.filter((a) => a.ok).length };
}

// Leitung auch als Wortende: Fachbereichsleitung, Teamleiterin, Abteilungsleiter.
// „Manager“ fehlt mit Absicht: Viele Einstiegsrollen heißen so (Account Manager, Produktmanager). Das entscheidet die Bewertung.
const HOCH = /\b(senior|sr|head|lead|director|direktor|chef|principal|geschaftsfuhrer|geschaftsfuhrung|experte|expert|vp)\b|(leiter|leiterin|leitung)\b/;
const EINSTIEG = /\b(junior|jr|trainee|traineeprogramm|graduate|einsteiger|berufseinsteiger|berufseinstieg|absolvent|absolventen|young professional|nachwuchs|associate|praktikum|praktikant|internship|intern)\b/;
const PRAKTIKUM = /\b(praktikum|praktikant|praktikantin|internship|intern|pflichtpraktikum)\b/;
const WERKSTUDENT = /\b(werkstudent|werkstudentin|working student|studentische|aushilfe|minijob)\b/;
const LEHRE = /\b(ausbildung|auszubildende|azubi|lehrling|lehrstelle|duales studium|dual)\b/;

/**
 * Vorsortieren ohne KI: Wie gut passt der Titel? Nur die besten gehen in die (bezahlte) Bewertung.
 * Raus fliegt, was nicht zum Suchbegriff passt, dazu Leitungsrollen, Lehrstellen und Ausschlüsse aus dem Profil.
 * Praktika und Werkstudentenstellen nur, wenn das Profil sie will.
 * Punkte für den Rest: Suchbegriff im Titel, Einstiegs-Wörter, Frische, Wunschort. Bei Gleichstand die frischere Anzeige.
 * @param {Kandidat[]} kandidaten
 * @param {{ begriffe: string[], bekannt?: string[], ausschluesse?: unknown, erfahren?: boolean, praktikum?: boolean, werkstudent?: boolean, max: number, jetzt?: number }} p
 * @returns {Kandidat[]}
 */
export function vorauswahl(kandidaten, { begriffe, bekannt = [], ausschluesse = '', erfahren = false, praktikum = true, werkstudent = false, max, jetzt = Date.now() }) {
  const worte = begriffe.map(norm).filter(Boolean);
  const staemme = [...new Set(worte.flatMap((w) => w.split(' ')).filter((w) => w.length >= 5).map((w) => w.slice(0, Math.max(5, w.length - 3))))];
  const tabu = norm(Array.isArray(ausschluesse) ? ausschluesse.join(' ') : ausschluesse).split(' ').filter((w) => w.length >= 5);
  const schon = new Set(bekannt.map(firmaKey).filter(Boolean));

  /** @type {Map<string, Kandidat>} */
  const jeFirma = new Map();
  for (const k of kandidaten) {
    const fk = firmaKey(k.firma);
    if (fk && schon.has(fk)) continue;
    const t = norm(k.titel);
    // Harte Ausschlüsse: Der Titel muss zum Suchbegriff passen. Leitungsrollen, Lehrstellen und Ausgeschlossenes gehen nie in die Bewertung.
    const genau = worte.some((w) => t.includes(w));
    if (!genau && !staemme.some((s) => t.includes(s))) continue;
    const einstieg = EINSTIEG.test(t);
    if ((!erfahren && HOCH.test(t) && !einstieg) || LEHRE.test(t) || tabu.some((w) => t.includes(w))) continue;
    if ((!praktikum && PRAKTIKUM.test(t)) || (!werkstudent && WERKSTUDENT.test(t))) continue;
    let punkte = (genau ? 40 : 25) + (einstieg ? 25 : 0);
    const alter = alterTage(k.datum, jetzt);
    if (alter !== null) punkte += alter <= 4 ? 15 : alter <= 14 ? 8 : alter <= 28 ? 3 : 0;
    punkte += k.nah === false ? 2 : k.ortRang === 0 ? 10 : k.ortRang === 1 ? 5 : 0; // gleiches Bundesland, aber nicht Pendelnähe: kleiner Bonus
    if (!k.firma) punkte -= 5; // Firma steht nur im Text: geht, ist aber unsicherer
    const mit = { ...k, punkte };
    // Jede Firma höchstens einmal; anonyme Anzeigen (Firma nur im Text) zählen einzeln
    const key = fk || `${k.quelle}|${k.id}`;
    const alt = jeFirma.get(key);
    if (!alt || punkte > (alt.punkte ?? 0)) jeFirma.set(key, mit);
  }
  return [...jeFirma.values()].sort((a, b) => (b.punkte ?? 0) - (a.punkte ?? 0) || String(b.datum).localeCompare(String(a.datum))).slice(0, max);
}

/**
 * Volltext, Ort und Kontakt für die Vorauswahl nachladen. Schlägt ein Abruf fehl, bleibt der Kandidat ohne Details drin.
 * @param {Holen} holen @param {Kandidat[]} kandidaten
 * @returns {Promise<{ kandidaten: Kandidat[], fehlgeschlagen: number }>}
 */
export async function anreichern(holen, kandidaten) {
  const antworten = await parallel(kandidaten, GRENZEN.gleichzeitig, (k) => (k.quelle === 'Arbeitsagentur' ? baDetails(holen, k) : euresDetails(holen, k)));
  let fehlgeschlagen = 0;
  const aus = antworten.map((a, i) => {
    if (a.ok) return a.wert;
    fehlgeschlagen++;
    return kandidaten[i];
  });
  // Ohne jeden Text lässt sich nichts ehrlich bewerten
  return { kandidaten: aus.filter((k) => k.beschreibung.length >= 80), fehlgeschlagen };
}

/**
 * Kandidaten als nummerierte Trefferliste für die Bewertung. Gleiche Form wie die Liste aus der Websuche.
 * @param {Kandidat[]} kandidaten
 */
export function trefferliste(kandidaten) {
  return kandidaten.map((k, i) => [
    `### ${i + 1} | ${k.firma ?? 'Firma steht im Text'} | ${k.titel}`,
    `Ort: ${k.ort ?? 'unbekannt'} (${k.land})`,
    `Link: ${k.url}`,
    `Quelle: ${k.quelle}`,
    `Veröffentlicht: ${k.datum ?? 'unbekannt'}`,
    `Bewerbungsweg: ${k.mail ? `E-Mail (${k.mail})` : 'Portal'}${k.bewerbung ? `. ${k.bewerbung}` : ''}`,
    'Online geprüft: ja',
    ...(k.gehalt ? [`Gehalt: ${k.gehalt}`] : []),
    ...(k.start ? [`Start laut Anzeige: ${k.start}`] : []),
    `Anzeigentext: ${k.beschreibung.slice(0, GRENZEN.beschreibung)}${k.beschreibung.length > GRENZEN.beschreibung ? ' …' : ''}`,
  ].join('\n')).join('\n\n');
}
