-- Zusage · Laufzeit und Codes (11.11.2026). Eingespielt als Migration zusage_laufzeit_und_codes.
-- Ein Code ist zugleich Einladung, Kaufbeleg und Gutschein: Er gibt eine Anzahl Tage Zugang.
-- Die Laufzeit beginnt erst beim Einlösen. So kann man vor Weihnachten kaufen und im Jänner starten.
-- Die Funktionen claim_invite_v2, redeem_code und request_run stehen in ihrer aktuellen Fassung in 005.

alter table public.invites
  add column days integer not null default 30 check (days between 1 and 366),
  add column plan text not null default 'beta' check (plan in ('beta', 'pass', 'gutschein', 'garantie'));

alter table public.members
  add column plan text not null default 'beta' check (plan in ('beta', 'pass', 'gutschein', 'garantie')),
  add column valid_until timestamptz; -- leer = unbegrenzt (nur eigene Konten)

-- Codes erzeugen (nur Service-Rolle), zum Beispiel im SQL-Editor:
--   select * from public.create_invites(10, 30, 'pass', 'Verkauf KW 49');
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
    c := 'ZS-' || substr(h, 1, 4) || '-' || substr(h, 5, 4) || '-' || substr(h, 33, 4) || '-' || substr(h, 37, 4);
    insert into public.invites (code, note, days, plan, max_uses, expires_at) values (c, p_note, p_days, p_plan, p_max_uses, p_expires);
    return next c;
  end loop;
end;
$$;
revoke all on function public.create_invites(integer, integer, text, text, integer, timestamptz) from public, anon, authenticated;
grant execute on function public.create_invites(integer, integer, text, text, integer, timestamptz) to service_role;
