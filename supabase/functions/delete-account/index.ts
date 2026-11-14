// Jobbster · „Meine Daten löschen“
// Löscht die Dateien des angemeldeten Nutzers (Lebenslauf, Verträge) und dann das Konto.
// Profil, Treffer, Entwürfe, Warteschlange, Mitgliedschaft, Einwilligungen und Feedback hängen per Kaskade am Konto.
// Im Kosten-Protokoll bleibt nur eine Zeile ohne Nutzerbezug.
// verify_jwt ist aus: Die Funktion prüft das Anmelde-Token selbst über den Auth-Server.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { stripe } from "./stripe.mjs";

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

// Alle Dateien unter einem Ordner einsammeln (bis 3 Ebenen tief)
async function dateien(admin: SupabaseClient, bucket: string, ordner: string, tiefe = 0): Promise<string[]> {
  const { data, error } = await admin.storage.from(bucket).list(ordner, { limit: 1000 });
  if (error || !data) return [];
  const pfade: string[] = [];
  for (const e of data) {
    const pfad = `${ordner}/${e.name}`;
    if (e.id === null && tiefe < 3) pfade.push(...(await dateien(admin, bucket, pfad, tiefe + 1)));
    else if (e.id !== null) pfade.push(pfad);
  }
  return pfade;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return antwort(405, { ok: false, grund: "methode" });

  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return antwort(401, { ok: false, grund: "nicht_angemeldet" });

  let b: Record<string, unknown> = {};
  try {
    b = await req.json();
  } catch { /* leerer Rumpf */ }
  const wort = String(b.confirm ?? "").trim().toUpperCase();
  if (wort !== "LÖSCHEN" && wort !== "LOESCHEN") return antwort(400, { ok: false, grund: "bestaetigung" });

  const url = Deno.env.get("SUPABASE_URL");
  const key = dienstSchluessel();
  if (!url || !key) return antwort(500, { ok: false, grund: "server_konfig" });
  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  const { data: wer, error: tokenFehler } = await admin.auth.getUser(token);
  if (tokenFehler || !wer?.user) return antwort(401, { ok: false, grund: "nicht_angemeldet" });
  const uid = wer.user.id;

  // Laufendes Abo zuerst bei Stripe beenden, damit nach dem Löschen nichts mehr abgebucht wird.
  const { data: m } = await admin.from("members").select("stripe_subscription_id, sub_status").eq("user_id", uid).maybeSingle();
  if (m?.stripe_subscription_id && ["trialing", "active", "past_due", "unpaid", "incomplete", "paused"].includes(m.sub_status ?? "")) {
    const secret = Deno.env.get("STRIPE_SECRET_KEY");
    if (!secret) return antwort(409, { ok: false, grund: "abo_aktiv" });
    try {
      await stripe(secret, "DELETE", `subscriptions/${m.stripe_subscription_id}`, {});
    } catch (e) {
      if ((e as { code?: string }).code !== "resource_missing") return antwort(502, { ok: false, grund: "abo_aktiv" });
    }
  }

  let geloeschteDateien = 0;
  for (const bucket of ["cvs", "contracts"]) {
    const pfade = await dateien(admin, bucket, uid);
    if (pfade.length) {
      const { error } = await admin.storage.from(bucket).remove(pfade);
      if (error) return antwort(500, { ok: false, grund: "dateien" });
      geloeschteDateien += pfade.length;
    }
  }

  const { error: kontoFehler } = await admin.auth.admin.deleteUser(uid);
  if (kontoFehler) return antwort(500, { ok: false, grund: "konto" });

  return antwort(200, { ok: true, dateien: geloeschteDateien });
});
