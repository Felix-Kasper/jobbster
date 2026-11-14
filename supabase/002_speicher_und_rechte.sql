-- Zusage · Speicher und Rechte (11.11.2026)

-- ---------------------------------------------------------------------------
-- Private Speicher: Lebensläufe und Verträge, je Nutzer ein eigener Ordner (<user_id>/...)
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('cvs', 'cvs', false, 5242880, array['application/pdf']),
  ('contracts', 'contracts', false, 10485760, array['application/pdf', 'image/jpeg', 'image/png'])
on conflict (id) do nothing;

create policy cvs_select_own on storage.objects for select to authenticated
  using (bucket_id = 'cvs' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy cvs_insert_own on storage.objects for insert to authenticated
  with check (bucket_id = 'cvs' and (storage.foldername(name))[1] = (select auth.uid())::text
    and exists (select 1 from public.members m where m.user_id = (select auth.uid()) and m.status = 'aktiv'));
create policy cvs_update_own on storage.objects for update to authenticated
  using (bucket_id = 'cvs' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'cvs' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy cvs_delete_own on storage.objects for delete to authenticated
  using (bucket_id = 'cvs' and (storage.foldername(name))[1] = (select auth.uid())::text);

create policy contracts_select_own on storage.objects for select to authenticated
  using (bucket_id = 'contracts' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy contracts_insert_own on storage.objects for insert to authenticated
  with check (bucket_id = 'contracts' and (storage.foldername(name))[1] = (select auth.uid())::text
    and exists (select 1 from public.members m where m.user_id = (select auth.uid()) and m.status = 'aktiv'));
create policy contracts_update_own on storage.objects for update to authenticated
  using (bucket_id = 'contracts' and (storage.foldername(name))[1] = (select auth.uid())::text)
  with check (bucket_id = 'contracts' and (storage.foldername(name))[1] = (select auth.uid())::text);
create policy contracts_delete_own on storage.objects for delete to authenticated
  using (bucket_id = 'contracts' and (storage.foldername(name))[1] = (select auth.uid())::text);

-- ---------------------------------------------------------------------------
-- Rechte: anon bekommt nichts, auch nicht auf künftige Objekte.
-- Angemeldete bekommen nur, was die Oberfläche braucht. Den Rest regelt RLS.
-- ---------------------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke all on functions from public, anon, authenticated;

grant select on public.members, public.consents, public.queue to authenticated;
grant select, insert, update on public.job_profile to authenticated;
grant select, update on public.job_leads to authenticated;
grant select, insert on public.feedback to authenticated;
grant execute on function public.request_run(text, uuid, text) to authenticated;

-- Funktionen, die in Policies, Triggern und Checks laufen
grant execute on function public.jl_company_key(text), public.jl_title_key(text), public.jl_same_company(text, text) to authenticated, service_role;
grant execute on function public.touch_updated_at(), public.jl_block_duplicates() to authenticated, service_role;
grant execute on function public.claim_invite(text), public.release_invite(text), public.request_run(text, uuid, text) to service_role;
