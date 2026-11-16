// Jobbster · Zugriff auf die Claude API (ohne Abhängigkeiten, läuft in Node und in Deno)
// Der Transport (post) wird von außen übergeben: node:https im Worker, fetch in der Edge Function.

export const HAIKU = 'claude-haiku-5-5';
export const SONNET = 'claude-sonnet-5-5';

// USD pro 1 Mio. Tokens, Stand 11.11.2026: platform.claude.com/docs/en/about-claude/pricing
export const PREISE = {
  [HAIKU]: { in: 0.1, out: 0.5, cw: 0.125, cr: 0.01, lang: { ab: 100_000, in: 0.5, out: 2.5, cw: 0.625, cr: 0.05 } },
  [SONNET]: { in: 2, out: 10, cw: 2.5, cr: 0.1 },
  'claude-opus-5-5': { in: 4, out: 20, cw: 5, cr: 0.2 },
};
export const SUCHE_USD = 0.01; // 10 $ pro 1.000 Suchen

/** Kosten einer Anfrage. Vorsichtig gerechnet: Haiku über 100.000 Prompt-Tokens zum höheren Preis. */
export function kosten(model, u = {}) {
  const p = PREISE[model] ?? PREISE[SONNET];
  const i = u.input_tokens || 0;
  const o = u.output_tokens || 0;
  const cw = u.cache_creation_input_tokens || 0;
  const cr = u.cache_read_input_tokens || 0;
  const q = p.lang && i + cw + cr > p.lang.ab ? p.lang : p;
  return (i * q.in + o * q.out + cw * q.cw + cr * q.cr) / 1e6 + (u.server_tool_use?.web_search_requests || 0) * SUCHE_USD;
}

/** Schlüssel und Kopfzeilen nie in Fehlermeldungen: Diese landen in der Datenbank und in Protokollen. */
export function verdecke(s) {
  return String(s ?? '')
    .replace(/sk-ant-[A-Za-z0-9_-]+/g, 'sk-ant-***')
    .replace(/(Invalid header value:?)[\s\S]*/i, '$1 (verdeckt)');
}

/** Schlüssel prüfen, bevor er in eine Kopfzeile kommt. Leerzeichen, Zeilenumbrüche oder Vorspann machen ihn unbrauchbar. */
export function schluesselOk(k) {
  return typeof k === 'string' && /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(k);
}

export class ApiFehler extends Error {
  constructor(status, message) {
    super(verdecke(message));
    this.status = status;
  }
}

const schlaf = (ms) => new Promise((r) => setTimeout(r, ms));

/** Werkzeug-Sätze: „filter“ lässt Claude Suchergebnisse per Code vorfiltern, „einfach“ lädt alles in den Kontext. */
export function werkzeuge(variante, { suchen, abrufe = 0, land, zeitzone }) {
  const ort = land || zeitzone ? { type: 'approximate', ...(land ? { country: land } : {}), ...(zeitzone ? { timezone: zeitzone } : {}) } : null;
  const saetze = {
    filter: [['web_search_20260318', 'web_fetch_20260318'], ['web_search_20260209', 'web_fetch_20260209'], ['web_search_20250305', 'web_fetch_20250910']],
    einfach: [['web_search_20250305', 'web_fetch_20250910']],
  }[variante] ?? [['web_search_20250305', 'web_fetch_20250910']];
  return saetze.map(([s, f]) => {
    const t = [{ type: s, name: 'web_search', max_uses: suchen, ...(ort ? { user_location: ort } : {}) }];
    if (abrufe > 0) t.push({ type: f, name: 'web_fetch', max_uses: abrufe, max_content_tokens: 5000 });
    return { name: s, tools: t };
  });
}

