// Reine Logik ohne Netz: getestet in logic.test.ts
import type { Lead, LeadStatus, Member, Preferences } from './types';

export type Tab = 'neu' | 'bereit' | 'beworben' | 'gespraeche' | 'archiv';

/** Bewerbungen pro Tag. Muss zu worker/lib/agents.mjs (PRO_TAG) passen. */
export const PRO_TAG = { min: 1, max: 12, empfohlen: 10 } as const;
export function proTag(n: unknown): number {
  const x = Math.round(Number(n));
  return Number.isFinite(x) && n !== null && n !== '' ? Math.min(PRO_TAG.max, Math.max(PRO_TAG.min, x)) : PRO_TAG.empfohlen;
}

export const TABS: { id: Tab; label: string }[] = [
  { id: 'bereit', label: 'Bereit' },
  { id: 'neu', label: 'Neu' },
  { id: 'beworben', label: 'Beworben' },
  { id: 'gespraeche', label: 'Gespräche' },
  { id: 'archiv', label: 'Archiv' },
];

const TAB_OF: Record<LeadStatus, Tab | null> = {
  neu: 'neu', entwurf: 'bereit', beworben: 'beworben', interview: 'gespraeche', interview2: 'gespraeche', vertrag: 'gespraeche',
  zusage: 'archiv', absage: 'archiv', verworfen: 'archiv', geloescht: null,
};

export function tabOf(l: Pick<Lead, 'status'>): Tab | null {
  return TAB_OF[l.status] ?? null;
}

/** Sortierung je Reiter: Frist zuerst, dann Match, dann frischer. */
export function sortLeads(list: Lead[], tab: Tab): Lead[] {
  const t = (s: string | null) => (s ? Date.parse(s) : NaN);
  return [...list].sort((a, b) => {
    if (tab === 'gespraeche') return (t(a.next_at) || Infinity) - (t(b.next_at) || Infinity);
    if (tab === 'beworben' || tab === 'archiv') return (t(b.applied_at ?? b.updated_at) || 0) - (t(a.applied_at ?? a.updated_at) || 0);
    const da = t(a.deadline), db = t(b.deadline);
    const fa = Number.isFinite(da), fb = Number.isFinite(db);
    if (fa !== fb) return fa ? -1 : 1;
    if (fa && fb && da !== db) return da - db;
    return (b.match_score ?? -1) - (a.match_score ?? -1) || (t(b.posted_at) || 0) - (t(a.posted_at) || 0);
  });
}

export function countByTab(list: Lead[]): Record<Tab, number> {
  const c: Record<Tab, number> = { neu: 0, bereit: 0, beworben: 0, gespraeche: 0, archiv: 0 };
  for (const l of list) {
    const t = tabOf(l);
    if (t) c[t] += 1;
  }
  return c;
}

/** „Chance: hoch.“ aus why_fit lesen. */
export function chanceOf(whyFit: string | null): 'hoch' | 'mittel' | 'niedrig' | null {
  const m = /Chance:\s*(hoch|mittel|niedrig)/i.exec(whyFit ?? '');
  return m ? (m[1].toLowerCase() as 'hoch' | 'mittel' | 'niedrig') : null;
}

const GRUND: Record<string, string> = {
  nicht_angemeldet: 'Du bist nicht mehr angemeldet. Bitte melde dich neu an.',
  kein_zugang: 'Dein Zugang ist nicht aktiv. Starte die Probe oder löse einen Code ein.',
  abgelaufen: 'Dein Zugang ist abgelaufen. Unter Konto kannst du ihn verlängern.',
  pausiert: 'Jobbster ist gerade pausiert. Bitte versuch es später noch einmal.',
  profil_fehlt: 'Dafür braucht Jobbster deinen Lebenslauf. Lade ihn unter Profil hoch.',
  treffer_fehlt: 'Diesen Treffer gibt es nicht mehr. Lade die Seite neu.',
  stufe_fehlt: 'Wähle zuerst die Gesprächsrunde.',
  laeuft_schon: 'Läuft schon. Das Ergebnis erscheint hier, sobald es fertig ist.',
  nicht_im_paket: 'Das ist in der Probe nicht enthalten. Mit dem Abo geht es sofort.',
  unbekannte_art: 'Das hat nicht geklappt. Bitte lade die Seite neu.',
};

export function reasonText(grund: string | undefined, freiAb?: string, limit?: number): string {
  if (grund === 'limit') {
    const ab = freiAb ? new Date(freiAb) : null;
    const wann = ab && !Number.isNaN(ab.getTime()) ? ` Wieder möglich ab ${formatDateTime(ab.toISOString())}.` : '';
    return `Grenze erreicht${limit ? ` (${limit} im Zeitraum)` : ''}.${wann}`;
  }
  return GRUND[grund ?? ''] ?? 'Das hat nicht geklappt. Bitte versuch es noch einmal.';
}

const tz = 'Europe/Vienna';
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('de-AT', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: tz }).format(d);
}
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return new Intl.DateTimeFormat('de-AT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', timeZone: tz }).format(d);
}
export function daysUntil(iso: string | null | undefined, now = Date.now()): number | null {
  if (!iso) return null;
  const t = Date.parse(iso.length === 10 ? `${iso}T23:59:59Z` : iso);
  return Number.isFinite(t) ? Math.ceil((t - now) / 86_400_000) : null;
}

