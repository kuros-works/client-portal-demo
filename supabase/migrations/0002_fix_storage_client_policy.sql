begin;

drop policy "project-files: client select own" on storage.objects;

create policy "project-files: client select own"
on storage.objects
for select
to authenticated
using (
  bucket_id = 'project-files'
  and exists (
    select 1
    from public.projects p
    where p.id::text = (storage.foldername(storage.objects.name))[1]
      and p.client_id = (select auth.uid())
  )
);

commit;
