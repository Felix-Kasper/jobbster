-- Jobbster · 013: Zeitplan in der Datenbank statt in GitHub Actions
-- GitHub startete geplante Abläufe bis zu 9 Stunden zu spät (Suche „5:30“ lief am 22.11. um 13:47).
-- pg_cron ruft jetzt pünktlich die Funktion „takt“ auf. Der Worker in GitHub bleibt als Reserve.
--   jede Minute     wartende Aufträge an „takt“ geben (höchstens 3 gleichzeitig)
--   4:00 bis 4:25   offene Treffer prüfen, ob noch online (je 150, alle 5 Minuten)
--   4:30            Scout-Läufe für alle aktiven Nutzer einreihen
-- Zeiten in UTC: 3:xx UTC ist 4:xx in Wien (Winter) bzw. 5:xx (Sommer).

create extension if not exists pg_cron;

-- Takt-Schlüssel: zufällig, liegt nur im Vault. Die Funktion „takt“ fragt über takt_pruefen nach.
do $$
begin
  if not exists (select 1 from vault.secrets where name = 'takt_schluessel') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'takt_schluessel', 'Schlüssel für pg_cron → Funktion takt');
  end if;
end $$;

create or replace function public.takt_pruefen(p text) returns boolean
language sql stable security definer set search_path to '' as $$
  select coalesce((select decrypted_secret = p from vault.decrypted_secrets where name = 'takt_schluessel'), false);
$$;
revoke all on function public.takt_pruefen(text) from public, anon, authenticated;
grant execute on function public.takt_pruefen(text) to service_role;

create or replace function public.takt_ausloesen(p_aufgabe text) returns bigint
language plpgsql security definer set search_path to '' as $$
declare
  s text;
begin
  select decrypted_secret into s from vault.decrypted_secrets where name = 'takt_schluessel';
  return net.http_post(
    url := 'https://pekfnuywzouakdpehouc.supabase.co/functions/v1/takt',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-takt', s),
    body := jsonb_build_object('aufgabe', p_aufgabe),
    timeout_milliseconds := 10000
  );
end;
$$;
revoke all on function public.takt_ausloesen(text) from public, anon, authenticated;

-- Jede Minute: Hängengebliebenes freigeben, dann so viele Aufträge anstoßen, wie Platz ist
create or replace function public.takt_minute() returns integer
language plpgsql security definer set search_path to '' as $$
declare
  parallel integer := coalesce((select (value #>> '{}')::integer from public.app_config where key = 'takt_parallel'), 3);
  laeuft integer;
  wartet integer;
  n integer;
begin
  if coalesce((select value = 'true'::jsonb from public.app_config where key = 'pausiert'), false) then
    return 0;
  end if;
  -- Ein Auftrag dauert höchstens 150 s (Grenze der Funktion). Länger als 10 Minuten heißt: abgebrochen.
  update public.queue set status = 'fehler', error = 'Abgebrochen: Zeitüberschreitung', finished_at = now()
   where status = 'laeuft' and started_at < now() - interval '10 minutes';
  select count(*) into laeuft from public.queue where status = 'laeuft';
  select count(*) into wartet from public.queue where status = 'wartet';
  n := least(wartet, greatest(parallel - laeuft, 0));
  for i in 1..n loop
    perform public.takt_ausloesen('auftrag');
  end loop;
  return n;
end;
$$;
revoke all on function public.takt_minute() from public, anon, authenticated;

select cron.unschedule(jobname) from cron.job where jobname in ('jobbster-takt', 'jobbster-aufraeumen', 'jobbster-plan');
select cron.schedule('jobbster-takt', '* * * * *', 'select public.takt_minute()');
select cron.schedule('jobbster-aufraeumen', '0,5,10,15,20,25 3 * * *', $$select public.takt_ausloesen('aufraeumen')$$);
select cron.schedule('jobbster-plan', '30 3 * * *', $$select public.takt_ausloesen('plan')$$);

insert into public.app_config (key, value) values ('takt_parallel', '3'::jsonb) on conflict (key) do nothing;
