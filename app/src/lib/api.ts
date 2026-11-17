// Alle Zugriffe auf das Backend an einer Stelle. Kein Geheimnis im Browser: nur die öffentliche Adresse
// und der Publishable Key. Was ein Nutzer darf, entscheiden RLS und die Funktionen in der Datenbank.
import { createClient, type Session } from '@supabase/supabase-js';
import type { Lead, Member, Profile, PublicConfig, QueueItem, RunResult } from './types';

export const SUPABASE_URL: string = import.meta.env.VITE_SUPABASE_URL ?? 'https://pekfnuywzouakdpehouc.supabase.co';
const SUPABASE_KEY: string = import.meta.env.VITE_SUPABASE_KEY ?? 'sb_publishable_xMzMpy0FNSstDMgfvEGD_w_bHhHJFKh';

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});

export class ApiError extends Error {
  constructor(message: string, public grund?: string) {
    super(message);
  }
}

function fail(error: { message?: string; code?: string } | null, text = 'Das hat nicht geklappt. Bitte versuch es noch einmal.'): never {
  if (error?.message && /JWT|token|session/i.test(error.message)) throw new ApiError('Du bist nicht mehr angemeldet. Bitte melde dich neu an.', 'nicht_angemeldet');
  if (error?.message && /Failed to fetch|NetworkError|network/i.test(error.message)) throw new ApiError('Keine Verbindung. Prüfe dein Internet und versuch es noch einmal.', 'netz');
  throw new ApiError(text, error?.code);
}

async function uid(): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const id = data.session?.user.id;
  if (!id) throw new ApiError('Du bist nicht mehr angemeldet. Bitte melde dich neu an.', 'nicht_angemeldet');
  return id;
}

async function callFunction<T>(name: string, body: unknown, auth = true): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', apikey: SUPABASE_KEY };
  if (auth) {
    const { data } = await supabase.auth.getSession();
    if (!data.session) throw new ApiError('Du bist nicht mehr angemeldet. Bitte melde dich neu an.', 'nicht_angemeldet');
    headers.Authorization = `Bearer ${data.session.access_token}`;
  }
  let res: Response;
  try {
    res = await fetch(`${SUPABASE_URL}/functions/v1/${name}`, { method: 'POST', headers, body: JSON.stringify(body ?? {}) });
  } catch {
    throw new ApiError('Keine Verbindung. Prüfe dein Internet und versuch es noch einmal.', 'netz');
  }
  let json: { ok?: boolean; text?: unknown; grund?: unknown } = {};
  try { json = (await res.json()) as typeof json; } catch { /* leer */ }
  if (!res.ok || json.ok === false) {
    throw new ApiError(typeof json.text === 'string' ? json.text : '', typeof json.grund === 'string' ? json.grund : `http_${res.status}`);
  }
  return json as T;
}

// ---------- Anmeldung ----------
export const auth = {
  session: async (): Promise<Session | null> => (await supabase.auth.getSession()).data.session,
  onChange: (fn: (s: Session | null) => void) => supabase.auth.onAuthStateChange((_e, s) => fn(s)).data.subscription,
  async signIn(email: string, password: string) {
    const { error } = await supabase.auth.signInWithPassword({ email: email.trim().toLowerCase(), password });
    if (error) {
      if (/invalid/i.test(error.message)) throw new ApiError('E-Mail oder Passwort stimmt nicht.', 'login');
      fail(error);
    }
  },
  async signUp(input: { email: string; password: string; code: string; consent: boolean }) {
    return callFunction<{ ok: true; gueltig_bis?: string; probe?: boolean }>('signup', input, false);
  },
  async signOut() {
    await supabase.auth.signOut();
  },
  async changePassword(password: string) {
    const { error } = await supabase.auth.updateUser({ password });
    if (error) fail(error, 'Das Passwort konnte nicht geändert werden.');
  },
};

export const SIGNUP_GRUND: Record<string, string> = {
  email: 'Bitte prüfe die E-Mail-Adresse.',
  passwort: 'Das Passwort braucht mindestens 10 Zeichen.',
  einwilligung: 'Bitte stimm der Datenschutzerklärung und den Bedingungen zu.',
  code: 'Dieser Code gilt nicht. Prüf die Schreibweise oder frag nach einem neuen.',
  code_noetig: 'Die Anmeldung ist gerade nur mit Einladungscode möglich.',
  konto_existiert: 'Mit dieser Adresse gibt es schon ein Konto. Melde dich an.',
  netz: 'Keine Verbindung. Prüfe dein Internet und versuch es noch einmal.',
};

// ---------- Konto und Zugang ----------
export async function getConfig(): Promise<PublicConfig> {
  const { data, error } = await supabase.rpc('public_config');
  if (error) return { offene_registrierung: false, preis: null, pausiert: false };
  return data as PublicConfig;
}

