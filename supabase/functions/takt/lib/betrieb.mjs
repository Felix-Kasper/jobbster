// Jobbster · Betrieb: Zeitplan, Aufräumen und das Abarbeiten eines Auftrags.
// Gemeinsam genutzt vom Worker in GitHub Actions (Node) und von der Funktion „takt“ in Supabase (Deno),
// damit beide genau dasselbe tun. Ohne Abhängigkeiten; Datenbank, Abruf und Protokoll werden übergeben.
// Im Protokoll stehen nur Kennungen, Mengen und Kosten. Keine Namen, keine Lebensläufe.
import { verdecke } from './claude.mjs';
import { entscheide, pruefeAlle } from './online.mjs';
import { scout, entwurf, vorbereitung } from './agents.mjs';

const kurzId = (id) => String(id || '').slice(0, 8);
export const usd = (n) => `${Number(n || 0).toFixed(3)} $`;
const jetzt = () => new Date().toISOString();

/** Kleiner Zugriff auf die REST-Schnittstelle von Supabase mit dem Dienstschlüssel. */
export function datenbank(url, key, holen = globalThis.fetch) {
  return async (method, pfad, body, prefer) => {
    const res = await holen(`${url}/rest/v1/${pfad}`, {
      method,
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(prefer ? { Prefer: prefer } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Datenbank ${method} ${pfad.split('?')[0]}: ${res.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  };
}

export async function schalterLesen(db) {
  return Object.fromEntries((await db('GET', 'app_config?select=key,value')).map((r) => [r.key, r.value]));
}

/** Hängengebliebene Aufträge freigeben (zählen dann nicht gegen die Grenze des Nutzers). */
export async function haengendeFreigeben(db, minuten = 40) {
  const alt = new Date(Date.now() - minuten * 60_000).toISOString();
  await db('PATCH', `queue?status=eq.laeuft&started_at=lt.${alt}`, { status: 'fehler', error: 'Abgebrochen: Zeitüberschreitung', finished_at: jetzt() });
}

export function signaleText(leads) {
  const gut = leads.filter((l) => ['beworben', 'interview', 'interview2', 'vertrag', 'zusage'].includes(l.status)).slice(0, 20);
  const weg = leads.filter((l) => ['verworfen', 'geloescht'].includes(l.status) && l.archive_reason && !/nicht mehr online|doppelt|frist vorbei|abgelaufen/i.test(l.archive_reason)).slice(0, 20);
  const z = [];
  if (gut.length) z.push(`Beworben oder im Gespräch (mehr davon, bei anderen Firmen): ${gut.map((l) => `${l.title} bei ${l.company}`).join('; ')}`);
  if (weg.length) z.push(`Aussortiert mit Grund (das Muster meiden): ${weg.map((l) => `${l.title} bei ${l.company}: ${String(l.archive_reason).slice(0, 80)}`).join('; ')}`);
  return z.join('\n');
}

/**
 * Fällige Scout-Läufe einreihen. Eigene Grenzen (Probe-Codes) gehen vor. Sonst sucht der Zeitplan einmal am Tag:
 * kein neuer Lauf, wenn in den letzten 12 Stunden schon einer lief (auch ein von Hand gestarteter).
 */
export async function plane({ db, log = console.log }) {
  const mitglieder = await db('GET', 'members?status=eq.aktiv&select=user_id,valid_until,limits');
  const profile = new Set((await db('GET', 'job_profile?onboarded_at=not.is.null&select=user_id')).map((p) => p.user_id));
  const jetztMs = Date.now();
  let n = 0;
  for (const m of mitglieder) {
    if (!profile.has(m.user_id)) continue;
    if (m.valid_until && Date.parse(m.valid_until) <= jetztMs) continue; // Zugang abgelaufen
    const g = m.limits?.scout || { anzahl: 1, tage: 0.5 };
    if (!(g.anzahl > 0)) continue;
    const seit = new Date(jetztMs - g.tage * 86_400_000).toISOString();
    const eigene = await db('GET', `queue?user_id=eq.${m.user_id}&kind=eq.scout&status=neq.fehler&created_at=gte.${seit}&select=status`);
    if (eigene.length >= g.anzahl || eigene.some((l) => ['wartet', 'laeuft'].includes(l.status))) continue;
    await db('POST', 'queue', { user_id: m.user_id, kind: 'scout' }, 'return=minimal');
    n++;
  }
  log(`Zeitplan: ${n} Scout-Läufe eingereiht (${mitglieder.length} aktive Mitglieder).`);
  return n;
}

/**
 * Offene Treffer (neu, entwurf) prüfen, die heute noch nicht geprüft wurden, älteste Prüfung zuerst.
 * Kostet keine KI. Gelöscht wird nur bei eindeutigem Befund (siehe online.mjs).
 */
export async function aufraeumen({ db, holen, max = 600, jetzt: zeit = new Date(), log = console.log }) {
  const grenze = new Date(zeit.getTime() - 20 * 3_600_000).toISOString();
  const offen = await db('GET', `job_leads?status=in.(neu,entwurf)&or=(online_geprueft_at.is.null,online_geprueft_at.lt.${grenze})&select=id,status,url,deadline,posted_at,created_at&order=online_geprueft_at.asc.nullsfirst&limit=${max}`);
  if (!offen.length) {
    log('Aufräumen: nichts zu prüfen.');
    return { geprueft: 0, entfernt: 0 };
  }
  const t0 = Date.now();
  const geprueft = await pruefeAlle(holen, offen);
  const zaehler = { online: 0, weg: 0, unklar: 0 };
  let entfernt = 0;
  for (const t of geprueft) {
    zaehler[t.befund.status]++;
    const e = entscheide(t, t.befund, zeit);
    await db('PATCH', `job_leads?id=eq.${t.id}&status=in.(neu,entwurf)`, e.aenderung, 'return=minimal');
    if (e.warum) {
      entfernt++;
      log(`  raus: ${e.warum} · ${t.befund.grund} · ${String(t.url).slice(0, 90)}`);
    }
  }
  log(`Aufräumen: ${offen.length} offene Treffer geprüft (${zaehler.online} online, ${zaehler.weg} weg, ${zaehler.unklar} nicht prüfbar), ${entfernt} entfernt, ${Math.round((Date.now() - t0) / 1000)} s.`);
  return { geprueft: offen.length, entfernt, ...zaehler };
}

/**
 * Den ältesten wartenden Auftrag übernehmen und erledigen.
 * @returns {Promise<{ ergebnis: 'leer' | 'limit' | 'verloren' | 'ok' | 'fehler', usd: number, heute?: number }>}
 */
export async function bearbeiteNaechsten({ db, claude, cfg = {}, holen = globalThis.fetch, tageslimit, log = console.log, nurArt = null }) {
  // Tagesbudget prüfen (UTC-Tag)
  const tag = `${jetzt().slice(0, 10)}T00:00:00Z`;
  const heute = (await db('GET', `runs?created_at=gte.${tag}&select=cost_usd`)).reduce((a, r) => a + Number(r.cost_usd || 0), 0);
  if (heute >= tageslimit) return { ergebnis: 'limit', usd: 0, heute };

  const [auftrag] = await db('GET', `queue?status=eq.wartet${nurArt ? `&kind=eq.${nurArt}` : ''}&order=created_at.asc&limit=1`);
  if (!auftrag) return { ergebnis: 'leer', usd: 0 };
  const [meiner] = await db('PATCH', `queue?id=eq.${auftrag.id}&status=eq.wartet`, { status: 'laeuft', started_at: jetzt() }, 'return=representation');
  if (!meiner) return { ergebnis: 'verloren', usd: 0 }; // ein anderer Lauf war schneller

  const uid = auftrag.user_id;
  const agent = { scout: 'scout', entwurf: 'writer', vorbereitung: 'coach' }[auftrag.kind];
  const t0 = Date.now();
  log(`▶ ${auftrag.kind} · Auftrag ${kurzId(auftrag.id)} · Nutzer ${kurzId(uid)}`);
  let nutzung = null;
  let model = null;
  let anzahl = 0;
  const usdVorher = claude.usd();

  try {
    const [mitglied] = await db('GET', `members?user_id=eq.${uid}&status=eq.aktiv&select=user_id,valid_until`);
    if (!mitglied) throw new Error('Kein aktiver Zugang');
    if (mitglied.valid_until && Date.parse(mitglied.valid_until) <= Date.now()) throw new Error('Zugang abgelaufen');
    const [profil] = await db('GET', `job_profile?user_id=eq.${uid}`);
    if (!profil || String(profil.cv_text || '').length < 200) throw new Error('Profil ohne Lebenslauf');

    if (auftrag.kind === 'scout') {
      const alle = await db('GET', `job_leads?user_id=eq.${uid}&select=company,title,status,archive_reason&order=created_at.desc&limit=300`);
      const r = await scout({ claude, profil, bekannt: [...new Set(alle.map((l) => l.company))], signale: signaleText(alle), cfg, holen });
      nutzung = r.nutzung;
      model = r.model;
      if (r.leads.length) {
        const neu = await db('POST', 'job_leads?on_conflict=user_id,dedup_key', r.leads.map((l) => ({ ...l, user_id: uid })), 'resolution=ignore-duplicates,return=representation');
        anzahl = neu?.length || 0;
      }
      for (const h of r.hinweise) log(`    Hinweis: ${h}`);
      log(`    ${anzahl} neue Treffer gespeichert (${r.leads.length} gefunden, ${r.abgelehnt.length} abgelehnt), Werkzeug ${r.werkzeug}`);
    } else {
      const [lead] = await db('GET', `job_leads?id=eq.${auftrag.lead_id}&user_id=eq.${uid}`);
      if (!lead) throw new Error('Treffer nicht gefunden');
      if (auftrag.kind === 'entwurf') {
        const r = await entwurf({ claude, profil, lead, cfg });
        nutzung = r.nutzung;
        model = r.model;
        await db('PATCH', `job_leads?id=eq.${lead.id}&user_id=eq.${uid}`, { ...r.felder, drafted_at: jetzt(), ...(lead.status === 'neu' ? { status: 'entwurf' } : {}) }, 'return=minimal');
        anzahl = 1;
        for (const h of r.hinweise) log(`    Hinweis: ${h}`);
        log(`    Entwurf gespeichert (${r.felder.cover_letter_md.length} Zeichen Anschreiben)`);
      } else {
        const stufe = auftrag.stage === 'interview2' ? 'interview2' : 'interview1';
        const r = await vorbereitung({ claude, profil, lead, stufe, cfg });
        nutzung = r.nutzung;
        model = r.model;
        await db('PATCH', `job_leads?id=eq.${lead.id}&user_id=eq.${uid}`, { [`${stufe}_prep`]: r.prep, prep_requested_at: null }, 'return=minimal');
        anzahl = 1;
        for (const h of r.hinweise) log(`    Hinweis: ${h}`);
        log('    Vorbereitung gespeichert');
      }
    }

    await db('POST', 'runs', {
      user_id: uid, queue_id: auftrag.id, agent, model, requests: nutzung.anfragen, searches: nutzung.suchen, fetches: nutzung.abrufe,
      input_tokens: nutzung.tokensEin, output_tokens: nutzung.tokensAus, cost_usd: Number(nutzung.usd.toFixed(4)), duration_ms: Date.now() - t0, result_count: anzahl, status: 'ok',
    }, 'return=minimal');
    await db('PATCH', `queue?id=eq.${auftrag.id}`, { status: 'fertig', finished_at: jetzt() }, 'return=minimal');
    log(`    fertig in ${Math.round((Date.now() - t0) / 1000)} s, ${usd(nutzung.usd)}`);
    return { ergebnis: 'ok', usd: nutzung.usd };
  } catch (e) {
    const grund = verdecke(e.message || e).slice(0, 300);
    const kosten = claude.usd() - usdVorher;
    log(`    ✖ ${grund}`);
    try {
      await db('POST', 'runs', {
        user_id: uid, queue_id: auftrag.id, agent, model, cost_usd: Number(kosten.toFixed(4)), duration_ms: Date.now() - t0, status: 'fehler', error: grund,
      }, 'return=minimal');
      await db('PATCH', `queue?id=eq.${auftrag.id}`, { status: 'fehler', error: grund, finished_at: jetzt() }, 'return=minimal');
    } catch (e2) {
      log(`    ✖ Fehler beim Protokollieren: ${String(e2.message).slice(0, 200)}`);
    }
    return { ergebnis: 'fehler', usd: kosten };
  }
}
