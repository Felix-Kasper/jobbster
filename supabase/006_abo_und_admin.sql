-- Zusage · Abo und Admin (12.11.2026). Eingespielt als Migration zusage_abo_und_admin.
-- Entscheidung Felix 12.11.: 7 Tage Probe, danach automatisch Monats-Abo, Kündigung jederzeit im Konto.
-- Stripe ist die Quelle der Wahrheit für Abos. Der Webhook schreibt Status und Laufzeit in members.
-- valid_until bleibt das eine Feld, das request_run prüft: Probe, Abo und Codes laufen alle darüber.

alter table public.members
  add column stripe_customer_id text unique,
  add column stripe_subscription_id text unique,
  add column sub_status text check (sub_status in ('trialing', 'active', 'past_due', 'canceled', 'unpaid', 'incomplete', 'incomplete_expired', 'paused')),
  add column cancel_at_period_end boolean not null default false,
  add column trial_used boolean not null default false;

alter table public.members drop constraint members_plan_check;
alter table public.members add constraint members_plan_check check (plan in ('beta', 'pass', 'gutschein', 'garantie', 'neu', 'abo'));

-- Jedes Stripe-Ereignis nur einmal verarbeiten (Schutz vor doppelten Buchungen bei Wiederholungen)
create table public.stripe_events (
  id text primary key,
  type text not null,
  received_at timestamptz not null default now()
);
alter table public.stripe_events enable row level security;

-- Wer Admin ist, steht nur hier. Eintragen nur im SQL-Editor.
create table public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.admins enable row level security;

insert into public.app_config (key, value) values
  ('offene_registrierung', 'false'::jsonb),
  ('preis', '{"betrag_eur": 19, "intervall": "monat", "probe_tage": 7}'::jsonb)
on conflict (key) do nothing;

-- Öffentliche Angaben für die App (Preis, ob man sich ohne Code anmelden kann). Keine Geheimnisse.
create or replace function public.public_config() returns jsonb
language sql stable security definer set search_path to '' as $$
  select jsonb_build_object(
    'offene_registrierung', coalesce((select value from public.app_config where key = 'offene_registrierung'), 'false'::jsonb),
    'preis', (select value from public.app_config where key = 'preis'),
    'pausiert', coalesce((select value from public.app_config where key = 'pausiert'), 'false'::jsonb));
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path to '' as $$
  select exists (select 1 from public.admins a where a.user_id = (select auth.uid()));
$$;

-- Übersicht für den Admin-Bereich. Nur Admins bekommen Daten.
create or replace function public.admin_overview() returns jsonb
language plpgsql stable security definer set search_path to '' as $$
declare r jsonb;
begin
  if not public.is_admin() then
    raise exception 'kein_admin' using errcode = '42501';
  end if;
  select jsonb_build_object(
    'stand', now(),
    'nutzer', (select count(*) from public.members),
    'aktiv', (select count(*) from public.members m where m.status = 'aktiv' and (m.valid_until is null or m.valid_until > now())),
    'probe', (select count(*) from public.members m where m.sub_status = 'trialing' or (m.limits is not null and m.valid_until > now())),
    'zahlend', (select count(*) from public.members m where m.sub_status = 'active'),
    'gekuendigt', (select count(*) from public.members m where m.cancel_at_period_end and m.sub_status in ('trialing', 'active')),
    'zahlung_offen', (select count(*) from public.members m where m.sub_status in ('past_due', 'unpaid', 'incomplete')),
    'aktiv_7_tage', (select count(distinct q.user_id) from public.queue q where q.created_at > now() - interval '7 days'),
    'kosten_heute', (select coalesce(sum(cost_usd), 0) from public.runs where created_at >= date_trunc('day', now())),
    'kosten_7_tage', (select coalesce(sum(cost_usd), 0) from public.runs where created_at > now() - interval '7 days'),
    'kosten_30_tage', (select coalesce(sum(cost_usd), 0) from public.runs where created_at > now() - interval '30 days'),
    'laeufe_30_tage', (select jsonb_object_agg(agent, n) from (select agent, count(*) n from public.runs where created_at > now() - interval '30 days' group by agent) x),
    'warteschlange', (select count(*) from public.queue where status in ('wartet', 'laeuft')),
    'warteliste', (select count(*) from public.waitlist where invited_at is null),
    'fehler', coalesce((select jsonb_agg(f) from (
        select r.created_at, r.agent, left(r.error, 200) as error, left(r.user_id::text, 8) as nutzer
        from public.runs r where r.status = 'fehler' order by r.created_at desc limit 20) f), '[]'::jsonb),
    'mitglieder', coalesce((select jsonb_agg(u) from (
        select left(m.user_id::text, 8) as id, au.email, m.plan, m.sub_status, m.valid_until, m.cancel_at_period_end, m.joined_at,
               (select count(*) from public.job_leads l where l.user_id = m.user_id) as treffer,
               (select count(*) from public.job_leads l where l.user_id = m.user_id and l.applied_at is not null) as beworben,
               (select coalesce(sum(cost_usd), 0) from public.runs x where x.user_id = m.user_id and x.created_at > now() - interval '30 days') as kosten_30
        from public.members m join auth.users au on au.id = m.user_id
        order by m.joined_at desc limit 200) u), '[]'::jsonb)
  ) into r;
  return r;
end;
$$;

-- Webhook: Abo-Stand aus Stripe übernehmen (nur Service-Rolle)
create or replace function public.apply_subscription(p_customer text, p_subscription text, p_status text, p_period_end timestamptz, p_cancel boolean, p_user uuid default null)
returns boolean language plpgsql set search_path to '' as $$
declare n integer;
begin
  update public.members m set
    stripe_customer_id = coalesce(m.stripe_customer_id, p_customer),
    stripe_subscription_id = p_subscription,
    sub_status = p_status,
    cancel_at_period_end = coalesce(p_cancel, false),
    trial_used = m.trial_used or p_status = 'trialing',
    plan = case when p_status in ('trialing', 'active', 'past_due') then 'abo' else m.plan end,
    limits = case when p_status in ('trialing', 'active', 'past_due') then null else m.limits end,
    valid_until = case
      when p_status in ('trialing', 'active') then p_period_end
      when p_status = 'past_due' then least(p_period_end, now() + interval '3 days') -- kurze Nachfrist, dann gesperrt bis bezahlt
      else least(coalesce(m.valid_until, now()), now()) end
  where (p_user is not null and m.user_id = p_user)
     or (p_user is null and (m.stripe_customer_id = p_customer or m.stripe_subscription_id = p_subscription));
  get diagnostics n = row_count;
  return n > 0;
end;
$$;

revoke all on public.stripe_events, public.admins from anon, authenticated;
revoke all on function public.public_config(), public.is_admin(), public.admin_overview(),
  public.apply_subscription(text, text, text, timestamptz, boolean, uuid) from public, anon, authenticated;
grant execute on function public.public_config() to anon, authenticated;
grant execute on function public.is_admin(), public.admin_overview() to authenticated;
grant execute on function public.public_config(), public.is_admin(), public.apply_subscription(text, text, text, timestamptz, boolean, uuid) to service_role;
