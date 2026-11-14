-- Zusage · Probe-Codes (11.11.2026, abends). Eingespielt als Migration zusage_probe_grenzen.
-- Ein Code kann eigene, kleinere Grenzen mitbringen. So gibt es eine Gratis-Probe:
-- 7 Tage, 1 Suchlauf, 1 Entwurf, keine Gesprächsvorbereitung. Ohne eigene Grenzen gelten die normalen aus app_config.grenzen.
-- Probe-Codes gelten nur für neue Konten. Wer danach einen Pass einlöst, bekommt die vollen Grenzen.
--
-- Codes erzeugen (nur Service-Rolle), zum Beispiel im SQL-Editor:
--   select * from public.create_probe_invites(10, 'MCI Forum 18.11.');

alter table public.invites add column limits jsonb check (limits is null or pg_column_size(limits) <= 2000);
alter table public.members add column limits jsonb check (limits is null or pg_column_size(limits) <= 2000);

insert into public.app_config (key, value) values
  ('grenzen_probe', '{"scout": {"anzahl": 1, "tage": 7}, "entwurf": {"anzahl": 1, "tage": 7}, "vorbereitung": {"anzahl": 0, "tage": 7}}'::jsonb)
on conflict (key) do nothing;

-- Code einlösen und Tage, Tarif und Grenzen zurückgeben (null, wenn der Code nicht gilt). Nur Service-Rolle.
create or replace function public.claim_invite_v2(p_code text) returns jsonb
language plpgsql set search_path to '' as $$
declare r jsonb;
begin
  update public.invites set used_count = used_count + 1
  where code = p_code and used_count < max_uses and (expires_at is null or expires_at > now())
  returning jsonb_build_object('days', days, 'plan', plan, 'limits', limits) into r;
  return r;
end;
$$;

-- Angemeldete lösen einen weiteren Code ein: Verlängerung, Gutschein oder Garantie-Monat
create or replace function public.redeem_code(p_code text) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare
  uid uuid := (select auth.uid());
  r jsonb;
  bis timestamptz;
begin
  if uid is null then
    return jsonb_build_object('ok', false, 'grund', 'nicht_angemeldet');
  end if;
  if exists (select 1 from public.members m where m.user_id = uid and m.status = 'gesperrt') then
    return jsonb_build_object('ok', false, 'grund', 'kein_zugang');
  end if;
  if p_code is null or length(trim(p_code)) not between 8 and 64 then
    return jsonb_build_object('ok', false, 'grund', 'code');
  end if;
  -- Probe-Codes (Codes mit eigenen Grenzen) gelten nur bei der ersten Anmeldung
  if exists (select 1 from public.members m where m.user_id = uid)
     and exists (select 1 from public.invites i where i.code = trim(p_code) and i.limits is not null) then
    return jsonb_build_object('ok', false, 'grund', 'nur_neue_konten');
  end if;
  r := public.claim_invite_v2(trim(p_code));
  if r is null then
    return jsonb_build_object('ok', false, 'grund', 'code');
  end if;
  insert into public.members as m (user_id, invite_code, plan, valid_until, limits)
  values (uid, trim(p_code), r ->> 'plan', now() + make_interval(days => (r ->> 'days')::integer), nullif(r -> 'limits', 'null'::jsonb))
  on conflict (user_id) do update
    set valid_until = case when m.valid_until is null then null
                           else greatest(m.valid_until, now()) + make_interval(days => (r ->> 'days')::integer) end,
        plan = excluded.plan,
        invite_code = excluded.invite_code,
        limits = excluded.limits
  returning m.valid_until into bis;
  return jsonb_build_object('ok', true, 'gueltig_bis', bis, 'tarif', r ->> 'plan');
end;
$$;
revoke all on function public.claim_invite_v2(text), public.redeem_code(text) from public, anon, authenticated;
grant execute on function public.redeem_code(text) to authenticated;
grant execute on function public.claim_invite_v2(text), public.redeem_code(text) to service_role;

create or replace function public.create_probe_invites(p_count integer, p_note text, p_max_uses integer default 1, p_expires timestamptz default null)
returns setof text language plpgsql set search_path to '' as $$
declare c text;
begin
  for c in select public.create_invites(p_count, 7, 'beta', p_note, p_max_uses, p_expires) loop
    update public.invites set limits = (select value from public.app_config where key = 'grenzen_probe') where code = c;
    return next c;
  end loop;
end;
$$;
revoke all on function public.create_probe_invites(integer, text, integer, timestamptz) from public, anon, authenticated;
grant execute on function public.create_probe_invites(integer, text, integer, timestamptz) to service_role;

-- Lauf anfordern: der einzige Weg, wie ein Nutzer Kosten auslöst. Aktuelle Fassung.
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

  -- eigene Grenzen des Mitglieds (Probe) gehen vor, sonst die normalen
  g := coalesce((select m.limits -> p_kind from public.members m where m.user_id = uid),
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
$$;
