// Jobbster · Test der Stripe-Hilfen (Signatur, Kodierung, Laufzeit). Start: node worker/test/stripe.test.mjs
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { form, periodEnd, stripe, subscriptionUpdate, verifySignature } from '../../supabase/functions/_shared/stripe.mjs';

let n = 0;
const ok = async (name, fn) => { await fn(); n++; console.log(`  ok  ${name}`); };
const SECRET = 'whsec_testgeheimnis';
const signiere = (payload, t, secret = SECRET) => `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex')}`;
const jetzt = 1_794_500_000;

await ok('gültige Signatur wird angenommen', async () => {
  const p = '{"id":"evt_1","type":"customer.subscription.updated"}';
  assert.equal(await verifySignature(p, signiere(p, jetzt), SECRET, { nowSec: jetzt }), true);
});
await ok('mehrere v1-Werte: einer passt reicht (Schlüsselwechsel)', async () => {
  const p = '{"a":1}';
  const echt = signiere(p, jetzt).split('v1=')[1];
  assert.equal(await verifySignature(p, `t=${jetzt},v1=${'0'.repeat(64)},v1=${echt}`, SECRET, { nowSec: jetzt }), true);
});
await ok('veränderter Inhalt wird abgelehnt', async () => {
  const p = '{"id":"evt_1"}';
  assert.equal(await verifySignature('{"id":"evt_2"}', signiere(p, jetzt), SECRET, { nowSec: jetzt }), false);
});
await ok('falsches Geheimnis wird abgelehnt', async () => {
  const p = '{}';
  assert.equal(await verifySignature(p, signiere(p, jetzt, 'whsec_anders'), SECRET, { nowSec: jetzt }), false);
});
await ok('zu alte Signatur wird abgelehnt (Wiederholungsangriff)', async () => {
  const p = '{}';
  assert.equal(await verifySignature(p, signiere(p, jetzt - 301), SECRET, { nowSec: jetzt }), false);
});
await ok('fehlende oder kaputte Kopfzeile wird abgelehnt', async () => {
  assert.equal(await verifySignature('{}', null, SECRET), false);
  assert.equal(await verifySignature('{}', 'quatsch', SECRET), false);
  assert.equal(await verifySignature('{}', `t=${jetzt}`, SECRET, { nowSec: jetzt }), false);
});
await ok('Formular-Kodierung wie Stripe sie erwartet', async () => {
  const f = form({ mode: 'subscription', line_items: [{ price: 'price_1', quantity: 1 }], subscription_data: { metadata: { user_id: 'u1' }, trial_period_days: 7 }, leer: null });
  assert.equal(decodeURIComponent(f.toString()), 'mode=subscription&line_items[0][price]=price_1&line_items[0][quantity]=1&subscription_data[metadata][user_id]=u1&subscription_data[trial_period_days]=7');
});
await ok('Periodenende: Probe nimmt trial_end, sonst Position oder Abo', async () => {
  assert.equal(periodEnd({ status: 'trialing', trial_end: 1_795_000_000 }), new Date(1_795_000_000_000).toISOString());
  assert.equal(periodEnd({ status: 'active', items: { data: [{ current_period_end: 1_796_000_000 }] } }), new Date(1_796_000_000_000).toISOString());
  assert.equal(periodEnd({ status: 'active', current_period_end: 1_797_000_000 }), new Date(1_797_000_000_000).toISOString());
  assert.equal(periodEnd({ status: 'canceled' }), null);
});
await ok('Abo wird zu den Feldern für apply_subscription', async () => {
  const u = subscriptionUpdate({ id: 'sub_1', customer: { id: 'cus_1' }, status: 'active', cancel_at_period_end: true, items: { data: [{ current_period_end: 1_796_000_000 }] }, metadata: { user_id: 'u1' } });
  assert.deepEqual(u, { p_customer: 'cus_1', p_subscription: 'sub_1', p_status: 'active', p_period_end: new Date(1_796_000_000_000).toISOString(), p_cancel: true, p_user: 'u1' });
});
await ok('Anfrage an Stripe: Methode, Kopf, Idempotenz, Fehler', async () => {
  const log = [];
  const fake = async (url, init) => { log.push({ url, init }); return url.includes('fehler') ? new Response(JSON.stringify({ error: { message: 'Nein', code: 'resource_missing' } }), { status: 404 }) : new Response('{"id":"cus_1"}', { status: 200 }); };
  const r = await stripe('sk_test_x', 'POST', 'customers', { email: 'a@b.example' }, { fetchFn: fake, idempotencyKey: 'kunde-u1' });
  assert.equal(r.id, 'cus_1');
  assert.equal(log[0].init.headers.Authorization, 'Bearer sk_test_x');
  assert.equal(log[0].init.headers['Idempotency-Key'], 'kunde-u1');
  assert.equal(log[0].init.body, 'email=a%40b.example');
  await assert.rejects(() => stripe('sk_test_x', 'GET', 'subscriptions/fehler', undefined, { fetchFn: fake }), (e) => e.code === 'resource_missing' && e.status === 404);
});
console.log(`\n${n} Prüfungen bestanden.`);
