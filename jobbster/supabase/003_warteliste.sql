-- Zusage · Warteliste der Landingpage (11.11.2026)
-- Nur die Service-Rolle liest und schreibt (Edge Function "waitlist"). Kein Zugriff für anon oder Angemeldete.
create table public.waitlist (
  id uuid primary key default gen_random_uuid(),
  email text not null check (length(email) between 5 and 320),
  source text check (length(source) <= 60),
  note text check (length(note) <= 500),
  consent_version text not null check (length(consent_version) <= 40),
  invited_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index waitlist_email on public.waitlist (lower(email));
create index waitlist_zeit on public.waitlist (created_at);
alter table public.waitlist enable row level security;
revoke all on public.waitlist from anon, authenticated;

-- Eintragen mit Mengenbremse: höchstens 200 neue Einträge pro Stunde, doppelte Adressen werden still ignoriert
create or replace function public.join_waitlist(p_email text, p_source text, p_note text, p_version text) returns text
language plpgsql set search_path to '' as $$
begin
  if (select count(*) from public.waitlist where created_at > now() - interval '1 hour') >= 200 then
    return 'voll';
  end if;
  insert into public.waitlist (email, source, note, consent_version)
  values (lower(trim(p_email)), nullif(left(trim(coalesce(p_source, '')), 60), ''), nullif(left(trim(coalesce(p_note, '')), 500), ''), p_version)
  on conflict (lower(email)) do nothing;
  return 'ok';
end;
$$;
revoke all on function public.join_waitlist(text, text, text, text) from public, anon, authenticated;
grant execute on function public.join_waitlist(text, text, text, text) to service_role;
