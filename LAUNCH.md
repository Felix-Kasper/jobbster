# Jobbster: Start-Liste

Stand 13.11.2026, 12 Uhr. Was fertig ist und was Felix tun muss, genau in dieser Reihenfolge. Nichts davon geht ohne dich, weil es Konten, Geld oder Schlüssel braucht.

## 1. Fertig und getestet

| Teil | Test |
|---|---|
| Datenbank mit RLS, Grenzen, Not-Aus, Tageslimit, Codes, Probe, Abo-Felder, Admin-Übersicht | 59 + 15 + 4 Prüfungen direkt in Supabase (Nachfrist bei offener Zahlung, alte Abo-Ereignisse) |
| Anmeldung (`signup`), Warteliste, Konto löschen (beendet vorher das Abo) | echt über die Schnittstelle |
| Bezahlung (`billing`, `stripe-webhook`) | Signatur, Kodierung, Laufzeit: 10 Prüfungen. Gegen echtes Stripe erst mit Konto. |
| App: Registrierung, Fragebogen mit PDF-Upload, Treffer, Entwurf, PDF und Word, Funnel, Vorbereitung, Konto, Export, Löschen, Admin, Rechtliches | 34 Prüfungen im Browser (Handy und Laptop) gegen nachgebildetes Backend, 18 Unit-Tests, strenge Typen, ESLint ohne Befund, Build, keine bekannten Sicherheitslücken in den Paketen (npm audit) |
| Worker (tägliche Suche mit „Bewerbungen pro Tag“, Entwurf, Vorbereitung im Hintergrund) | 27 Prüfungen gegen Attrappe, dazu echte Läufe am 16.11. |
| Stellen-Quellen (Arbeitsagentur für Deutschland, EURES mit AMS-Stellen für Österreich) | 19 Tests ohne Netz, Typprüfung, Probe gegen die echten Schnittstellen (Actions → Quellen-Probe) |

**Mit der echten Claude API getestet (16.11.):** Suche und Entwurf. **Nicht getestet:** Gesprächsvorbereitung mit echter API und alles mit echtem Stripe.

## Zeitplan bis zum Start

| Bis | Was | Wer |
|---|---|---|
| Fr 13.11. | Schritt 1: Claude-Schlüssel eintragen | Felix |
| Sa 14.11. | Sofort-Entwurf einspielen, Messlauf mit echtem Lebenslauf: echte Treffer, echte Entwürfe, Kosten pro Nutzer | Claude |
| So 15.11. | Schritte 2 bis 5: Domain, GitHub, Hosting, Admin | Felix, ca. 1 Stunde |
| Mo 16.11. | Erste Beta-Nutzer mit Codes (gratis), Fehler aus echter Nutzung beheben | beide |
| Fr 20.11. | Schritt 6: Gewerbe angemeldet | Felix |
| Di 24.11. | Schritt 7: Stripe im Testmodus, Testkauf | Felix, dann Claude prüft |
| Fr 27.11. | Schritt 8: Rechtstexte geprüft, Impressum, Stripe live, Preis entschieden | Felix |
| Di 1.12. | Verkaufsstart, Preis auf die Landingpage | beide |

## 1. Claude API (10 min)
1. Auf platform.claude.com anmelden, unter Billing 20 $ Guthaben laden, **Auto-Reload aus**.
2. Unter API Keys einen Schlüssel erzeugen. Nicht in den Chat kopieren.
3. Supabase öffnen → Projekt `zusage` (heißt intern weiter so) → Edge Functions → Secrets → Add new secret: Name `ANTHROPIC_API_KEY`, Wert der Schlüssel.
4. Den Schlüssel zusätzlich in einer Passwort-Notiz ablegen, er kommt in Schritt 3 noch in GitHub.
5. Claude schreiben: „Schlüssel ist drin.“

## 1b. Zwei kleine Datenbank-Änderungen (2 min, nur falls Claude sie nicht selbst einspielen konnte)
Supabase → SQL Editor → New query, einfügen, Run:
```sql
-- Probe wie Vollversion, höchstens 12 am Tag
update public.app_config set value = '{"scout": {"anzahl": 2, "tage": 1}, "entwurf": {"anzahl": 12, "tage": 1}, "vorbereitung": {"anzahl": 2, "tage": 7}}'::jsonb where key in ('grenzen', 'grenzen_probe');
-- Protokoll für „Perfekter Job“
alter table public.runs drop constraint if exists runs_agent_check;
alter table public.runs add constraint runs_agent_check check (agent in ('scout', 'writer', 'coach', 'profil'));
```

