// Jobbster · Bezahlung: Checkout für Probe und Abo, Kundenportal zum Kündigen und Verwalten.
// Secrets: STRIPE_SECRET_KEY, STRIPE_PRICE_ID, APP_URL (Adresse der App, z. B. https://app.zusage.at).
// Fehlen sie, antwortet die Funktion mit grund „zahlung_nicht_eingerichtet“ statt etwas vorzutäuschen.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return antwort(405, { ok: false, grund: "methode" });

  const token = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token) return antwort(401, { ok: false, grund: "nicht_angemeldet" });
  let b: Record<string, unknown> = {};
  try { b = await req.json(); } catch { /* leer */ }
  const action = String(b.action ?? "");
  if (action !== "checkout" && action !== "portal") return antwort(400, { ok: false, grund: "eingabe" });

  const url = Deno.env.get("SUPABASE_URL");
  const key = dienstSchluessel();
  if (!url || !key) return antwort(500, { ok: false, grund: "server_konfig" });
  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: wer, error: tokenFehler } = await admin.auth.getUser(token);
  if (tokenFehler || !wer?.user) return antwort(401, { ok: false, grund: "nicht_angemeldet" });
  const uid = wer.user.id;

  const secret = Deno.env.get("STRIPE_SECRET_KEY");
  const price = Deno.env.get("STRIPE_PRICE_ID");
  const appUrl = (Deno.env.get("APP_URL") ?? "").replace(/\/$/, "");
  if (!secret || !price || !appUrl) return antwort(503, { ok: false, grund: "zahlung_nicht_eingerichtet" });

  const { data: m } = await admin.from("members").select("status, stripe_customer_id, stripe_subscription_id, sub_status, trial_used").eq("user_id", uid).maybeSingle();
  if (!m || m.status !== "aktiv") return antwort(403, { ok: false, grund: "kein_zugang" });

  try {
    if (action === "portal") {
      if (!m.stripe_customer_id) return antwort(400, { ok: false, grund: "kein_kunde" });
      const s = await stripe(secret, "POST", "billing_portal/sessions", { customer: m.stripe_customer_id, return_url: `${appUrl}/konto` });
      return antwort(200, { ok: true, url: s.url });
    }

    // Kein zweites Abo: Wer eines hat, verwaltet es im Portal.
    if (m.sub_status && ["trialing", "active", "past_due", "unpaid", "incomplete"].includes(m.sub_status)) {
      return antwort(409, { ok: false, grund: "hat_abo" });
    }

    let kunde = m.stripe_customer_id as string | null;
    if (!kunde) {
      const c = await stripe(secret, "POST", "customers", { email: wer.user.email, metadata: { user_id: uid } }, { idempotencyKey: `kunde-${uid}` });
      kunde = c.id;
      // Nur setzen, wenn noch leer: schützt vor zwei gleichzeitigen Klicks
      await admin.from("members").update({ stripe_customer_id: kunde }).eq("user_id", uid).is("stripe_customer_id", null);
      const { data: neu } = await admin.from("members").select("stripe_customer_id").eq("user_id", uid).single();
      kunde = neu?.stripe_customer_id ?? kunde;
    }

    const probe = !m.trial_used;
    const s = await stripe(secret, "POST", "checkout/sessions", {
      mode: "subscription",
      customer: kunde,
      client_reference_id: uid,
      line_items: [{ price, quantity: 1 }],
      locale: "de",
      allow_promotion_codes: "true",
      billing_address_collection: "auto",
      payment_method_collection: "always",
      subscription_data: {
        metadata: { user_id: uid },
        ...(probe ? { trial_period_days: 7, trial_settings: { end_behavior: { missing_payment_method: "cancel" } } } : {}),
      },
      // Hinweis über dem Bezahlknopf. Die Bedingungen hat der Nutzer schon bei der Registrierung akzeptiert.
      custom_text: { submit: { message: probe ? "7 Tage kostenlos. Danach monatlich, jederzeit im Konto kündbar." : "Monatlich, jederzeit im Konto kündbar." } },
      success_url: `${appUrl}/konto?zahlung=ok`,
      cancel_url: `${appUrl}/konto?zahlung=abbruch`,
    });
    return antwort(200, { ok: true, url: s.url });
  } catch (e) {
    console.error("billing", action, (e as Error).message);
    return antwort(502, { ok: false, grund: "stripe" });
  }
});