export function createClaude({ post, log = () => {}, wartenMaxS = 90 }) {
  let version = '2023-06-01';
  let gesamtUsd = 0; // alles, was dieser Client je ausgegeben hat (auch bei später fehlgeschlagenen Aufträgen)
  /** @type {Map<string, string>} gemerkt je Modell, damit die Rückfrage nur einmal anfällt */
  const ohneDenken = new Map();

  async function api(body) {
    let letzter = null;
    for (let versuch = 0; versuch < 4; versuch++) {
      let res;
      try {
        res = await post(body, version);
      } catch (e) {
        letzter = new ApiFehler(0, `Netzwerk: ${verdecke(e.message)}`);
        await schlaf(Math.min(5 * (versuch + 1), wartenMaxS) * 1000);
        continue;
      }
      if (res.status === 200 && res.json) return res.json;
      const msg = res.json?.error?.message || String(res.text || '').slice(0, 300);
      if (res.status === 400 && /anthropic-version/i.test(msg) && version !== '2023-06-01') {
        version = '2023-06-01';
        continue;
      }
      if ([408, 409, 429, 500, 502, 503, 504, 529].includes(res.status)) {
        const warte = Math.min(Number(res.retryAfter) || 10 * (versuch + 1), wartenMaxS);
        log(`API ${res.status}, neuer Versuch in ${warte} s`);
        letzter = new ApiFehler(res.status, msg);
        await schlaf(warte * 1000);
        continue;
      }
      throw new ApiFehler(res.status, msg);
    }
    throw letzter ?? new ApiFehler(0, 'unbekannter Fehler');
  }

  /**
   * Eine Anfrage samt Fortsetzungen nach pause_turn. Gibt Text und Verbrauch zurück.
   * denken: false schaltet das Nachdenken vor der Antwort ab. Es zählt als Ausgabe (teuer, langsam, frisst max_tokens)
   * und bringt bei Aufgaben mit festem Schema wenig. aufwand: 'low' | 'medium' | 'high' steuert die Gründlichkeit.
   * Lehnt die API eine der beiden Angaben ab (400), läuft die Anfrage mit dem von ihr genannten Wert oder ohne sie.
   */
  async function zug({ model, system, user, tools, format, maxTokens = 16000, denken = true, aufwand = null }) {
    const messages = [{ role: 'user', content: user }];
    const t0 = Date.now();
    const texte = [];
    const werkzeugFehler = [];
    let pausiert = [];
    let stop = null;
    const n = { anfragen: 0, tokensEin: 0, tokensAus: 0, tokensDenken: 0, suchen: 0, abrufe: 0, usd: 0 };
    let steuerung = !denken || Boolean(aufwand);
    let denkArt = ohneDenken.get(model) ?? 'disabled'; // je Modell heißt „ohne Nachdenken“ anders
    const suchbegriffe = [];

    for (let runde = 0; runde < 10; runde++) {
      const body = { model, max_tokens: maxTokens, system, messages: pausiert.length ? [...messages, { role: 'assistant', content: pausiert }] : messages };
      if (tools?.length) body.tools = tools;
      if (format) body.output_config = { format: { type: 'json_schema', schema: format } };
      if (steuerung && !denken) body.thinking = { type: denkArt };
      if (steuerung && aufwand) body.output_config = { ...body.output_config, effort: aufwand };
      let res;
      try {
        res = await api(body);
      } catch (e) {
        if (!(steuerung && e.status === 400 && /thinking|effort/i.test(e.message))) throw e;
        // Manche Modelle nennen den Wert selbst, mit dem das Nachdenken vor der Antwort entfällt
        const andere = !denken && denkArt === 'disabled' && /between_tools/.test(e.message) ? 'between_tools' : null;
        if (andere) {
          denkArt = andere;
          ohneDenken.set(model, andere);
        } else {
          log(`Steuerung abgelehnt, weiter ohne: ${String(e.message).slice(0, 100)}`);
          steuerung = false;
        }
        runde--;
        continue;
      }
      const u = res.usage || {};
      n.anfragen += 1;
      n.tokensEin += (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
      n.tokensAus += u.output_tokens || 0;
      n.tokensDenken += u.output_tokens_details?.thinking_tokens || 0;
      n.suchen += u.server_tool_use?.web_search_requests || 0;
      n.abrufe += u.server_tool_use?.web_fetch_requests || 0;
      n.usd += kosten(model, u);
      gesamtUsd += kosten(model, u);
      for (const b of res.content || []) {
        if (b.type === 'text') texte.push(b.text);
        if (b.type === 'server_tool_use' && b.name === 'web_search' && b.input?.query) suchbegriffe.push(String(b.input.query).slice(0, 120));
        const c = b.content;
        if (c && !Array.isArray(c) && typeof c === 'object' && /_error$/.test(c.type || '')) werkzeugFehler.push(c.error_code);
      }
      stop = res.stop_reason;
      if (stop !== 'pause_turn') break;
      pausiert = [...pausiert, ...(res.content || [])];
    }
    return { text: texte.join(''), stop, ms: Date.now() - t0, model, werkzeugFehler, suchbegriffe, ...n };
  }

  /** Wie zug, probiert aber Werkzeug-Sätze der Reihe nach, falls die API einen ablehnt (400). */
  async function zugMitWerkzeugen(opts, saetze) {
    let letzter = null;
    for (const satz of saetze) {
      try {
        const r = await zug({ ...opts, tools: satz.tools });
        return { ...r, werkzeug: satz.name };
      } catch (e) {
        if (e.status !== 400) throw e;
        log(`${satz.name} abgelehnt: ${String(e.message).slice(0, 120)}`);
        letzter = e;
      }
    }
    throw letzter ?? new ApiFehler(400, 'Kein Werkzeug-Satz akzeptiert');
  }

  return { zug, zugMitWerkzeugen, usd: () => gesamtUsd };
}

export function leseJson(text) {
  try { return JSON.parse(text); } catch { /* weiter */ }
  const a = String(text).indexOf('{');
  const b = String(text).lastIndexOf('}');
  if (a >= 0 && b > a) {
    try { return JSON.parse(String(text).slice(a, b + 1)); } catch { /* weiter */ }
  }
  return null;
}

/** Verbrauch mehrerer Züge zusammenzählen. */
export function summe(...zuege) {
  const s = { anfragen: 0, tokensEin: 0, tokensAus: 0, tokensDenken: 0, suchen: 0, abrufe: 0, usd: 0, ms: 0 };
  for (const z of zuege) if (z) for (const k of Object.keys(s)) s[k] += z[k] || 0;
  return s;
}
