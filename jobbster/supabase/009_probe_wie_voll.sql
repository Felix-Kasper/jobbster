-- Probe wie Vollversion (13.11.2026). Entscheidung Felix: Die Probe läuft genau wie die Vollversion,
-- 7 Tage, so viele Bewerbungen wie man will, höchstens 12 am Tag. Vorher wird gefragt, wie viele pro Tag.
-- Noch NICHT eingespielt (Supabase-Verbindung war unterbrochen). Einspielen als Migration probe_wie_voll.
update public.app_config set value = '{"scout": {"anzahl": 2, "tage": 1}, "entwurf": {"anzahl": 12, "tage": 1}, "vorbereitung": {"anzahl": 2, "tage": 7}}'::jsonb where key = 'grenzen';
update public.app_config set value = '{"scout": {"anzahl": 2, "tage": 1}, "entwurf": {"anzahl": 12, "tage": 1}, "vorbereitung": {"anzahl": 2, "tage": 7}}'::jsonb where key = 'grenzen_probe';
