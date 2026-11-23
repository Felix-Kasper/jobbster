-- Gratis-Probe zum Selbststarten (23.11.2026, Entscheidung Felix):
-- 1. In der Probe gehen höchstens 6 Entwürfe pro Tag (vorher 12). Gilt für Probe-Codes und für die Stripe-Probe (trialing).
-- 2. „Gratis testen“ auf der Landingpage erzeugt sofort einen Probe-Code und schickt direkt zur Anmeldung.
--    Bremsen: höchstens app_config.probe_selbst.pro_tag Codes am Tag (Standard 30), ein Code pro Adresse,
--    Code nur 3 Tage einlösbar, Not-Aus über probe_selbst.an = false (dann wieder nur Warteliste).
-- Eingespielt als Migration probe_selbst.

update public.app_config
set value = jsonb_set(value, '{entwurf}', '{"anzahl": 6, "tage": 1}'::jsonb), updated_at = now()
where key = 'grenzen_probe';

insert into public.app_config (key, value) values ('probe_selbst', '{"an": true, "pro_tag": 30}'::jsonb)
on conflict (key) do nothing;

-- Offene Probe-Codes, die noch die alten Grenzen tragen, auf 6 Entwürfe setzen
update public.invites
set limits = jsonb_set(limits, '{entwurf}', '{"anzahl": 6, "tage": 1}'::jsonb)
where limits is not null and used_count = 0;

alter table public.waitlist add column if not exists invite_code text;

-- Eintrag in die Warteliste und, wenn erlaubt, sofort ein Probe-Code.
-- Antwort: {status: 'code', code} | {status: 'konto'} (Adresse hat schon ein Konto) | {status: 'liste'} | {status: 'voll'}
create or replace function public.waitlist_probe(p_email text, p_source text, p_note text, p_version text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  mail text := lower(trim(p_email));
  cfg jsonb := coalesce((select value from public.app_config where key = 'probe_selbst'), '{"an": false}'::jsonb);
  w public.waitlist;
  c text;
begin
  if (select count(*) from public.waitlist where created_at > now() - interval '1 hour') >= 200 then
    return jsonb_build_object('status', 'voll');
  end if;

  insert into public.waitlist (email, source, note, consent_version)
  values (mail, nullif(left(trim(coalesce(p_source, '')), 60), ''), nullif(left(trim(coalesce(p_note, '')), 500), ''), p_version)
  on conflict (lower(email)) do nothing;
  select * into w from public.waitlist where lower(email) = mail for update;

  if exists (select 1 from auth.users u where lower(u.email) = mail) then
    return jsonb_build_object('status', 'konto');
  end if;

  -- Schon ein Code für diese Adresse, der noch gilt: denselben wieder geben
  if w.invite_code is not null and exists (
    select 1 from public.invites i where i.code = w.invite_code and i.used_count < i.max_uses and (i.expires_at is null or i.expires_at > now())
  ) then
    return jsonb_build_object('status', 'code', 'code', w.invite_code);
  end if;

  if coalesce((cfg ->> 'an')::boolean, false) is not true
     or (select count(*) from public.invites where note = 'Landingpage' and created_at > now() - interval '1 day')
        >= coalesce((cfg ->> 'pro_tag')::integer, 30) then
    return jsonb_build_object('status', 'liste');
  end if;

  select x into c from public.create_probe_invites(1, 'Landingpage', 1, now() + interval '3 days') x;
  update public.waitlist set invite_code = c, invited_at = now() where id = w.id;
  return jsonb_build_object('status', 'code', 'code', c);
end;
$$;

revoke all on function public.waitlist_probe(text, text, text, text) from public, anon, authenticated;
grant execute on function public.waitlist_probe(text, text, text, text) to service_role;

-- request_run: Die Stripe-Probe (trialing, ohne eigene Grenzen) bekommt die Probe-Grenzen
create or replace function public.request_run(p_kind text, p_lead uuid default null, p_stage text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
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
  if exists (select 1 from public.members m where m.user_id = uid and m.valid_until is not null and m.valid_until <= now()) then
    return jsonb_build_object('ok', false, 'grund', 'abgelaufen');
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

  perform pg_advisory_xact_lock(hashtextextended(uid::text || ':' || p_kind, 0));

  if exists (select 1 from public.queue x where x.user_id = uid and x.kind = p_kind and x.status in ('wartet', 'laeuft')
             and (p_kind = 'scout' or x.lead_id = p_lead)) then
    return jsonb_build_object('ok', false, 'grund', 'laeuft_schon');
  end if;

  -- eigene Grenzen des Mitglieds (Probe-Code) gehen vor, dann Probe-Grenzen für die Stripe-Probe, sonst die normalen
  g := coalesce((select m.limits -> p_kind from public.members m where m.user_id = uid),
                (select c.value -> p_kind from public.app_config c, public.members m
                  where c.key = 'grenzen_probe' and m.user_id = uid and m.sub_status = 'trialing'),
                (select value -> p_kind from public.app_config where key = 'grenzen'));
  lim := coalesce((g ->> 'anzahl')::integer, 1);
  win := make_interval(days => coalesce((g ->> 'tage')::integer, 7));
  if lim <= 0 then
    return jsonb_build_object('ok', false, 'grund', 'nicht_im_paket');
  end if;

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
$function$;
