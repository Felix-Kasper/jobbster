// @ts-check
// Jobbster · Ist eine Anzeige noch online? Prüft ohne KI und ohne Kosten.
// Antwort „weg“ nur bei einem eindeutigen Zeichen, sonst „online“ oder „unklar“. Gelöscht wird nur bei „weg“:
// Lieber bleibt einmal eine alte Anzeige stehen, als dass eine gute Stelle verschwindet.
//   Arbeitsagentur: Detail-Schnittstelle (dieselbe wie bei der Suche)
//   EURES:          Detail-Schnittstelle
//   andere Seiten:  HTTP 404 oder 410, oder ein eindeutiger Satz wie „Diese Stelle ist nicht mehr verfügbar“

/** @typedef {(url: string, init?: RequestInit) => Promise<Response>} Holen */
/** @typedef {{ status: 'online' | 'weg' | 'unklar', grund: string }} Befund */

const BA = 'https://rest.arbeitsagentur.de/jobboerse/jobsuche-service/pc/v4/jobdetails/';
const EURES = 'https://europa.eu/eures/api/jv-searchengine/public/jv/id/';
const WARTEN_MS = 15_000;
const BROWSER = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36';

/**
 * Sätze, mit denen Jobbörsen und Karriereseiten eine beendete Anzeige kennzeichnen.
 * Bewusst eng gefasst: Ein allgemeines „nicht verfügbar“ steht auch auf lebenden Seiten (ausverkaufte Merkliste, Cookie-Hinweis).
 */
const BEENDET = [
  /diese (stellen)?anzeige ist (leider )?(nicht mehr (verfügbar|aktiv|online|gültig)|abgelaufen|deaktiviert)/i,
  /diese (stelle|position|vakanz) ist (leider )?(nicht mehr (verfügbar|aktiv|online|ausgeschrieben|zu besetzen)|bereits (vergeben|besetzt))/i,
  /die (stelle|position) wurde (bereits )?(besetzt|vergeben)/i,
  /(stellenangebot|stellenanzeige|jobangebot) (ist )?(nicht mehr|abgelaufen)/i,
  /(this|the) (job|position|vacancy|posting|job posting) (is|has) (no longer (available|active|open)|(been )?(filled|closed|expired))/i,
  /no longer accepting applications/i,
  /job (has )?expired/i,
];

const b64 = (/** @type {string} */ s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

/** @param {Holen} holen @param {string} url @param {RequestInit} [init] */
async function abruf(holen, url, init = {}) {
  return holen(url, { redirect: 'follow', ...init, signal: AbortSignal.timeout(WARTEN_MS) });
}

/** Status einer Schnittstelle deuten: 404 und 410 heißen weg, 200 online, alles andere unklar. */
function nachStatus(/** @type {number} */ s, /** @type {string} */ wer) {
  if (s === 404 || s === 410) return /** @type {Befund} */ ({ status: 'weg', grund: `${wer} kennt die Anzeige nicht mehr (${s})` });
  if (s >= 200 && s < 300) return /** @type {Befund} */ ({ status: 'online', grund: `${wer} ${s}` });
  return /** @type {Befund} */ ({ status: 'unklar', grund: `${wer} antwortet ${s}` });
}

/**
 * @param {Holen} holen
 * @param {string | null | undefined} url
 * @returns {Promise<Befund>}
 */
export async function anzeigeStatus(holen, url) {
  if (!url || !/^https?:\/\//i.test(url)) return { status: 'unklar', grund: 'kein Link' };
  let u;
  try { u = new URL(url); } catch { return { status: 'unklar', grund: 'Link ungültig' }; }
  try {
    // Arbeitsagentur: Referenznummer steht im Link
    const ba = /^\/jobsuche\/jobdetail\/([^/?#]+)/.exec(u.pathname);
    if (/(^|\.)arbeitsagentur\.de$/.test(u.hostname) && ba) {
      const res = await abruf(holen, `${BA}${b64(decodeURIComponent(ba[1]))}`, { headers: { 'X-API-Key': 'jobboerse-jobsuche', Accept: 'application/json' } });
      return nachStatus(res.status, 'Arbeitsagentur');
    }
    // EURES: Kennung steht im Link
    const eu = /\/jv-details\/([^/?#]+)/.exec(u.pathname);
    if (u.hostname === 'europa.eu' && eu) {
      const res = await abruf(holen, `${EURES}${eu[1]}?lang=de`, { headers: { Accept: 'application/json' } });
      return nachStatus(res.status, 'EURES');
    }
    // Alle anderen Seiten: Status und eindeutige Sätze im Text
    const res = await abruf(holen, url, { headers: { 'User-Agent': BROWSER, Accept: 'text/html,application/xhtml+xml', 'Accept-Language': 'de,en;q=0.8' } });
    if (res.status === 404 || res.status === 410) return { status: 'weg', grund: `Seite antwortet ${res.status}` };
    if (!res.ok) return { status: 'unklar', grund: `Seite antwortet ${res.status}` };
    const text = (await res.text()).slice(0, 400_000).replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const satz = BEENDET.map((r) => r.exec(text)?.[0]).find(Boolean);
    if (satz) return { status: 'weg', grund: `Seite sagt: „${satz.slice(0, 80)}“` };
    return { status: 'online', grund: `Seite ${res.status}` };
  } catch (e) {
    return { status: 'unklar', grund: `nicht erreichbar (${e instanceof Error ? e.name : 'Fehler'})` };
  }
}

/**
 * Viele Anzeigen prüfen, höchstens `gleichzeitig` auf einmal und je Domain nacheinander mit kurzer Pause,
 * damit keine Seite von uns überrannt wird.
 * @template {{ url: string | null }} T
 * @param {Holen} holen @param {T[]} anzeigen @param {{ gleichzeitig?: number, pauseMs?: number }} [o]
 * @returns {Promise<(T & { befund: Befund })[]>}
 */
export async function pruefeAlle(holen, anzeigen, { gleichzeitig = 6, pauseMs = 300 } = {}) {
  /** @type {Map<string, T[]>} */
  const jeHost = new Map();
  for (const a of anzeigen) {
    let host = 'ohne';
    try { host = new URL(String(a.url)).hostname; } catch { /* bleibt „ohne“ */ }
    jeHost.set(host, [...(jeHost.get(host) ?? []), a]);
  }
  // Große Hosts (die Schnittstellen) in Stücke teilen, damit sie nicht alles aufhalten: höchstens 3 Stücke gleichzeitig je Host
  const reihen = [...jeHost.values()].flatMap((r) => { const n = Math.min(3, Math.ceil(r.length / 40)); return Array.from({ length: n }, (_, k) => r.filter((_, j) => j % n === k)); });
  /** @type {(T & { befund: Befund })[]} */
  const aus = [];
  let i = 0;
  const arbeiter = async () => {
    while (i < reihen.length) {
      const reihe = reihen[i++];
      for (const a of reihe) {
        aus.push({ ...a, befund: await anzeigeStatus(holen, a.url) });
        if (pauseMs) await new Promise((r) => setTimeout(r, pauseMs));
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(gleichzeitig, reihen.length) }, arbeiter));
  return aus;
}

/** Ist die Bewerbungsfrist vorbei? Frist am selben Tag gilt noch. */
export function fristVorbei(/** @type {string | null | undefined} */ frist, heute = new Date().toISOString().slice(0, 10)) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(frist ?? '')) && String(frist) < heute;
}