export async function getMember(): Promise<Member | null> {
  const id = await uid();
  const { data, error } = await supabase.from('members').select('*').eq('user_id', id).maybeSingle();
  if (error) fail(error);
  return data as Member | null;
}

export async function isAdmin(): Promise<boolean> {
  const { data, error } = await supabase.rpc('is_admin');
  return !error && data === true;
}

export async function adminOverview(): Promise<Record<string, unknown>> {
  const { data, error } = await supabase.rpc('admin_overview');
  if (error) fail(error, 'Keine Berechtigung für den Admin-Bereich.');
  return data as Record<string, unknown>;
}

export type WartelisteEintrag = { id: string; email: string; note: string | null; source: string | null; created_at: string; invited_at: string | null; hat_konto: boolean };
export type OffenerCode = { code: string; note: string | null; days: number; expires_at: string | null; created_at: string };

export async function adminWarteliste(): Promise<WartelisteEintrag[]> {
  const { data, error } = await supabase.rpc('admin_warteliste');
  if (error) fail(error, 'Die Warteliste konnte nicht geladen werden.');
  return (data ?? []) as WartelisteEintrag[];
}

/** Persönlichen Code für einen Eintrag der Warteliste erzeugen. Der Eintrag gilt danach als eingeladen. */
export async function adminEinladen(id: string): Promise<string> {
  const { data, error } = await supabase.rpc('admin_einladen', { p_id: id });
  if (error) fail(error, 'Der Code konnte nicht erzeugt werden.');
  return String(data);
}

export async function adminCodes(anzahl: number, tage: number, notiz: string): Promise<string[]> {
  const { data, error } = await supabase.rpc('admin_codes', { p_anzahl: anzahl, p_tage: tage, p_notiz: notiz });
  if (error) fail(error, 'Die Codes konnten nicht erzeugt werden.');
  return (data ?? []) as string[];
}

export async function adminOffeneCodes(): Promise<OffenerCode[]> {
  const { data, error } = await supabase.rpc('admin_offene_codes');
  if (error) fail(error, 'Die Codes konnten nicht geladen werden.');
  return (data ?? []) as OffenerCode[];
}

export async function redeemCode(code: string): Promise<{ ok: boolean; grund?: string; gueltig_bis?: string; tarif?: string }> {
  const { data, error } = await supabase.rpc('redeem_code', { p_code: code.trim().toUpperCase() });
  if (error) fail(error);
  return data as { ok: boolean; grund?: string; gueltig_bis?: string; tarif?: string };
}

export async function billing(action: 'checkout' | 'portal'): Promise<string> {
  const r = await callFunction<{ ok: true; url: string }>('billing', { action, return_url: window.location.origin });
  return r.url;
}

export const BILLING_GRUND: Record<string, string> = {
  zahlung_nicht_eingerichtet: 'Die Bezahlung ist noch nicht freigeschaltet. Bis dahin geht es nur mit Code.',
  hat_abo: 'Du hast schon ein Abo. Verwalten kannst du es über „Abo verwalten“.',
  kein_kunde: 'Es gibt noch kein Abo zu verwalten.',
  kein_zugang: 'Dein Konto ist nicht aktiv.',
  netz: 'Keine Verbindung. Prüfe dein Internet und versuch es noch einmal.',
};

// ---------- Profil ----------
export async function getProfile(): Promise<Profile | null> {
  const id = await uid();
  const { data, error } = await supabase.from('job_profile').select('*').eq('user_id', id).maybeSingle();
  if (error) fail(error);
  return data as Profile | null;
}

export async function saveProfile(patch: Partial<Omit<Profile, 'user_id' | 'updated_at'>>): Promise<Profile> {
  const id = await uid();
  const { data, error } = await supabase.from('job_profile').upsert({ user_id: id, ...patch }, { onConflict: 'user_id' }).select('*').single();
  if (error) {
    if (error.code === '42501' || /row-level security/i.test(error.message)) throw new ApiError('Dein Zugang ist nicht aktiv. Ohne Zugang kann das Profil nicht gespeichert werden.', 'kein_zugang');
    if (error.code === '23514') throw new ApiError('Ein Feld ist zu lang. Bitte kürze den Text.', 'zu_lang');
    fail(error, 'Das Profil konnte nicht gespeichert werden.');
  }
  return data as Profile;
}

export async function uploadCv(file: File): Promise<string> {
  const id = await uid();
  const path = `${id}/lebenslauf.pdf`;
  const { error } = await supabase.storage.from('cvs').upload(path, file, { upsert: true, contentType: 'application/pdf', cacheControl: '0' });
  if (error) fail(error, 'Der Lebenslauf konnte nicht hochgeladen werden.');
  return path;
}