export type Access = { aktiv: boolean; titel: string; text: string; aktion: 'keine' | 'probe' | 'abo' | 'verlaengern' | 'zahlung' };

/** Was der Zugang gerade erlaubt, in Worten für die Konto-Seite und das Banner. */
export function accessOf(m: Member | null, now = Date.now()): Access {
  if (!m) return { aktiv: false, titel: 'Kein Zugang', text: 'Starte die Probe oder löse einen Code ein.', aktion: 'probe' };
  if (m.status === 'gesperrt') return { aktiv: false, titel: 'Gesperrt', text: 'Dein Zugang ist gesperrt. Schreib uns, wenn das ein Fehler ist.', aktion: 'keine' };
  const bis = m.valid_until ? Date.parse(m.valid_until) : null;
  const laeuft = bis === null || bis > now;
  const datum = m.valid_until ? formatDate(m.valid_until) : '';
  if (m.plan === 'abo' || m.sub_status) {
    if (m.sub_status === 'trialing') {
      return m.cancel_at_period_end
        ? { aktiv: laeuft, titel: 'Probe, gekündigt', text: `Die Probe endet am ${datum}. Es wird nichts abgebucht.`, aktion: 'abo' }
        : { aktiv: laeuft, titel: 'Probe läuft', text: `Am ${datum} beginnt das Abo, außer du kündigst vorher.`, aktion: 'abo' };
    }
    if (m.sub_status === 'active') {
      return m.cancel_at_period_end
        ? { aktiv: laeuft, titel: 'Abo gekündigt', text: `Dein Zugang läuft bis ${datum}. Danach wird nichts mehr abgebucht.`, aktion: 'abo' }
        : { aktiv: laeuft, titel: 'Abo aktiv', text: `Nächste Abbuchung am ${datum}. Kündigen geht jederzeit.`, aktion: 'abo' };
    }
    if (m.sub_status === 'past_due' || m.sub_status === 'unpaid' || m.sub_status === 'incomplete') {
      return { aktiv: laeuft, titel: 'Zahlung offen', text: 'Die letzte Zahlung ist nicht durchgegangen. Bitte prüfe deine Zahlungsart.', aktion: 'zahlung' };
    }
    return { aktiv: false, titel: 'Abo beendet', text: 'Dein Abo ist beendet. Du kannst jederzeit neu starten.', aktion: m.trial_used ? 'abo' : 'probe' };
  }
  if (m.plan === 'neu') return { aktiv: false, titel: 'Noch nicht gestartet', text: 'Starte die Probe, um loszulegen.', aktion: m.trial_used ? 'abo' : 'probe' };
  if (!laeuft) return { aktiv: false, titel: 'Abgelaufen', text: `Dein Zugang ist am ${datum} abgelaufen.`, aktion: m.trial_used ? 'abo' : 'probe' };
  if (m.limits) return { aktiv: true, titel: 'Probe mit Code', text: `Läuft bis ${datum}. Danach endet sie von selbst.`, aktion: 'verlaengern' };
  if (bis === null) return { aktiv: true, titel: 'Unbegrenzt', text: 'Dein Zugang hat kein Ablaufdatum.', aktion: 'keine' };
  return { aktiv: true, titel: m.plan === 'beta' ? 'Beta' : 'Zugang aktiv', text: `Läuft bis ${datum}.`, aktion: 'verlaengern' };
}

/** Profil vollständig genug für den ersten Suchlauf? Gibt die fehlenden Angaben zurück. */
export function missingForSearch(p: { cv_text?: string | null; preferences?: Preferences | null; full_name?: string | null }): string[] {
  const fehlt: string[] = [];
  if ((p.cv_text ?? '').trim().length < 200) fehlt.push('Lebenslauf');
  if (!p.full_name?.trim()) fehlt.push('Name');
  if (!p.preferences?.zielrollen?.trim()) fehlt.push('Zielrollen');
  if (!p.preferences?.orte?.length) fehlt.push('Orte');
  if (!p.preferences?.start?.trim()) fehlt.push('Start');
  return fehlt;
}

export function parseOrte(text: string): string[] {
  return [...new Set(text.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean))].slice(0, 12);
}

/** mailto-Link für eine Bewerbung per E-Mail. Zu lange Texte passen nicht in den Link. */
export function mailtoFor(l: Pick<Lead, 'apply_email' | 'email_subject' | 'email_body'>): { href: string; kurz: boolean } | null {
  if (!l.apply_email) return null;
  const subject = encodeURIComponent(l.email_subject ?? '');
  const body = encodeURIComponent(l.email_body ?? '');
  const voll = `mailto:${l.apply_email}?subject=${subject}&body=${body}`;
  if (voll.length <= 1900) return { href: voll, kurz: false };
  return { href: `mailto:${l.apply_email}?subject=${subject}`, kurz: true };
}

/** Dateiname ohne Sonderzeichen, die Windows nicht mag. */
export function fileName(...teile: (string | null | undefined)[]): string {
  return teile.filter(Boolean).join(' ').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Datei';
}
