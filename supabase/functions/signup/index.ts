// Jobbster · Anmeldung mit Einladungscode oder (wenn freigeschaltet) offen
// Legt ein Konto nur an, wenn der Code gültig ist oder die offene Registrierung an ist. Es wird keine E-Mail verschickt
// (der eingebaute Mailversand von Supabase liefert nur an Team-Mitglieder).
// verify_jwt ist aus: Die Funktion prüft selbst, und zwar den Einladungscode.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const VERSION = "2026-11-beta"; // Stand der Datenschutzerklärung und der Beta-Bedingungen

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const antwort = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const warte = (ms: number) => new Promise((r) => setTimeout(r, ms));

function dienstSchluessel(): string | null {
  const alt = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (alt) return alt;
  try {
    const neu = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") ?? "{}");
    const erster = Object.values(neu)[0];
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
  const email = String(b.email ?? "").trim().toLowerCase();
  const password = String(b.password ?? "");
  const code = String(b.code ?? "").trim();

  if (email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return antwort(400, { ok: false, grund: "email" });
  if (password.length < 10 || password.length > 200) return antwort(400, { ok: false, grund: "passwort" });
  if (b.consent !== true) return antwort(400, { ok: false, grund: "einwilligung" });
  if (code && (code.length < 8 || code.length > 64)) {
    await warte(800);
    return antwort(403, { ok: false, grund: "code" });
  }

  const url = Deno.env.get("SUPABASE_URL");
  const key = dienstSchluessel();
  if (!url || !key) return antwort(500, { ok: false, grund: "server_konfig" });
  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  // Ohne Code nur, wenn die offene Registrierung an ist. Das Konto hat dann noch keinen Zugang:
  // Die Probe startet erst über die Bezahlseite (Karte nötig, 7 Tage gratis). So entstehen keine KI-Kosten durch Wegwerf-Konten.
  if (!code) {
    const { data: offen } = await admin.from("app_config").select("value").eq("key", "offene_registrierung").maybeSingle();
    if (offen?.value !== true) return antwort(403, { ok: false, grund: "code_noetig" });
    const { data: neuOffen, error: fehlerOffen } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
    if (fehlerOffen || !neuOffen?.user) {
      const gibtEs = /already|registered|exists/i.test(fehlerOffen?.message ?? "");
      return antwort(gibtEs ? 409 : 400, { ok: false, grund: gibtEs ? "konto_existiert" : "konto" });
    }
    const id = neuOffen.user.id;
    const { error: m1 } = await admin.from("members").insert({ user_id: id, plan: "neu", valid_until: new Date().toISOString() });
    const { error: m2 } = m1 ? { error: null } : await admin.from("consents").insert([
      { user_id: id, kind: "datenschutz", version: VERSION },
      { user_id: id, kind: "beta_bedingungen", version: VERSION },
    ]);
    if (m1 || m2) {
      await admin.auth.admin.deleteUser(id);
      return antwort(500, { ok: false, grund: "server" });
    }
    return antwort(200, { ok: true, gueltig_bis: null, probe: false, start: "zahlung" });
  }

  // 0. Der Code für den automatischen Rauchtest (steht im öffentlichen Repo) gilt nur für Test-Adressen
  const { data: art } = await admin.from("invites").select("note").eq("code", code).maybeSingle();
  if (art?.note === "Rauchtest" && !email.endsWith("@jobbster.invalid")) {
    await warte(800);
    return antwort(403, { ok: false, grund: "code" });
  }

  // 1. Code einlösen (ein einziger UPDATE, also sicher gegen gleichzeitige Anmeldungen)
  // Der Code bringt Tage und Tarif mit. Die Laufzeit beginnt jetzt, beim Einlösen.
  const { data: eingeloest, error: codeFehler } = await admin.rpc("claim_invite_v2", { p_code: code });
  if (codeFehler) return antwort(500, { ok: false, grund: "server" });
  const tage = Number(eingeloest?.days);
  if (!eingeloest || !Number.isFinite(tage) || tage < 1) {
    await warte(800);
    return antwort(403, { ok: false, grund: "code" });
  }
  const gueltigBis = new Date(Date.now() + tage * 86_400_000).toISOString();

  // 2. Konto anlegen, sofort bestätigt
  const { data: neu, error: kontoFehler } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (kontoFehler || !neu?.user) {
    await admin.rpc("release_invite", { p_code: code });
    const gibtEs = /already|registered|exists/i.test(kontoFehler?.message ?? "");
    return antwort(gibtEs ? 409 : 400, { ok: false, grund: gibtEs ? "konto_existiert" : "konto" });
  }
  const uid = neu.user.id;

  // 3. Mitgliedschaft und Einwilligung festhalten. Scheitert das, wird alles zurückgenommen.
  // Bringt der Code eigene Grenzen mit (Probe), gelten sie für dieses Mitglied. Sonst die normalen.
  const grenzen = eingeloest.limits && typeof eingeloest.limits === "object" ? eingeloest.limits : null;
  const { error: mitgliedFehler } = await admin.from("members").insert({ user_id: uid, invite_code: code, plan: String(eingeloest.plan ?? "beta"), valid_until: gueltigBis, limits: grenzen });
  const { error: einwFehler } = mitgliedFehler
    ? { error: null }
    : await admin.from("consents").insert([
      { user_id: uid, kind: "datenschutz", version: VERSION },
      { user_id: uid, kind: "beta_bedingungen", version: VERSION },
    ]);
  if (mitgliedFehler || einwFehler) {
    await admin.auth.admin.deleteUser(uid);
    await admin.rpc("release_invite", { p_code: code });
    return antwort(500, { ok: false, grund: "server" });
  }

  return antwort(200, { ok: true, gueltig_bis: gueltigBis, probe: grenzen !== null });
});
