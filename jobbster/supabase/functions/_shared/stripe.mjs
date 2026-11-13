// Jobbster · Stripe ohne SDK: Formular-Kodierung, Anfragen, Prüfung der Webhook-Signatur.
// Läuft in Deno (Edge Functions) und in Node 20+ (Tests). Keine Abhängigkeiten.

/** Verschachtelte Werte so kodieren, wie Stripe sie erwartet: a[b][0][c]=x */
export function form(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj ?? {})) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((x, i) => (typeof x === 'object' ? form(x, `${key}[${i}]`, out) : out.append(`${key}[${i}]`, String(x))));
    else if (typeof v === 'object') form(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

/**
 * @param {string} secret
 * @param {'GET'|'POST'|'DELETE'} method
 * @param {string} path
 * @param {Record<string, unknown>} [params]
 * @param {{ fetchFn?: typeof fetch, idempotencyKey?: string }} [opts]
 */
export async function stripe(secret, method, path, params, opts = {}) {
  const { fetchFn = fetch, idempotencyKey } = opts;
  const url = `https://api.stripe.com/v1/${path}${method === 'GET' && params ? `?${form(params)}` : ''}`;
  // Ohne feste Stripe-Version: Es gilt die Version des Kontos. periodEnd() liest beide Orte des Periodenendes.
  /** @type {Record<string, string>} */
  const headers = { Authorization: `Bearer ${secret}` };
  if (method !== 'GET') headers['Content-Type'] = 'application/x-www-form-urlencoded';
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const res = await fetchFn(url, { method, headers, body: method === 'GET' ? undefined : form(params).toString() });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(json?.error?.message || `Stripe ${res.status}`);
    e.status = res.status;
    e.code = json?.error?.code;
    throw e;
  }
  return json;
}

function hex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function gleich(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** Stripe-Signature prüfen: t=<zeit>,v1=<hmac>. Gibt true nur bei gültiger Signatur im Zeitfenster zurück. */
export async function verifySignature(payload, header, secret, { toleranceSec = 300, nowSec = Math.floor(Date.now() / 1000) } = {}) {
  if (!header || !secret) return false;
  const v1 = [];
  let t = null;
  for (const teil of String(header).split(',')) {
    const [k, v] = teil.split('=');
    if (k === 't') t = Number(v);
    if (k === 'v1' && v) v1.push(v.trim());
  }
  if (!Number.isFinite(t) || !v1.length) return false;
  if (Math.abs(nowSec - t) > toleranceSec) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${t}.${payload}`)));
  return v1.some((s) => gleich(s, sig));
}

/** Ende der bezahlten Periode bzw. der Probe, als ISO-Zeit. Neuere API-Versionen führen sie an den Positionen. */
export function periodEnd(sub) {
  const sek = sub?.status === 'trialing' && sub?.trial_end
    ? sub.trial_end
    : sub?.current_period_end ?? sub?.items?.data?.[0]?.current_period_end ?? null;
  return sek ? new Date(sek * 1000).toISOString() : null;
}

/** Aus einem Abo die Felder für apply_subscription machen. */
export function subscriptionUpdate(sub) {
  const customer = typeof sub.customer === 'string' ? sub.customer : sub.customer?.id;
  return {
    p_customer: customer ?? null,
    p_subscription: sub.id,
    p_status: sub.status,
    p_period_end: periodEnd(sub),
    p_cancel: Boolean(sub.cancel_at_period_end || sub.cancel_at),
    p_user: sub.metadata?.user_id || null,
  };
}
