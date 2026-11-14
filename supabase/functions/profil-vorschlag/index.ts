// Jobbster · Suchfelder aus „Beschreib deinen perfekten Job“ vorschlagen.
// Haiku ohne Werkzeuge, ein Bruchteil eines Cents pro Aufruf. Geht schon vor dem Start der Probe,
// damit der Fragebogen davon profitiert. Grenze: 6 Vorschläge pro Tag und Nutzer, dazu Not-Aus und Tageslimit.
// Secret: ANTHROPIC_API_KEY.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { createClaude } from "./lib/claude.mjs";
import { traumjobFelder } from "./lib/traumjob.mjs";

const PRO_TAG = 6;
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
  const text = String(b.text ?? "").trim();
  if (text.length < 40) return antwort(400, { ok: false, grund: "zu_kurz", text: "Beschreib deinen perfekten Job in zwei, drei Sätzen." });
  if (text.length > 2000) return antwort(400, { ok: false, grund: "zu_lang", text: "Bitte höchstens 2.000 Zeichen." });

  const apiKey = (Deno.env.get("ANTHROPIC_API_KEY") ?? "").trim();
  if (!apiKey) return antwort(503, { ok: false, grund: "ki_nicht_eingerichtet" });
  // Nur den reinen Schlüssel annehmen. Vorspann oder Zeilenumbruch im Secret würde ihn sonst in Fehlermeldungen tragen.
  if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(apiKey)) {
    console.error("ANTHROPIC_API_KEY hat ein ungültiges Format (Wert verdeckt)");
    return antwort(503, { ok: false, grund: "ki_schluessel_ungueltig" });
  }
  const url = Deno.env.get("SUPABASE_URL");
  const key = dienstSchluessel();
  if (!url || !key) return antwort(500, { ok: false, grund: "server_konfig" });
  const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: wer, error: tokenFehler } = await db.auth.getUser(token);
  if (tokenFehler || !wer?.user) return antwort(401, { ok: false, grund: "nicht_angemeldet" });
  const uid = wer.user.id;

  const { data: mitglied } = await db.from("members").select("status").eq("user_id", uid).maybeSingle();
  if (!mitglied || mitglied.status !== "aktiv") return antwort(403, { ok: false, grund: "kein_zugang" });

  const { data: cfg } = await db.from("app_config").select("key, value");
  const schalter = Object.fromEntries((cfg ?? []).map((r: { key: string; value: unknown }) => [r.key, r.value]));
  if (schalter.pausiert === true) return antwort(503, { ok: false, grund: "pausiert" });
  const tag = new Date().toISOString().slice(0, 10) + "T00:00:00Z";
  const { data: heute } = await db.from("runs").select("cost_usd, user_id, agent").gte("created_at", tag);
  const summe = (heute ?? []).reduce((a: number, r: { cost_usd: number | null }) => a + Number(r.cost_usd ?? 0), 0);
  if (summe >= Number(schalter.tageslimit_usd ?? 3)) return antwort(503, { ok: false, grund: "tageslimit" });
  const eigene = (heute ?? []).filter((r: { user_id: string; agent: string }) => r.user_id === uid && r.agent === "profil").length;
  if (eigene >= PRO_TAG) return antwort(429, { ok: false, grund: "grenze", text: "Für heute sind genug Vorschläge erstellt. Füll die Felder bitte selbst aus." });

  const t0 = Date.now();
  const claude = createClaude({
    post: async (body: unknown, version: string) => {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": version },
        body: JSON.stringify(body),
      });
      const t = await res.text();
      let json = null;
      try { json = JSON.parse(t); } catch { /* kein JSON */ }
      return { status: res.status, json, text: t, retryAfter: res.headers.get("retry-after") };
    },
    wartenMaxS: 8,
  });

  try {
    const r = await traumjobFelder({ claude, text });
    await db.from("runs").insert({
      user_id: uid, agent: "profil", model: r.model, requests: r.nutzung.anfragen, input_tokens: r.nutzung.tokensEin, output_tokens: r.nutzung.tokensAus,
      cost_usd: Number(r.nutzung.usd.toFixed(4)), duration_ms: Date.now() - t0, result_count: 1, status: "ok",
    });
    return antwort(200, { ok: true, felder: r.felder });
  } catch (e) {
    const grund = String((e as Error).message ?? e).replace(/sk-ant-[A-Za-z0-9_-]+/g, "sk-ant-***").replace(/(Invalid header value:?)[\s\S]*/i, "$1 (verdeckt)").slice(0, 300);
    console.error("profil-vorschlag", grund);
    await db.from("runs").insert({ user_id: uid, agent: "profil", cost_usd: Number(claude.usd().toFixed(4)), duration_ms: Date.now() - t0, status: "fehler", error: grund });
    return antwort(500, { ok: false, grund: "fehler" });
  }
});
