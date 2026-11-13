-- Zusage · Grundschema (11.11.2026)
-- Getrennt von JARVIS. Jede Tabelle hat RLS. Die Rolle anon bekommt nichts.
-- Schreiben dürfen Nutzer nur in ihr Profil, ihre Treffer und ihr Feedback.
-- Läufe (Scout, Entwurf, Vorbereitung) gehen nur über request_run(): dort liegen die Grenzen.

-- ---------------------------------------------------------------------------
-- Hilfsfunktionen
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path to '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create or replace function public.jl_company_key(t text) returns text
language sql immutable set search_path to '' as $$
  select trim(regexp_replace(regexp_replace(lower(coalesce(t, '')),
    '\(.*?\)|\[.*?\]|\m(gmbh|mbh|ag|se|kg|kgaa|co|inc|ltd|llc|sa|sl|bv|group|gruppe|deutschland|germany|austria|österreich|standort|holding|wirtschaftsprüfungsgesellschaft|gesellschaft|ehem)\M|[^a-zäöüß0-9 ]', ' ', 'g'), '\s+', ' ', 'g'))
$$;

create or replace function public.jl_title_key(t text) returns text
language sql immutable set search_path to '' as $$
  select trim(regexp_replace(regexp_replace(lower(coalesce(t, '')), '\(.*?\)|[^a-zäöüß0-9 ]', ' ', 'g'), '\s+', ' ', 'g'))
$$;

create or replace function public.jl_same_company(a text, b text) returns boolean
language sql immutable set search_path to '' as $$
  select public.jl_company_key(a) <> '' and public.jl_company_key(b) <> '' and (
    public.jl_company_key(a) = public.jl_company_key(b)
    or public.jl_company_key(a) like public.jl_company_key(b) || ' %'
    or public.jl_company_key(b) like public.jl_company_key(a) || ' %')
$$;

-- ---------------------------------------------------------------------------
-- Einladungen und Mitglieder
-- ---------------------------------------------------------------------------
create table public.invites (
  code text primary key check (length(code) between 8 and 64),
  note text,
  max_uses integer not null default 1 check (max_uses > 0),
  used_count integer not null default 0 check (used_count >= 0),
  expires_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.invites enable row level security; -- keine Policy: nur Service-Rolle

create table public.members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  invite_code text references public.invites(code) on delete set null,
  status text not null default 'aktiv' check (status in ('aktiv', 'gesperrt')),
  joined_at timestamptz not null default now()
);
alter table public.members enable row level security;
create policy members_select_own on public.members for select to authenticated
  using ((select auth.uid()) = user_id);

create table public.consents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('datenschutz', 'beta_bedingungen')),
  version text not null,
  accepted_at timestamptz not null default now(),
  unique (user_id, kind, version)
);
alter table public.consents enable row level security;
create policy consents_select_own on public.consents for select to authenticated
  using ((select auth.uid()) = user_id);

