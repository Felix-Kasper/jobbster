// Jobbster · Takt: Zeitplan und Warteschlange, angestoßen von pg_cron in der Datenbank.
// Ersetzt die Zeitpläne in GitHub Actions, die bei kleinen Projekten oft Stunden zu spät starten.
// Aufgaben (Feld „aufgabe“ im Body):
//   auftrag     den ältesten wartenden Auftrag erledigen (Scout, Entwurf, Vorbereitung)
//   plan        fällige Scout-Läufe für alle aktiven Nutzer einreihen (morgens)
//   aufraeumen  offene Treffer prüfen, ob die Anzeige noch online ist (morgens, in Portionen)
// Geschützt durch einen Takt-Schlüssel, den nur die Datenbank kennt (public.takt_pruefen).
// Die Arbeit läuft im Hintergrund weiter (EdgeRuntime.waitUntil), damit pg_net nicht warten muss.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClaude, schluesselOk, verdecke } from "./lib/claude.mjs";
import { aufraeumen, bearbeiteNaechsten, datenbank, haengendeFreigeben, plane, schalterLesen } from "./lib/betrieb.mjs";

const antwort = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function dienstSchluessel(): string | null {
  const alt = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (alt) return alt;
  try {
    const erster = Object.values(JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}"))[0];
    return typeof erster === "string" ? erster : null;
  } catch {
    return null;
  }
}

// Supabase beendet eine Funktion nach 150 s. Ein Scout braucht 40 bis 90 s, Aufräumen in Portionen von 150 Treffern rund 40 s.
const AUFRAEUMEN_PORTION = 150;

async function arbeite(aufgabe: string, db: ReturnType<typeof datenbank>) {
  const log = (m: string) => console.log(`[takt ${aufgabe}] ${verdecke(m)}`);
  const schalter = await schalterLesen(db);
  if (schalter.pausiert === true) return log("Not-Aus ist an, nichts zu tun.");

  if (aufgabe === "plan") {
    await haengendeFreigeben(db, 10);
    await plane({ db, log });
    return;
  }
  if (aufgabe === "aufraeumen") {
    await aufraeumen({ db, holen: fetch, max: AUFRAEUMEN_PORTION, log });
    return;
  }

  const apiKey = (Deno.env.get("ANTHROPIC_API_KEY") ?? "").trim();
  if (!schluesselOk(apiKey)) return log("ANTHROPIC_API_KEY fehlt oder hat ein ungültiges Format (Wert verdeckt).");
  const claude = createClaude({
    post: async (body: unknown, version: string) => {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": version },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { /* kein JSON */ }
      return { status: res.status, json, text, retryAfter: res.headers.get("retry-after") };
    },
    log,
    wartenMaxS: 15,
  });
  const r = await bearbeiteNaechsten({ db, claude, holen: fetch, tageslimit: Number(schalter.tageslimit_usd ?? 3), log });
  if (r.ergebnis === "limit") log(`Tageslimit erreicht (${Number(r.heute).toFixed(2)} $). Aufträge warten bis morgen.`);
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return antwort(405, { ok: false });
  const url = Deno.env.get("SUPABASE_URL");
  const key = dienstSchluessel();
  if (!url || !key) return antwort(500, { ok: false, grund: "server_konfig" });
  const db = datenbank(url.replace(/\/$/, ""), key, fetch);

  let b: Record<string, unknown> = {};
  try { b = await req.json(); } catch { /* leer */ }
  const aufgabe = String(b.aufgabe ?? "");
  if (!["auftrag", "plan", "aufraeumen"].includes(aufgabe)) return antwort(400, { ok: false, grund: "aufgabe" });

  // Nur die Datenbank kennt den Schlüssel. Die Antwort bei falschem Schlüssel verrät nichts darüber.
  const schluessel = req.headers.get("x-takt") ?? "";
  let echt = false;
  try { echt = schluessel.length >= 32 && (await db("POST", "rpc/takt_pruefen", { p: schluessel })) === true; } catch { echt = false; }
  if (!echt) return antwort(401, { ok: false });

  // @ts-ignore EdgeRuntime gibt es nur in Supabase
  EdgeRuntime.waitUntil(arbeite(aufgabe, db).catch((e) => console.error(`[takt ${aufgabe}] ✖ ${verdecke(String(e?.message ?? e)).slice(0, 300)}`)));
  return antwort(202, { ok: true });
});
