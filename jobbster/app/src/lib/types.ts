export type LeadStatus = 'neu' | 'entwurf' | 'beworben' | 'interview' | 'interview2' | 'vertrag' | 'zusage' | 'absage' | 'verworfen' | 'geloescht';

export type Keyword = { term: string; matched: boolean };

export type InterviewInput = { mail?: string; when?: string; durationMin?: number; format?: string; people?: string; recap?: string };

export type Prep = {
  headline: string;
  format: string;
  people: { name: string; role: string; about: string; link: string }[];
  company: string[];
  process: string[];
  they_want: string[];
  must_say: string[];
  questions: { q: string; a: string }[];
  ask_back: string[];
  watch_out: string[];
  salary: string | null;
  sources: { title: string; url: string }[];
  generated_at?: string;
};

export type Lead = {
  id: string;
  kind: 'stelle' | 'initiativ';
  source: string | null;
  company: string;
  title: string;
  location: string | null;
  url: string | null;
  apply_channel: 'email' | 'portal' | 'linkedin' | 'sonstiges';
  apply_email: string | null;
  contact_name: string | null;
  posted_at: string | null;
  deadline: string | null;
  salary: string | null;
  language: string | null;
  match_score: number | null;
  keywords: Keyword[];
  summary: string | null;
  requirements: string | null;
  why_fit: string | null;
  pre_info: string | null;
  status: LeadStatus;
  email_subject: string | null;
  email_body: string | null;
  cover_letter_md: string | null;
  cv_highlights: string | null;
  drafted_at: string | null;
  applied_at: string | null;
  notes: string | null;
  archive_reason: string | null;
  requested_at: string | null;
  next_at: string | null;
  stage_updated_at: string | null;
  interview1_input: InterviewInput | null;
  interview1_prep: Prep | null;
  interview2_input: InterviewInput | null;
  interview2_prep: Prep | null;
  prep_requested_at: string | null;
  created_at: string;
  updated_at: string;
};

export type Preferences = {
  zielrollen?: string;
  stellenarten?: string[];
  orte?: string[];
  start?: string;
  level?: string;
  ausschluesse?: string;
  engagement?: string;
  wuensche?: string;
  land?: string;
  zeitzone?: string;
  /** Der perfekte Job in eigenen Worten. Wichtigste Quelle für Suche und Anschreiben. */
  traumjob?: string;
  /** Bewerbungen pro Tag: so viele Treffer sucht der tägliche Lauf (1 bis 12, empfohlen 10). */
  pro_tag?: number;
};

export type Profile = {
  user_id: string;
  full_name: string | null;
  application_email: string | null;
  phone: string | null;
  location: string | null;
  linkedin_url: string | null;
  headline: string | null;
  cv_text: string | null;
  cv_path: string | null;
  languages: string | null;
  experience: string | null;
  skills: string | null;
  preferences: Preferences;
  onboarded_at: string | null;
  updated_at: string;
};

export type Member = {
  user_id: string;
  plan: 'beta' | 'pass' | 'gutschein' | 'garantie' | 'neu' | 'abo';
  status: 'aktiv' | 'gesperrt';
  valid_until: string | null;
  limits: Record<string, { anzahl: number; tage: number }> | null;
  sub_status: string | null;
  cancel_at_period_end: boolean;
  trial_used: boolean;
  stripe_customer_id?: string | null;
  joined_at: string;
};

export type QueueItem = {
  id: string;
  kind: 'scout' | 'entwurf' | 'vorbereitung';
  lead_id: string | null;
  stage: string | null;
  status: 'wartet' | 'laeuft' | 'fertig' | 'fehler';
  error: string | null;
  created_at: string;
  finished_at: string | null;
};

export type RunResult = { ok: boolean; grund?: string; queue_id?: string; rest?: number; frei_ab?: string; limit?: number };

export type PublicConfig = { offene_registrierung: boolean; preis: { betrag_eur: number; intervall: string; probe_tage: number } | null; pausiert: boolean };
