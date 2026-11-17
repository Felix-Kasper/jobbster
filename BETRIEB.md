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
Im Admin-Bereich der App unter „Codes“: Anzahl und Notiz eingeben, „Codes erzeugen“ (30 Tage, einmal einlösbar, bis 60 Tage nach Erzeugen einlösbar). Die Liste zeigt alle noch nicht eingelösten. Neue Codes beginnen mit `JB-`, alte `ZS-` bleiben gültig.

Sonderfälle im SQL-Editor:
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
Im Admin-Bereich unter „Warteliste“: bei einem Eintrag „Code erzeugen“, dann „Mail öffnen“. Das Mailprogramm öffnet eine fertige Einladung mit Code und Link, du sendest selbst. Wer schon ein Konto hat, ist markiert.

Im SQL-Editor:
```sql
select email, source, note, created_at from public.waitlist where invited_at is null order by created_at;
update public.waitlist set invited_at = now() where email = 'ADRESSE';
```

## Fehler
Admin-Bereich in der App zeigt die letzten 20. Protokolle der Funktionen: Supabase → Edge Functions → Logs. Worker: GitHub → Actions → Worker.

## Stellensuche
Jeden Morgen um 4:50 (Winterzeit) prüft der Ablauf „Quellen-Probe“ beide Schnittstellen. Liefert eine nichts, schlägt er fehl und GitHub schickt dir eine Mail.

Die tägliche Suche holt echte Anzeigen aus zwei öffentlichen Schnittstellen: Jobsuche der Arbeitsagentur (Deutschland) und EURES (Österreich, mit den Stellen des AMS). Die KI plant nur die Suchbegriffe und bewertet die Vorauswahl. Kosten: unter 1 Cent pro Lauf.

- **Findet ein Nutzer nichts?** GitHub → Actions → „Quellen-Probe“ → Run workflow, mit seinen Suchbegriffen und Orten. Der Lauf zeigt, was die Schnittstellen liefern und ob die Links gehen. Er kostet nichts.
- **Fällt eine Schnittstelle aus**, steht im Protokoll des Workers „Quelle: n von m Anfragen ohne Ergebnis“. Liefert keine Quelle mehr etwas für die Orte eines Nutzers, springt die Websuche als Reserve ein (rund 0,30 $ pro Lauf, findet wenig). Dann zuerst die Probe starten.
- **Orte außerhalb von Deutschland und Österreich** (zum Beispiel Zürich) laufen immer über die Websuche.
- Österreich ist dünner abgedeckt als Deutschland: EURES enthält nur Stellen, die dem AMS gemeldet sind. Deshalb sucht Jobbster dort zusätzlich im Anzeigentext und über die Auslandssuche der Arbeitsagentur. Schweiz: über EURES.
- Die Liste wird jeden Tag voll (Entscheidung 16.11.): erst was passt, dann ähnliche und anspruchsvollere Rollen, Leichteres nur als letzte Reserve. Die Begründung beginnt dann mit „Ähnliche Rolle:“, „Anspruchsvoller:“ oder „Leichter als das Profil:“.
- Suchbegriffe: Kernrollen aus dem Profil, dazu verwandte Rollen, die die KI aus Lebenslauf und perfektem Job ableitet. Beides steht im Protokoll des Workers.
- Fehlen nach den Quellen 2 oder mehr Treffer, sucht eine kleine Websuche (4 Suchen) auf karriere.at, StepStone, LinkedIn Jobs, Indeed, XING und Karriereseiten. LinkedIn-Beiträge und alles hinter einer Anmeldung sind nicht erreichbar.
- Abschalten oder einstellen: `STANDARD` in `worker/lib/agents.mjs` (`webErgaenzung`, `ergaenzungAb`, `ergaenzungSuchen`, `mindestMatch`).