export async function downloadCv(path: string): Promise<Blob> {
  const { data, error } = await supabase.storage.from('cvs').download(path);
  if (error || !data) fail(error, 'Der Lebenslauf konnte nicht geladen werden.');
  return data;
}

// ---------- Treffer und Läufe ----------
export async function listLeads(): Promise<Lead[]> {
  const id = await uid();
  const { data, error } = await supabase.from('job_leads').select('*').eq('user_id', id).neq('status', 'geloescht').order('created_at', { ascending: false }).limit(500);
  if (error) fail(error, 'Die Treffer konnten nicht geladen werden.');
  return (data ?? []) as Lead[];
}

const LEAD_FELDER = new Set(['status', 'notes', 'archive_reason', 'applied_at', 'next_at', 'stage_updated_at', 'interview1_input', 'interview2_input', 'email_subject', 'email_body', 'cover_letter_md']);

export async function updateLead(leadId: string, patch: Partial<Lead>): Promise<Lead> {
  const sauber = Object.fromEntries(Object.entries(patch).filter(([k]) => LEAD_FELDER.has(k)));
  const { data, error } = await supabase.from('job_leads').update(sauber).eq('id', leadId).select('*').single();
  if (error) fail(error, 'Die Änderung konnte nicht gespeichert werden.');
  return data as Lead;
}

export async function requestRun(kind: 'scout' | 'entwurf' | 'vorbereitung', leadId?: string, stage?: 'interview1' | 'interview2'): Promise<RunResult> {
  const { data, error } = await supabase.rpc('request_run', { p_kind: kind, p_lead: leadId ?? null, p_stage: stage ?? null });
  if (error) fail(error);
  return data as RunResult;
}

/** Entwurf sofort schreiben lassen. Klappt das nicht, übernimmt der Hintergrundlauf den Auftrag. */
export async function runNow(queueId: string): Promise<boolean> {
  try {
    await callFunction('run-now', { queue_id: queueId });
    return true;
  } catch {
    return false;
  }
}

export type TraumjobFelder = { zielrollen: string; stellenarten: string[]; orte: string[]; start: string; ausschluesse: string; wuensche: string };

/** Aus „Beschreib deinen perfekten Job“ die Suchfelder vorschlagen lassen. */
export async function profilVorschlag(text: string): Promise<TraumjobFelder> {
  const r = await callFunction<{ ok: true; felder: TraumjobFelder }>('profil-vorschlag', { text });
  return r.felder;
}

export async function openQueue(): Promise<QueueItem[]> {
  const id = await uid();
  const { data, error } = await supabase.from('queue').select('*').eq('user_id', id).order('created_at', { ascending: false }).limit(30);
  if (error) fail(error);
  return (data ?? []) as QueueItem[];
}

export async function sendFeedback(body: string, context: string): Promise<void> {
  const id = await uid();
  const { error } = await supabase.from('feedback').insert({ user_id: id, body: body.slice(0, 4000), context: context.slice(0, 200) });
  if (error) fail(error, 'Die Rückmeldung konnte nicht gesendet werden.');
}

// ---------- Daten exportieren und löschen ----------
export async function exportAll(): Promise<Blob> {
  const id = await uid();
  const [s, profil, mitglied, treffer, einw, auftraege, rueck] = await Promise.all([
    supabase.auth.getUser(),
    supabase.from('job_profile').select('*').eq('user_id', id).maybeSingle(),
    supabase.from('members').select('plan,status,valid_until,sub_status,cancel_at_period_end,joined_at').eq('user_id', id).maybeSingle(),
    supabase.from('job_leads').select('*').eq('user_id', id),
    supabase.from('consents').select('kind,version,accepted_at').eq('user_id', id),
    supabase.from('queue').select('kind,status,created_at,finished_at').eq('user_id', id),
    supabase.from('feedback').select('body,context,created_at').eq('user_id', id),
  ]);
  const fehler = [profil, mitglied, treffer, einw, auftraege, rueck].find((r) => r.error);
  if (fehler?.error) fail(fehler.error, 'Der Export ist fehlgeschlagen.');
  const daten = {
    exportiert_am: new Date().toISOString(),
    konto: { id, email: s.data.user?.email ?? null, angelegt: s.data.user?.created_at ?? null },
    profil: profil.data, zugang: mitglied.data, treffer: treffer.data, einwilligungen: einw.data, auftraege: auftraege.data, rueckmeldungen: rueck.data,
    hinweis: 'Den hochgeladenen Lebenslauf (PDF) lädst du im Profil herunter.',
  };
  return new Blob([JSON.stringify(daten, null, 2)], { type: 'application/json' });
}

export async function deleteAccount(): Promise<void> {
  await callFunction('delete-account', { confirm: 'LÖSCHEN' });
  await supabase.auth.signOut();
}
