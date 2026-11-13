# Jobbster

Jeden Morgen passende Stellen, fertige Entwürfe und ein Spickzettel fürs Gespräch. Der Mensch sendet selbst.

Stand 11.11.2026, Sprint Tag 1. Getrennt von JARVIS.

| Ordner | Inhalt |
|---|---|
| `supabase/` | Schema mit RLS, Speicher, Rechte (`001`, `002`) und die Edge Function `signup` (Anmeldung mit Einladungscode) |
| `worker/` | Arbeitet die Warteschlange ab: Scout, Entwurf, Gesprächsvorbereitung. Läuft in GitHub Actions. |
| `worker/lib/prompts.mjs` | Prompt-Vorlagen. Alles Persönliche kommt aus dem Profil des Nutzers. |
| `spike/` | Messlauf gegen die echte API mit erfundenem Profil |
| `.github/workflows/worker.yml` | Zeitplan und Anstoß für den Worker |

## Befehle

```
node worker/test/worker.test.mjs     Test gegen eine Attrappe (API und Datenbank), nur erfundene Daten
node spike/scout-spike.mjs           Messlauf, braucht spike/.env mit ANTHROPIC_API_KEY
node worker/worker.mjs               offene Aufträge abarbeiten
node worker/worker.mjs --plan        vorher fällige Scout-Läufe einreihen
```

## Schlüssel

Nie im Repo, nie im Chat. GitHub: Secrets `ANTHROPIC_API_KEY`, `SUPABASE_SERVICE_KEY`, Variable `SUPABASE_URL`.

## Kostenbremsen

1. Guthaben im API-Konto ohne automatisches Nachladen (hartes Limit)
2. `app_config.tageslimit_usd`: Der Worker hört auf, wenn der Tag das Limit erreicht
3. `request_run()` in der Datenbank: Grenzen pro Nutzer (Suche 2 pro Tag inklusive der automatischen, Entwurf 12 pro Tag, Vorbereitung 2 pro Woche, in der Probe genauso). Der Zeitplan sucht jeden Morgen so viele Treffer, wie im Profil unter „Bewerbungen pro Tag“ steht (1 bis 12, empfohlen 10).
4. `app_config.pausiert`: Not-Aus
5. Zugang nur mit Einladungscode
