// Jobbster · „Gratis testen“ auf der Landingpage
// Trägt die Adresse in die Warteliste ein und gibt, wenn erlaubt, sofort einen Probe-Code zurück (seit 23.11.2026).
// Die Landingpage schickt dann direkt zur Anmeldung. Öffentlich aufrufbar (verify_jwt aus).
// Schutz: Pflichtfeld Einwilligung, verstecktes Köderfeld gegen Bots, Mengenbremsen in der Datenbank
// (200 Einträge pro Stunde, höchstens app_config.probe_selbst.pro_tag Codes am Tag, ein Code pro Adresse,
// Code nur 3 Tage einlösbar). Not-Aus: probe_selbst.an = false, dann nur Warteliste wie vorher.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const VERSION = "2026-11-beta";

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

  let b: Record<string, unknown>;
  try {
    b = await req.json();
  } catch {
    return antwort(400, { ok: false, grund: "eingabe" });
  }
  // Köderfeld: Menschen sehen es nicht, Bots füllen es aus. Dann so tun, als hätte es geklappt.
  if (String(b.website ?? "") !== "") return antwort(200, { ok: true });

  const email = String(b.email ?? "").trim().toLowerCase();
  if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return antwort(400, { ok: false, grund: "email" });
  if (b.consent !== true) return antwort(400, { ok: false, grund: "einwilligung" });

  const url = Deno.env.get("SUPABASE_URL");
  const key = dienstSchluessel();
  if (!url || !key) return antwort(500, { ok: false, grund: "server_konfig" });
  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  const { data, error } = await admin.rpc("waitlist_probe", {
    p_email: email,
    p_source: String(b.source ?? "").slice(0, 60),
    p_note: String(b.note ?? "").slice(0, 500),
    p_version: VERSION,
  });
  if (error) return antwort(500, { ok: false, grund: "server" });
  const status = String((data as { status?: string } | null)?.status ?? "");
  if (status === "voll") return antwort(429, { ok: false, grund: "spaeter" });
  if (status === "code") return antwort(200, { ok: true, code: String((data as { code?: string }).code ?? "") });
  if (status === "konto") return antwort(200, { ok: true, konto: true });
  return antwort(200, { ok: true });
});
