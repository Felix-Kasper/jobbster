# Jobbster: Betrieb

Alles hier im SQL-Editor von Supabase (Projekt `zusage`). Kein Befehl löscht Nutzerdaten.

## Not-Aus und Kosten
```sql
update public.app_config set value = 'true'  where key = 'pausiert';   -- keine neuen Läufe
update public.app_config set value = 'false' where key = 'pausiert';
update public.app_config set value = '5' where key = 'tageslimit_usd'; -- Worker hört bei 5 $ am Tag auf
select date_trunc('day', created_at) tag, agent, count(*), round(sum(cost_usd), 2) usd from public.runs group by 1, 2 order by 1 desc, 2;
```

## Grenzen pro Nutzer
```sql
select value from public.app_config where key = 'grenzen';
update public.app_config set value = '{"scout": {"anzahl": 2, "tage": 1}, "entwurf": {"anzahl": 12, "tage": 1}, "vorbereitung": {"anzahl": 2, "tage": 7}}' where key = 'grenzen';
```

## Codes
```sql
select * from public.create_invites(5, 30, 'pass', 'Verkauf KW 49');        -- 30 Tage Zugang
select * from public.create_invites(1, 30, 'garantie', 'Garantie-Monat Lena'); -- Garantie-Monat
select * from public.create_probe_invites(10, 'Campus');                     -- Gratis-Probe
select code, plan, days, used_count, max_uses, note from public.invites order by created_at desc;
```

## Nutzer
```sql
select u.email, m.plan, m.sub_status, m.valid_until, m.cancel_at_period_end from public.members m join auth.users u on u.id = m.user_id order by m.joined_at desc;
update public.members set status = 'gesperrt' where user_id = (select id from auth.users where email = 'ADRESSE');
```
Passwort zurücksetzen: Supabase → Authentication → Users → Nutzer → „Send password recovery“ geht erst mit eigenem Mailversand. Bis dahin: Nutzer löschen lassen und neu einladen, oder in der Nutzerzeile ein neues Passwort setzen.

## Warteliste
```sql
select email, source, note, created_at from public.waitlist where invited_at is null order by created_at;
update public.waitlist set invited_at = now() where email = 'ADRESSE';
```

## Fehler
Admin-Bereich in der App zeigt die letzten 20. Protokolle der Funktionen: Supabase → Edge Functions → Logs. Worker: GitHub → Actions → Worker.
