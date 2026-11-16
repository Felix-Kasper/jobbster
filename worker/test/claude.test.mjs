// Jobbster · Tests des Claude-Zugriffs: Steuerung von Nachdenken und Aufwand. Ohne Netz, der Transport ist eine Attrappe.
// Start: node --test worker/test/claude.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClaude, summe, HAIKU } from '../lib/claude.mjs';

const ok = (usage = {}) => ({ status: 200, json: { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"a":1}' }], usage: { input_tokens: 1000, output_tokens: 200, ...usage } } });
const SCHEMA = { type: 'object', additionalProperties: false, required: ['a'], properties: { a: { type: 'integer' } } };

test('Ohne Angabe bleibt die Anfrage unverändert (Nachdenken entscheidet das Modell)', async () => {
  const gesendet = [];
  const claude = createClaude({ post: async (body) => { gesendet.push(body); return ok({ output_tokens_details: { thinking_tokens: 150 } }); } });
  const r = await claude.zug({ model: HAIKU, system: 's', user: 'u', format: SCHEMA });
  assert.equal(gesendet[0].thinking, undefined);
  assert.deepEqual(Object.keys(gesendet[0].output_config), ['format']);
  assert.equal(r.tokensDenken, 150);
  assert.equal(summe(r, r).tokensDenken, 300);
});

test('denken: false und aufwand werden gesendet, das Schema bleibt erhalten', async () => {
  const gesendet = [];
  const claude = createClaude({ post: async (body) => { gesendet.push(body); return ok(); } });
  const r = await claude.zug({ model: HAIKU, system: 's', user: 'u', format: SCHEMA, denken: false, aufwand: 'low' });
  assert.deepEqual(gesendet[0].thinking, { type: 'disabled' });
  assert.equal(gesendet[0].output_config.effort, 'low');
  assert.equal(gesendet[0].output_config.format.type, 'json_schema');
  assert.equal(r.text, '{"a":1}');
  assert.equal(r.anfragen, 1);
});

test('Lehnt die API die Steuerung ab, läuft die Anfrage ohne sie weiter', async () => {
  const gesendet = [];
  const meldungen = [];
  const post = async (body) => {
    gesendet.push(body);
    return body.thinking ? { status: 400, json: { error: { message: 'thinking.type: disabled is not supported for this model' } } } : ok();
  };
  const claude = createClaude({ post, log: (m) => meldungen.push(m) });
  const r = await claude.zug({ model: HAIKU, system: 's', user: 'u', denken: false });
  assert.equal(gesendet.length, 2);
  assert.equal(gesendet[1].thinking, undefined);
  assert.equal(r.text, '{"a":1}');
  assert.match(meldungen[0], /Steuerung abgelehnt/);
});

test('Andere 400-Fehler werden nicht verschluckt', async () => {
  const claude = createClaude({ post: async () => ({ status: 400, json: { error: { message: 'max_tokens: too large' } } }) });
  await assert.rejects(() => claude.zug({ model: HAIKU, system: 's', user: 'u', denken: false }), /max_tokens/);
});
