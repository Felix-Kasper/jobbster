-- Profil-Vorschlag (13.11.2026): „Beschreib deinen perfekten Job“ füllt die Suchfelder vor.
-- Protokolliert wird als agent = 'profil'. Noch NICHT eingespielt (Supabase-Verbindung von Claude unterbrochen).
alter table public.runs drop constraint if exists runs_agent_check;
alter table public.runs add constraint runs_agent_check check (agent in ('scout', 'writer', 'coach', 'profil'));
