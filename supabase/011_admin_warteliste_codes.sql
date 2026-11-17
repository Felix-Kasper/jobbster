-- Jobbster · 011: Warteliste und Codes im Admin-Bereich, Codes mit Präfix JB
-- Vorher brauchten Einladungen den SQL-Editor. Jetzt: Admin-Seite zeigt die Warteliste, ein Klick erzeugt den Code
-- und öffnet eine fertige Mail. Bestehende Codes (ZS-…) bleiben gültig.

-- 1. Neue Codes beginnen mit JB
create or replace function public.create_invites(p_count integer, p_days integer, p_plan text, p_note text, p_max_uses integer default 1, p_expires timestamptz default null)
returns setof text language plpgsql set search_path to '' as $$
declare
  c text;
  i integer;
  h text;
begin
  if p_count not between 1 and 200 then
    raise exception 'Anzahl muss zwischen 1 und 200 liegen';
  end if;
  for i in 1..p_count loop
    h := upper(replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''));
    c := 'JB-' || substr(h, 1, 4) || '-' || substr(h, 5, 4) || '-' || substr(h, 33, 4) || '-' || substr(h, 37, 4);
    insert into public.invites (code, note, days, plan, max_uses, expires_at) values (c, p_note, p_days, p_plan, p_max_uses, p_expires);
    return next c;
  end loop;
end;
$$;
revoke all on function public.create_invites(integer, integer, text, text, integer, timestamptz) from public, anon, authenticated;

-- 2. Warteliste für Admins
create or replace function public.admin_warteliste() returns jsonb
language plpgsql stable security definer set search_path to '' as $$
begin
  if not public.is_admin() then
    raise exception 'kein_admin' using errcode = '42501';
  end if;
  return coalesce((select jsonb_agg(w order by w.created_at desc) from (
    select id, email, note, source, created_at, invited_at,
           exists (select 1 from auth.users u where lower(u.email) = lower(wl.email)) as hat_konto
    from public.waitlist wl order by created_at desc limit 300) w), '[]'::jsonb);
end;
$$;

-- 3. Eintrag der Warteliste einladen: erzeugt einen persönlichen Code (30 Tage, einmal einlösbar) und merkt das Datum
create or replace function public.admin_einladen(p_id uuid) returns text
language plpgsql security definer set search_path to '' as $$
declare
  w public.waitlist;
  c text;
begin
  if not public.is_admin() then
    raise exception 'kein_admin' using errcode = '42501';
  end if;
  select * into w from public.waitlist where id = p_id for update;
  if not found then
    raise exception 'nicht_gefunden' using errcode = 'P0002';
  end if;
  select public.create_invites(1, 30, 'beta', left('Warteliste: ' || w.email, 200), 1, now() + interval '60 days') into c;
  update public.waitlist set invited_at = now() where id = p_id;
  return c;
end;
$$;

-- 4. Codes ohne Warteliste erzeugen (zum Beispiel für persönliche Nachrichten), höchstens 50 auf einmal
create or replace function public.admin_codes(p_anzahl integer, p_tage integer default 30, p_notiz text default 'Admin') returns setof text
language plpgsql security definer set search_path to '' as $$
begin
  if not public.is_admin() then
    raise exception 'kein_admin' using errcode = '42501';
  end if;
  if p_anzahl not between 1 and 50 or p_tage not between 1 and 90 then
    raise exception 'grenzen' using errcode = '22023';
  end if;
  return query select public.create_invites(p_anzahl, p_tage, 'beta', left(coalesce(nullif(trim(p_notiz), ''), 'Admin'), 200), 1, now() + interval '60 days');
end;
$$;

-- 5. Offene Codes (noch nicht eingelöst, nicht abgelaufen). Der Rauchtest-Code bleibt verborgen.
create or replace function public.admin_offene_codes() returns jsonb
language plpgsql stable security definer set search_path to '' as $$
begin
  if not public.is_admin() then
    raise exception 'kein_admin' using errcode = '42501';
  end if;
  return coalesce((select jsonb_agg(x order by x.created_at desc) from (
    select code, note, days, expires_at, created_at from public.invites
    where used_count < max_uses and (expires_at is null or expires_at > now()) and coalesce(note, '') <> 'Rauchtest'
    order by created_at desc limit 200) x), '[]'::jsonb);
end;
$$;

revoke all on function public.admin_warteliste() from public, anon;
revoke all on function public.admin_einladen(uuid) from public, anon;
revoke all on function public.admin_codes(integer, integer, text) from public, anon;
revoke all on function public.admin_offene_codes() from public, anon;
grant execute on function public.admin_warteliste() to authenticated;
grant execute on function public.admin_einladen(uuid) to authenticated;
grant execute on function public.admin_codes(integer, integer, text) to authenticated;
grant execute on function public.admin_offene_codes() to authenticated;