## 2. Name und Domain (20 min)
1. Marke prüfen: „Jobbster“ und das ähnliche „Jobster“ (gab es früher als US-Jobportal) im österreichischen Markenregister (see.ip.gv.at) und bei der EU (euipo.europa.eu, eSearch plus) suchen, Klassen 9, 35 und 42. Gibt es dort einen Treffer für Software oder Personalvermittlung, Claude Bescheid geben.
2. Domain kaufen. Reihenfolge der Wünsche: `jobbster.com`, `jobbster.app`, `jobbster.at`, `jobbster.io`. Die Endungen `.app`, `.io` und `.com` gibt es direkt bei Cloudflare (Domain Registration). Eine `.at` gibt es bei einem österreichischen Anbieter, danach im Anbieter die Nameserver auf Cloudflare stellen.
3. Claude die gekaufte Domain schreiben.

## 3. GitHub (15 min)
1. github.com → New repository → Name `jobbster`, **Private**.
2. Zip entpacken. GitHub Desktop → File → Add local repository → den entpackten Ordner wählen → „create a repository“ → Publish repository, „Keep this code private“ angehakt.
3. Im Repo: Settings → Secrets and variables → Actions → New repository secret:
   - `ANTHROPIC_API_KEY`: der Schlüssel aus Schritt 1
   - `SUPABASE_SERVICE_KEY`: Supabase → Project Settings → API Keys → Secret key
4. Gleiche Seite, Reiter Variables → New repository variable: `SUPABASE_URL` = `https://pekfnuywzouakdpehouc.supabase.co`
5. Supabase → Account (Bild rechts oben) → Access Tokens → Generate new token, Name `github`. Als drittes Secret im Repo eintragen: `SUPABASE_ACCESS_TOKEN`.
6. Reiter Actions: „Prüfen“ muss grün sein. Dann „Funktionen einspielen“ → Run workflow: Das schaltet den Sofort-Entwurf und den Vorschlag aus „Perfekter Job“ frei. Dann „Worker“ → Run workflow. Ab jetzt sucht der Worker jeden Morgen um 5:30 Uhr.

## 4. Hosting (20 min)
1. Cloudflare → Workers & Pages → Create → Pages → Connect to Git → Repo `jobbster`.
2. Einstellungen: Root directory `app`, Build command `npm ci && npm run build`, Output `dist`.
3. Environment variables: `VITE_SUPPORT_EMAIL` (deine Support-Adresse), dazu die Impressum-Werte `VITE_IMPRESSUM_NAME`, `VITE_IMPRESSUM_ANSCHRIFT`, `VITE_IMPRESSUM_GEWERBE`, `VITE_IMPRESSUM_BEHOERDE`, `VITE_IMPRESSUM_KAMMER`. Was du noch nicht hast, leer lassen: Die Seite zeigt dann „fehlt noch“.
4. Custom domain: `app.<deine-domain>`.
5. Zweites Pages-Projekt für die Landingpage: gleiches Repo, Root directory `landing`, kein Build-Befehl, Output `.`. Custom domain: `<deine-domain>`.
6. Supabase → Authentication → URL Configuration → Site URL: `https://app.<deine-domain>`.

## 5. Admin und Beta-Codes (5 min)
1. In der App unter `app.<deine-domain>` registrieren. Code dafür: `select * from public.create_invites(1, 90, 'beta', 'Felix');` im Supabase SQL-Editor.
2. Dann im SQL-Editor:
```sql
insert into public.admins (user_id) select id from auth.users where email = 'DEINE-ADRESSE';
select * from public.create_invites(10, 30, 'beta', 'Beta November');   -- 10 Codes für 30 Tage
select * from public.create_probe_invites(10, 'MCI');                  -- 10 Probe-Codes (7 Tage)
```
3. Anfragen von der Landingpage: `select email, note, created_at from public.waitlist where invited_at is null order by created_at;`

