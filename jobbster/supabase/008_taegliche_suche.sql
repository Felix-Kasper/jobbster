-- Einstand · Tägliche Suche (13.11.2026). Eingespielt als Migration einstand_taegliche_suche.
-- Der Zeitplan sucht jeden Morgen so viele Treffer, wie im Profil unter „Bewerbungen pro Tag“ steht
-- (preferences.pro_tag, empfohlen 10, höchstens 15). Die Zahl liegt im JSON-Feld preferences, keine neue Spalte.
-- Von Hand: 2 Suchläufe am Tag (einer davon ist meist der automatische), 15 Entwürfe am Tag, 2 Vorbereitungen pro Woche.
-- Probe-Codes: 3 Suchläufe, 5 Entwürfe, 1 Vorbereitung in 7 Tagen.
update public.app_config set value = '{"scout": {"anzahl": 2, "tage": 1}, "entwurf": {"anzahl": 15, "tage": 1}, "vorbereitung": {"anzahl": 2, "tage": 7}}'::jsonb where key = 'grenzen';
update public.app_config set value = '{"scout": {"anzahl": 3, "tage": 7}, "entwurf": {"anzahl": 5, "tage": 7}, "vorbereitung": {"anzahl": 1, "tage": 7}}'::jsonb where key = 'grenzen_probe';