-- Schalter für den Betrieb (nur Service-Rolle): Tageslimit und Not-Aus
create table public.app_config (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.app_config enable row level security;
insert into public.app_config (key, value) values
  ('pausiert', 'false'::jsonb),
  ('tageslimit_usd', '3'::jsonb),
  ('grenzen', '{"scout": {"anzahl": 3, "tage": 7}, "entwurf": {"anzahl": 3, "tage": 1}, "vorbereitung": {"anzahl": 2, "tage": 7}}'::jsonb);

-- ---------------------------------------------------------------------------
-- Profil (Spalten wie in JARVIS, dazu cv_path und onboarded_at)
-- ---------------------------------------------------------------------------
create table public.job_profile (
  user_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  full_name text check (length(full_name) <= 200),
  application_email text check (length(application_email) <= 320),
  phone text check (length(phone) <= 60),
  location text check (length(location) <= 200),
  linkedin_url text check (length(linkedin_url) <= 300),
  headline text check (length(headline) <= 400),
  cv_text text check (length(cv_text) <= 30000),
  cv_path text check (length(cv_path) <= 400),
  languages text check (length(languages) <= 600),
  experience text check (length(experience) <= 6000),
  skills text check (length(skills) <= 3000),
  preferences jsonb not null default '{}'::jsonb check (pg_column_size(preferences) <= 20000),
  tone text check (length(tone) <= 400),
  onboarded_at timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.job_profile enable row level security;
create policy profile_select_own on public.job_profile for select to authenticated
  using ((select auth.uid()) = user_id);
create policy profile_insert_own on public.job_profile for insert to authenticated
  with check ((select auth.uid()) = user_id
    and exists (select 1 from public.members m where m.user_id = (select auth.uid()) and m.status = 'aktiv'));
create policy profile_update_own on public.job_profile for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create trigger job_profile_touch before update on public.job_profile
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Treffer, Entwürfe, Funnel (wie in JARVIS)
-- ---------------------------------------------------------------------------
create table public.job_leads (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  dedup_key text not null,
  kind text not null default 'stelle' check (kind in ('stelle', 'initiativ')),
  source text,
  company text not null,
  title text not null,
  location text,
  url text,
  apply_channel text not null default 'portal' check (apply_channel in ('email', 'portal', 'linkedin', 'sonstiges')),
  apply_email text,
  contact_name text,
  posted_at date,
  deadline date,
  salary text,
  language text,
  match_score integer check (match_score between 0 and 100),
  keywords jsonb not null default '[]'::jsonb,
  summary text,
  requirements text,
  why_fit text,
  pre_info text,
  status text not null default 'neu' check (status in ('neu', 'entwurf', 'beworben', 'interview', 'interview2', 'vertrag', 'zusage', 'absage', 'verworfen', 'geloescht')),
  email_subject text,
  email_body text,
  cover_letter_md text,
  cv_highlights text,
  drafted_at timestamptz,
  applied_at timestamptz,
  notes text check (length(notes) <= 20000),
  archive_reason text check (length(archive_reason) <= 500),
  requested_at timestamptz,
  next_at timestamptz,
  stage_updated_at timestamptz,
  interview1_input jsonb check (pg_column_size(interview1_input) <= 40000),
  interview1_prep jsonb,
  interview2_input jsonb check (pg_column_size(interview2_input) <= 40000),
  interview2_prep jsonb,
  prep_requested_at timestamptz,
  contract_info jsonb check (pg_column_size(contract_info) <= 20000),
  contract_path text check (length(contract_path) <= 400),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, dedup_key)
);
create index job_leads_user_status on public.job_leads (user_id, status, match_score desc);
alter table public.job_leads enable row level security;
create policy leads_select_own on public.job_leads for select to authenticated
  using ((select auth.uid()) = user_id);
create policy leads_update_own on public.job_leads for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create trigger job_leads_touch before update on public.job_leads
  for each row execute function public.touch_updated_at();

-- Jede Firma nur einmal pro Nutzer (wie in JARVIS seit 09.11.)
create or replace function public.jl_block_duplicates() returns trigger
language plpgsql set search_path to '' as $$
begin
  if exists (
    select 1 from public.job_leads r
    where r.user_id = new.user_id
      and public.jl_same_company(r.company, new.company)
      and (r.status not in ('verworfen', 'geloescht')
           or public.jl_title_key(r.title) = public.jl_title_key(new.title)
           or (r.url is not null and r.url = new.url))
  ) then
    return null;
  end if;
  return new;
end $$;
create trigger job_leads_block_duplicates before insert on public.job_leads
  for each row execute function public.jl_block_duplicates();

-- ---------------------------------------------------------------------------
-- Warteschlange und Lauf-Protokoll
-- ---------------------------------------------------------------------------
create table public.queue (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('scout', 'entwurf', 'vorbereitung')),
  lead_id uuid references public.job_leads(id) on delete cascade,
  stage text check (stage in ('interview1', 'interview2')),
  status text not null default 'wartet' check (status in ('wartet', 'laeuft', 'fertig', 'fehler')),
  error text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create index queue_offen on public.queue (status, created_at) where status in ('wartet', 'laeuft');
create index queue_user_kind on public.queue (user_id, kind, created_at desc);
alter table public.queue enable row level security;
create policy queue_select_own on public.queue for select to authenticated
  using ((select auth.uid()) = user_id);

-- Kosten pro Lauf. Bleibt nach dem Löschen eines Kontos ohne Personenbezug erhalten.
create table public.runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) on delete set null,
  queue_id uuid references public.queue(id) on delete set null,
  agent text not null check (agent in ('scout', 'writer', 'coach')),
  model text,
  requests integer,
  searches integer,
  fetches integer,
  input_tokens bigint,
  output_tokens bigint,
  cost_usd numeric(10, 4),
  duration_ms integer,
  result_count integer,
  status text not null default 'ok' check (status in ('ok', 'fehler')),
  error text,
  created_at timestamptz not null default now()
);
create index runs_tag on public.runs (created_at);
create index runs_user on public.runs (user_id, created_at desc);
create index runs_queue on public.runs (queue_id);
alter table public.runs enable row level security; -- keine Policy: nur Service-Rolle

