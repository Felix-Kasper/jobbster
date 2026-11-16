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
 *   datum: string | null, url: string, beschreibung: string, mail: string | null, bewerbung: string, ortRang: number, punkte?: number }} Kandidat
 * @typedef {{ name: string, rang: number, quelle: 'ba', wo: string } | { name: string, rang: number, quelle: 'eures', nuts: string[] }} Suchort
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

/** Österreich nach Bundesland (NUTS 2). Orte, die hier fehlen, sucht EURES im ganzen Land. */
const AT_LAENDER = {
  at11: ['burgenland', 'eisenstadt', 'neusiedl', 'oberwart', 'mattersburg', 'oberpullendorf', 'gussing', 'jennersdorf'],
  at12: ['niederosterreich', 'st polten', 'sankt polten', 'wiener neustadt', 'klosterneuburg', 'baden', 'krems', 'amstetten', 'modling', 'schwechat', 'tulln', 'korneuburg', 'stockerau', 'traiskirchen', 'neunkirchen', 'zwettl', 'mistelbach', 'wiener neudorf', 'vosendorf', 'perchtoldsdorf'],
  at13: ['wien', 'vienna'],
  at21: ['karnten', 'klagenfurt', 'villach', 'wolfsberg', 'spittal', 'feldkirchen', 'st veit', 'sankt veit', 'volkermarkt'],
  at22: ['steiermark', 'graz', 'leoben', 'kapfenberg', 'bruck an der mur', 'weiz', 'leibnitz', 'feldbach', 'knittelfeld', 'judenburg', 'deutschlandsberg', 'gleisdorf', 'liezen'],
  at31: ['oberosterreich', 'linz', 'wels', 'steyr', 'leonding', 'traun', 'braunau', 'ried', 'vocklabruck', 'gmunden', 'ansfelden', 'bad ischl', 'enns', 'schardin', 'scharding', 'freistadt', 'perg', 'kirchdorf'],
  at32: ['salzburg', 'hallein', 'saalfelden', 'zell am see', 'bischofshofen', 'st johann im pongau', 'sankt johann im pongau', 'wals', 'seekirchen'],
  at33: ['tirol', 'innsbruck', 'kufstein', 'hall in tirol', 'hall', 'wattens', 'schwaz', 'telfs', 'worgl', 'lienz', 'imst', 'kitzbuhel', 'landeck', 'reutte', 'rum', 'jenbach', 'zirl', 'vols', 'st johann in tirol', 'sankt johann in tirol', 'absam', 'kematen', 'fulpmes', 'kundl', 'brixlegg'],
  at34: ['vorarlberg', 'bregenz', 'dornbirn', 'feldkirch', 'bludenz', 'hohenems', 'lustenau', 'rankweil', 'gotzis', 'hard', 'lauterach', 'wolfurt'],
};
/** Wer in Wien sucht, pendelt auch ins Umland. */
const AT_NACHBARN = { at13: ['at12'] };
const AT_ORT = new Map(Object.entries(AT_LAENDER).flatMap(([nuts, namen]) => namen.map((n) => /** @type {[string, string]} */ ([n, nuts]))));

/**
 * Orte aus dem Profil den Quellen zuordnen. Reihenfolge = Vorliebe.
 * Österreichische Orte gehen an EURES, alles andere prüft die Arbeitsagentur selbst (sie lehnt unbekannte Orte ab).
 * @param {unknown} orte @param {string} [land] @returns {Suchort[]}
 */
export function ortPlan(orte, land = 'AT') {
  const liste = (Array.isArray(orte) ? orte : String(orte ?? '').split(/[,;/]/)).map((o) => String(o).trim()).filter(Boolean);
  /** @type {Suchort[]} */
  const plan = [];
  liste.forEach((name, rang) => {
    const n = norm(name).replace(/\b(umgebung|und umgebung|raum|grossraum|region|stadt)\b/g, '').trim();
    if (!n || /^(remote|homeoffice|home office|egal|uberall|ueberall)$/.test(n)) return;
    if (n === 'osterreich' || n === 'oesterreich' || n === 'austria') return void plan.push({ name, rang, quelle: 'eures', nuts: ['at'] });
    if (n === 'deutschland' || n === 'germany') return void plan.push({ name, rang, quelle: 'ba', wo: '' });
    const nuts = AT_ORT.get(n) ?? AT_ORT.get(n.split(' ')[0]);
    if (nuts && !(land === 'DE' && n === 'hall')) return void plan.push({ name, rang, quelle: 'eures', nuts: [nuts, .../** @type {Record<string, string[]>} */ (AT_NACHBARN)[nuts] ?? []] });
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
  const q = new URLSearchParams({ was, angebotsart: String(angebotsart), veroeffentlichtseit: '28', size: String(GRENZEN.jeAnfrage), page: '1' });
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
      beschreibung: '', mail: null, bewerbung: '', ortRang: rang,
    };
  });
}

