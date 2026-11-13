// Jobbster · Entwurf sofort schreiben, direkt nach dem Klick.
// Nimmt nur einen eigenen, wartenden Entwurfs-Auftrag aus der Warteschlange (angelegt über request_run).
// Gleiche Regeln wie der Worker: Not-Aus, Tageslimit, Protokoll in runs. Klappt es nicht, bleibt der Auftrag
// für den Worker liegen oder wird als Fehler markiert (zählt dann nicht gegen die Grenze des Nutzers).
// Secret: ANTHROPIC_API_KEY. Fehlt er, bleibt der Auftrag unangetastet für den Worker.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { createClaude } from "./lib/claude.mjs";
import { entwurf } from "./lib/agents.mjs";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const antwort = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return antwort(405, { ok: false, grund: "methode" });
  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return antwort(401, { ok: false, grund: "nicht_angemeldet" });
  let b: Record<string, unknown> = {};
  try { b = await req.json(); } catch { /* leer */ }
  const queueId = String(b.queue_id ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(queueId)) return antwort(400, { ok: false, grund: "eingabe" });

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) return antwort(503, { ok: false, grund: "ki_nicht_eingerichtet" });

  const url = Deno.env.get("SUPABASE_URL");
  const key = dienstSchluessel();
  if (!url || !key) return antwort(500, { ok: false, grund: "server_konfig" });
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: wer, error: tokenFehler } = await db.auth.getUser(token);
  if (tokenFehler || !wer?.user) return antwort(401, { ok: false, grund: "nicht_angemeldet" });
  const uid = wer.user.id;

  // Betriebsschalter und Tagesbudget
  const { data: cfg } = await db.from("app_config").select("key, value");
  const schalter = Object.fromEntries((cfg ?? []).map((r: { key: string; value: unknown }) => [r.key, r.value]));
  if (schalter.pausiert === true) return antwort(503, { ok: false, grund: "pausiert" });
  const tag = new Date().toISOString().slice(0, 10) + "T00:00:00Z";
  const { data: heute } = await db.from("runs").select("cost_usd").gte("created_at", tag);
  const summe = (heute ?? []).reduce((a: number, r: { cost_usd: number | null }) => a + Number(r.cost_usd ?? 0), 0);
  if (summe >= Number(schalter.tageslimit_usd ?? 3)) return antwort(503, { ok: false, grund: "tageslimit" });

  // Auftrag übernehmen: nur eigener, wartender Entwurf. Der Wechsel auf „laeuft“ ist atomar.
  const { data: auftrag } = await db.from("queue")
    .update({ status: "laeuft", started_at: new Date().toISOString() })
    .eq("id", queueId).eq("user_id", uid).eq("kind", "entwurf").eq("status", "wartet")
    .select("*").maybeSingle();
  if (!auftrag) return antwort(409, { ok: false, grund: "nicht_verfuegbar" });

  const t0 = Date.now();
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
    wartenMaxS: 10,
  });

  try {
    const [{ data: mitglied }, { data: profil }, { data: lead }] = await Promise.all([
      db.from("members").select("status, valid_until").eq("user_id", uid).maybeSingle(),
      db.from("job_profile").select("*").eq("user_id", uid).maybeSingle(),
      db.from("job_leads").select("*").eq("id", auftrag.lead_id).eq("user_id", uid).maybeSingle(),
    ]);
    if (!mitglied || mitglied.status !== "aktiv" || (mitglied.valid_until && Date.parse(mitglied.valid_until) <= Date.now())) throw new Error("Kein aktiver Zugang");
    if (!profil || String(profil.cv_text ?? "").length < 200) throw new Error("Profil ohne Lebenslauf");
    if (!lead) throw new Error("Treffer nicht gefunden");

    const r = await entwurf({ claude, profil, lead });
    const { error: speicherFehler } = await db.from("job_leads").update({ ...r.felder, drafted_at: new Date().toISOString(), ...(lead.status === "neu" ? { status: "entwurf" } : {}) }).eq("id", lead.id).eq("user_id", uid);
    if (speicherFehler) throw new Error(`Speichern: ${speicherFehler.message}`);
    await db.from("runs").insert({
      user_id: uid, queue_id: auftrag.id, agent: "writer", model: r.model, requests: r.nutzung.anfragen, searches: r.nutzung.suchen, fetches: r.nutzung.abrufe,
      input_tokens: r.nutzung.tokensEin, output_tokens: r.nutzung.tokensAus, cost_usd: Number(r.nutzung.usd.toFixed(4)), duration_ms: Date.now() - t0, result_count: 1, status: "ok",
    });
    await db.from("queue").update({ status: "fertig", finished_at: new Date().toISOString() }).eq("id", auftrag.id);
    return antwort(200, { ok: true, sekunden: Math.round((Date.now() - t0) / 1000) });
  } catch (e) {
    const grund = String((e as Error).message ?? e).slice(0, 300);
    console.error("run-now", grund);
    await db.from("runs").insert({ user_id: uid, queue_id: auftrag.id, agent: "writer", cost_usd: Number(claude.usd().toFixed(4)), duration_ms: Date.now() - t0, status: "fehler", error: grund });
    await db.from("queue").update({ status: "fehler", error: grund, finished_at: new Date().toISOString() }).eq("id", auftrag.id);
    return antwort(500, { ok: false, grund: "fehler" });
  }
});
