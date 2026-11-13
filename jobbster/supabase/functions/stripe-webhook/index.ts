// Jobbster · Stripe-Webhook. Übernimmt Abo-Stand und Laufzeit in members.
// Secrets: STRIPE_WEBHOOK_SECRET (whsec_…). verify_jwt ist aus: Stripe schickt kein Supabase-Token, geprüft wird die Signatur.
// Jedes Ereignis wird genau einmal verarbeitet (Tabelle stripe_events). Bei einem Fehler wird der Eintrag zurückgenommen,
// damit Stripe es erneut schickt.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import { stripe, subscriptionUpdate, verifySignature } from "./stripe.mjs";

const antwort = (status: number, body: Record<string, unknown>) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

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

const RELEVANT = new Set([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
  "invoice.paid",
  "invoice.payment_failed",
]);

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return antwort(405, { ok: false });
  const secret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
  const api = Deno.env.get("STRIPE_SECRET_KEY");
  if (!secret || !api) return antwort(503, { ok: false, grund: "zahlung_nicht_eingerichtet" });

  const payload = await req.text();
  if (!(await verifySignature(payload, req.headers.get("Stripe-Signature"), secret))) return antwort(400, { ok: false, grund: "signatur" });

  let ev: { id: string; type: string; data: { object: Record<string, unknown> } };
  try { ev = JSON.parse(payload); } catch { return antwort(400, { ok: false, grund: "eingabe" }); }
  if (!RELEVANT.has(ev.type)) return antwort(200, { ok: true, ignoriert: ev.type });

  const url = Deno.env.get("SUPABASE_URL");
  const key = dienstSchluessel();
  if (!url || !key) return antwort(500, { ok: false, grund: "server_konfig" });
  const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  const { error: dup } = await admin.from("stripe_events").insert({ id: ev.id, type: ev.type });
  if (dup) {
    if (dup.code === "23505") return antwort(200, { ok: true, doppelt: true });
    return antwort(500, { ok: false, grund: "db" });
  }

  try {
    const o = ev.data.object as Record<string, unknown>;
    // Immer den aktuellen Stand des Abos bei Stripe holen: Ereignisse können in falscher Reihenfolge ankommen.
    let subId: string | null = null;
    let user: string | null = null;
    if (ev.type === "checkout.session.completed") {
      subId = (o.subscription as string) ?? null;
      user = (o.client_reference_id as string) ?? null;
    } else if (ev.type.startsWith("invoice.")) {
      const parent = o.parent as { subscription_details?: { subscription?: string } } | undefined;
      subId = (o.subscription as string) ?? parent?.subscription_details?.subscription ?? null;
    } else {
      subId = o.id as string;
    }
    if (!subId) return antwort(200, { ok: true, ohne_abo: true });

    const sub = await stripe(api, "GET", `subscriptions/${subId}`);
    const f = subscriptionUpdate(sub);
    if (user && !f.p_user) f.p_user = user;
    const { data: ok, error } = await admin.rpc("apply_subscription", f);
    if (error) throw new Error(error.message);
    if (!ok) console.warn("webhook: kein Mitglied gefunden", ev.type, subId);
    return antwort(200, { ok: true, gefunden: ok });
  } catch (e) {
    console.error("webhook", ev.type, (e as Error).message);
    await admin.from("stripe_events").delete().eq("id", ev.id);
    return antwort(500, { ok: false, grund: "verarbeitung" });
  }
});
