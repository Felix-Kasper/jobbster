// Jobbster · „Beschreib deinen perfekten Job“: Suchfelder aus freiem Text vorschlagen.
// Eigenes kleines Modul, damit die Funktion profil-vorschlag nur claude.mjs und diese Datei braucht.
import { HAIKU, leseJson, summe } from './claude.mjs';

const leer = (s) => (s && String(s).trim() && !/^unbekannt$/i.test(String(s).trim()) ? String(s).trim() : null);
const ohneStrich = (s) => String(s || '').replace(/\s[–—]\s/g, ', ').replace(/[–—]/g, '-');

/** Aus der freien Beschreibung des perfekten Jobs die Suchfelder vorschlagen. Nichts erfinden, was nicht drinsteht. */
export const traumjobAuswerten = () => `Du hilfst beim Einrichten einer Jobsuche für den Berufseinstieg in Österreich, Deutschland und der Schweiz. Die Person hat ihren perfekten Job in eigenen Worten beschrieben. Leite daraus die Suchfelder ab.

REGELN
- Nur was aus der Beschreibung hervorgeht. Was nicht drinsteht, bleibt leer (leerer Text, leere Liste). Nichts erfinden, nicht raten.
- zielrollen: 1 bis 4 Rollen, so wie sie in Stellenanzeigen heißen (zum Beispiel „Trainee Controlling“, „Junior Consultant“), mit Komma getrennt.
- stellenarten: nur Werte aus dieser Liste: Trainee, Junior, Graduate, Bezahltes Praktikum, Berufseinstieg.
- orte: Städte oder Regionen in der genannten Reihenfolge. „Remote“ nur, wenn ausdrücklich gewünscht.
- start: frühester Start in den Worten der Person, sonst leer.
- ausschluesse: was die Person ausdrücklich nicht will, mit Komma getrennt.
- wuensche: alles Weitere, was bei der Auswahl hilft (Branche, Firmengröße, Arbeitszeit, Sprache, Werte), in einem knappen Satz.
- Schreib Deutsch, ohne Gedankenstriche.`;

export const TRAUMJOB_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['zielrollen', 'stellenarten', 'orte', 'start', 'ausschluesse', 'wuensche'],
  properties: {
    zielrollen: { type: 'string' },
    stellenarten: { type: 'array', items: { type: 'string', enum: ['Trainee', 'Junior', 'Graduate', 'Bezahltes Praktikum', 'Berufseinstieg'] } },
    orte: { type: 'array', items: { type: 'string' } },
    start: { type: 'string' },
    ausschluesse: { type: 'string' },
    wuensche: { type: 'string' },
  },
};

/** Suchfelder aus der freien Beschreibung des perfekten Jobs. Haiku, ohne Werkzeuge, kostet Bruchteile eines Cents. */
export async function traumjobFelder({ claude, text, cfg = {} }) {
  const eingabe = String(text ?? '').trim().slice(0, 2000);
  if (eingabe.length < 40) throw new Error('Beschreibung zu kurz');
  const z = await claude.zug({ model: cfg.modell ?? HAIKU, system: traumjobAuswerten(), user: `BESCHREIBUNG\n${eingabe}`, format: TRAUMJOB_SCHEMA, maxTokens: 1500 });
  const d = leseJson(z.text);
  if (!d) throw new Error('Keine lesbare Antwort');
  const arten = new Set(['Trainee', 'Junior', 'Graduate', 'Bezahltes Praktikum', 'Berufseinstieg']);
  const felder = {
    zielrollen: leer(d.zielrollen) ?? '',
    stellenarten: (Array.isArray(d.stellenarten) ? d.stellenarten : []).filter((x) => arten.has(x)),
    orte: (Array.isArray(d.orte) ? d.orte : []).map((o) => String(o).trim()).filter(Boolean).slice(0, 8),
    start: leer(d.start) ?? '',
    ausschluesse: leer(d.ausschluesse) ?? '',
    wuensche: leer(d.wuensche) ?? '',
  };
  for (const k of Object.keys(felder)) if (typeof felder[k] === 'string') felder[k] = ohneStrich(felder[k]);
  return { felder, model: z.model, nutzung: summe(z) };
}