## 6. Gewerbe (vor dem ersten Euro)
WKO-Gründerservice, Gewerbe „Dienstleistungen in der automatischen Datenverarbeitung und Informationstechnik“ (freies Gewerbe, online anmeldbar). Danach die Impressum-Werte in Schritt 4.3 nachtragen.

## 7. Stripe (30 min, braucht das Gewerbe)
1. Konto anlegen, zuerst im **Testmodus**.
2. Produkt „Jobbster“, Preis monatlich (vorläufig 19 €, endgültig nach dem Messlauf). Die Preis-ID (`price_…`) notieren.
3. Settings → Billing → Customer portal: Kündigen zum Periodenende erlauben, Zahlungsart ändern erlauben, Rechnungen anzeigen.
4. Developers → Webhooks → Add endpoint: `https://pekfnuywzouakdpehouc.supabase.co/functions/v1/stripe-webhook`. Ereignisse: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `customer.subscription.paused`, `customer.subscription.resumed`, `invoice.paid`, `invoice.payment_failed`. Signing secret (`whsec_…`) notieren.
5. Supabase → Edge Functions → Secrets: `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET`, `APP_URL` = `https://app.<deine-domain>`.
6. Claude Bescheid geben. Testkauf mit Karte 4242 4242 4242 4242, kündigen, Konto löschen. Erst dann Livemodus und Live-Werte eintragen.
7. Registrierung ohne Code öffnen: `update public.app_config set value = 'true' where key = 'offene_registrierung';`

## 8. Recht (vor dem ersten zahlenden Nutzer)
Datenschutz und Bedingungen in `app/src/pages/Legal.tsx` prüfen lassen (Entwürfe von Claude, kein Rechtsrat). Auftragsverarbeitung mit Supabase und Anthropic abschließen (beide bieten das im Dashboard an).

Mit prüfen lassen: Die Stellen kommen aus zwei öffentlichen Schnittstellen ohne eigenen Vertrag (Jobsuche der Bundesagentur für Arbeit, EURES-Portal der EU). Jobbster zeigt Titel, Firma, eine eigene Kurzfassung und den Link zur Originalanzeige. Ob das für ein bezahltes Produkt so in Ordnung ist oder eine Vereinbarung braucht, gehört in die Rechtsprüfung.

## Kosten im Blick
- Tageslimit für alle zusammen: `tageslimit_usd` (jetzt 3 $). Ist es erreicht, warten offene Läufe bis zum nächsten Tag. Nach dem Messlauf passend zur Nutzerzahl erhöhen (Befehle in `BETRIEB.md`).
- Gemessen am 16.11. (Test-Konto, Controlling in Innsbruck und München):

| Was | Kosten | Dauer |
|---|---|---|
| Tägliche Suche, 8 bis 10 neue Treffer aus rund 150 echten Anzeigen | 0,006 $ | 40 s |
| Ein Entwurf (Recherche zur Firma und Anschreiben) | 0,034 bis 0,047 $ | 20 s |

- Pro Nutzer und Monat: Suche rund 0,20 $. Entwürfe je nach Fleiß: 5 am Tag rund 6 $, das Maximum von 12 am Tag rund 15 $. Eine voll ausgenutzte Probewoche kostet bis zu 3,50 $.
- Vorher (Websuche, mit Nachdenken): Suche 0,23 bis 0,44 $ für 1 bis 2 Treffer, Entwurf 0,07 bis 0,09 $.

## Bewusst noch nicht drin
- **Versand aus dem Postfach:** Entscheidung 12.11.: Entwurf, du sendest. Die App öffnet Mail oder Portal mit fertigem Text.
- **Google-Login:** braucht ein Google-Cloud-Konto. Einbau ca. 1 Stunde, sobald das Konto da ist.
- **Passwort vergessen per Mail:** braucht eigenen Mailversand (SMTP) mit der Domain. Bis dahin setzt der Admin das Passwort in Supabase zurück.
- **Lebenslauf neu erstellen** (nicht nur hochladen): nächster Ausbau.
- **Backups zum Wiederherstellen:** Supabase Pro (ca. 25 $ pro Monat) ab dem ersten zahlenden Nutzer.