create table public.feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  body text not null check (length(body) between 1 and 4000),
  context text check (length(context) <= 200),
  created_at timestamptz not null default now()
);
create index feedback_user on public.feedback (user_id);
alter table public.feedback enable row level security;
create policy feedback_select_own on public.feedback for select to authenticated
  using ((select auth.uid()) = user_id);
create policy feedback_insert_own on public.feedback for insert to authenticated
  with check ((select auth.uid()) = user_id
    and exists (select 1 from public.members m where m.user_id = (select auth.uid()) and m.status = 'aktiv'));

create index consents_user on public.consents (user_id);
create index members_invite on public.members (invite_code);
create index queue_lead on public.queue (lead_id);

-- ---------------------------------------------------------------------------
-- Lauf anfordern: der einzige Weg, wie ein Nutzer Kosten auslösen kann
-- ---------------------------------------------------------------------------
create or replace function public.request_run(p_kind text, p_lead uuid default null, p_stage text default null)
returns jsonb language plpgsql security definer set search_path to '' as $$
declare
  uid uuid := (select auth.uid());
  g jsonb;
  lim integer;
  win interval;
  n integer;
  frei timestamptz;
  q uuid;
begin
  if uid is null then
    return jsonb_build_object('ok', false, 'grund', 'nicht_angemeldet');
  end if;
  if p_kind not in ('scout', 'entwurf', 'vorbereitung') then
    return jsonb_build_object('ok', false, 'grund', 'unbekannte_art');
  end if;
  if not exists (select 1 from public.members m where m.user_id = uid and m.status = 'aktiv') then
    return jsonb_build_object('ok', false, 'grund', 'kein_zugang');
  end if;
  if coalesce((select value from public.app_config where key = 'pausiert'), 'false'::jsonb) = 'true'::jsonb then
    return jsonb_build_object('ok', false, 'grund', 'pausiert');
  end if;
  if not exists (select 1 from public.job_profile p where p.user_id = uid and length(coalesce(p.cv_text, '')) >= 200) then
    return jsonb_build_object('ok', false, 'grund', 'profil_fehlt');
  end if;
  if p_kind <> 'scout' and (p_lead is null or not exists (select 1 from public.job_leads l where l.id = p_lead and l.user_id = uid)) then
    return jsonb_build_object('ok', false, 'grund', 'treffer_fehlt');
  end if;
  if p_kind = 'vorbereitung' and coalesce(p_stage, '') not in ('interview1', 'interview2') then
    return jsonb_build_object('ok', false, 'grund', 'stufe_fehlt');
  end if;

  -- gleichzeitige Klicks nacheinander abarbeiten
  perform pg_advisory_xact_lock(hashtextextended(uid::text || ':' || p_kind, 0));

  if exists (select 1 from public.queue x where x.user_id = uid and x.kind = p_kind and x.status in ('wartet', 'laeuft')
             and (p_kind = 'scout' or x.lead_id = p_lead)) then
    return jsonb_build_object('ok', false, 'grund', 'laeuft_schon');
  end if;

  g := (select value -> p_kind from public.app_config where key = 'grenzen');
  lim := coalesce((g ->> 'anzahl')::integer, 1);
  win := make_interval(days => coalesce((g ->> 'tage')::integer, 7));

  select count(*), min(x.created_at) + win into n, frei
  from public.queue x
  where x.user_id = uid and x.kind = p_kind and x.status <> 'fehler' and x.created_at > now() - win;
  if n >= lim then
    return jsonb_build_object('ok', false, 'grund', 'limit', 'limit', lim, 'frei_ab', frei);
  end if;

  insert into public.queue (user_id, kind, lead_id, stage)
  values (uid, p_kind, case when p_kind = 'scout' then null else p_lead end, case when p_kind = 'vorbereitung' then p_stage end)
  returning id into q;

  if p_kind = 'entwurf' then
    update public.job_leads set requested_at = now() where id = p_lead and user_id = uid;
  elsif p_kind = 'vorbereitung' then
    update public.job_leads set prep_requested_at = now() where id = p_lead and user_id = uid;
  end if;

  return jsonb_build_object('ok', true, 'queue_id', q, 'rest', lim - n - 1);
end;
$$;

-- Einladung einlösen: nur die Service-Rolle (Edge Function „signup“)
create or replace function public.claim_invite(p_code text) returns boolean
language plpgsql set search_path to '' as $$
declare ok boolean;
begin
  update public.invites set used_count = used_count + 1
  where code = p_code and used_count < max_uses and (expires_at is null or expires_at > now())
  returning true into ok;
  return coalesce(ok, false);
end;
$$;

create or replace function public.release_invite(p_code text) returns void
language sql set search_path to '' as $$
  update public.invites set used_count = greatest(used_count - 1, 0) where code = p_code;
$$;
