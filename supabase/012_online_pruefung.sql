-- Jobbster · 012: Der Worker prüft jeden Morgen, ob offene Treffer (neu, entwurf) noch online sind.
-- Die Spalte merkt sich die letzte Prüfung, damit jeder Treffer höchstens einmal am Tag abgefragt wird.
alter table public.job_leads add column if not exists online_geprueft_at timestamptz;
create index if not exists job_leads_online_pruefung on public.job_leads (online_geprueft_at nulls first) where status in ('neu', 'entwurf');
comment on column public.job_leads.online_geprueft_at is 'Letzte Prüfung durch den Worker, ob die Anzeige noch online ist';