/** Volltext einer Anzeige der Arbeitsagentur nachladen. @param {Holen} holen @param {Kandidat} k */
async function baDetails(holen, k) {
  const d = await json(holen, `${BA}/v4/jobdetails/${b64(k.id)}`, baKopf);
  const text = klartext(d?.stellenangebotsBeschreibung);
  const partner = /^https?:\/\//i.test(d?.allianzpartnerUrl || '') ? `Anzeige stammt von ${klartext(d.allianzpartnerName) || 'einem Partnerportal'}: ${d.allianzpartnerUrl}` : '';
  return { ...k, beschreibung: text, mail: MAIL.exec(text)?.[0] ?? null, bewerbung: partner };
}

// ---------------------------------------------------------------------------------------------------------------------
// EURES (Österreich, mit den Stellen des AMS)

const EURES_LEER = { sortSearch: 'MOST_RECENT', publicationPeriod: null, occupationUris: [], skillUris: [], requiredExperienceCodes: [], positionScheduleCodes: [], sectorCodes: [], educationAndQualificationLevelCodes: [], positionOfferingCodes: [], euresFlagCodes: [], otherBenefitsCodes: [], requiredLanguages: [], minNumberPost: null, sessionId: 'jobbster' };

/**
 * @param {Holen} holen
 * @param {{ was: string, nuts: string[], rang: number }} p
 * @returns {Promise<Kandidat[]>}
 */
export async function euresSuche(holen, { was, nuts, rang }) {
  const body = { ...EURES_LEER, resultsPerPage: GRENZEN.jeAnfrage, page: 1, keywords: [{ keyword: was, specificSearchCode: 'TITLE' }], locationCodes: nuts };
  const r = await json(holen, `${EURES}/jv-search/search`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return (r?.jvs ?? []).filter((/** @type {any} */ j) => j?.id && j?.title).map((/** @type {any} */ j) => {
    const firma = klartext(j.employer?.name);
    return {
      quelle: 'EURES (AMS)', id: String(j.id), titel: klartext(j.title), firma: firma && !/^siehe beschreibung$/i.test(firma) ? firma : null,
      ort: null, land: /** @type {'DE' | 'AT'} */ ('AT'), datum: tag(j.creationDate),
      url: `https://europa.eu/eures/portal/jv-se/jv-details/${encodeURIComponent(j.id)}?lang=de`,
      beschreibung: klartext(j.translations?.de?.description ?? j.description), mail: null, bewerbung: '', ortRang: rang,
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
  return {
    ...k, beschreibung: text, bewerbung,
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
        aufgaben.push({ name: `EURES ${was} ${ort.name}`, lauf: () => euresSuche(holen, { was, nuts: ort.nuts, rang: ort.rang }) });
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

const HOCH = /\b(senior|sr|leiter|leiterin|leitung|head|lead|director|direktor|chef|principal|teamleiter|teamleitung|abteilungsleiter|bereichsleiter|geschaftsfuhrer|experte|expert|vp)\b/;
const EINSTIEG = /\b(junior|jr|trainee|traineeprogramm|graduate|einsteiger|berufseinsteiger|berufseinstieg|absolvent|absolventen|young professional|nachwuchs|associate|praktikum|praktikant|internship|intern)\b/;
const LEHRE = /\b(ausbildung|auszubildende|azubi|lehrling|lehrstelle|duales studium|dual)\b/;

/**
 * Vorsortieren ohne KI: Wie gut passt der Titel? Nur die besten gehen in die (bezahlte) Bewertung.
 * Raus fliegt, was nicht zum Suchbegriff passt, dazu Leitungsrollen, Lehrstellen und Ausschlüsse aus dem Profil.
 * Punkte für den Rest: Suchbegriff im Titel, Einstiegs-Wörter, Frische, Wunschort.
 * @param {Kandidat[]} kandidaten
 * @param {{ begriffe: string[], bekannt?: string[], ausschluesse?: unknown, erfahren?: boolean, max: number, jetzt?: number }} p
 * @returns {Kandidat[]}
 */
export function vorauswahl(kandidaten, { begriffe, bekannt = [], ausschluesse = '', erfahren = false, max, jetzt = Date.now() }) {
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
    let punkte = (genau ? 40 : 25) + (einstieg ? 25 : 0);
    const alter = alterTage(k.datum, jetzt);
    if (alter !== null) punkte += alter <= 4 ? 15 : alter <= 14 ? 8 : alter <= 28 ? 3 : 0;
    punkte += k.ortRang === 0 ? 10 : k.ortRang === 1 ? 5 : 0;
    if (!k.firma) punkte -= 5; // Firma steht nur im Text: geht, ist aber unsicherer
    const mit = { ...k, punkte };
    // Jede Firma höchstens einmal; anonyme Anzeigen (Firma nur im Text) zählen einzeln
    const key = fk || `${k.quelle}|${k.id}`;
    const alt = jeFirma.get(key);
    if (!alt || punkte > (alt.punkte ?? 0)) jeFirma.set(key, mit);
  }
  return [...jeFirma.values()].sort((a, b) => (b.punkte ?? 0) - (a.punkte ?? 0)).slice(0, max);
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
    `Anzeigentext: ${k.beschreibung.slice(0, GRENZEN.beschreibung)}${k.beschreibung.length > GRENZEN.beschreibung ? ' …' : ''}`,
  ].join('\n')).join('\n\n');
}
