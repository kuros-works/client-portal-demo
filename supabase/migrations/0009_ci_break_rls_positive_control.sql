-- DO NOT MERGE: CI の陽性対照用。わざと RLS を壊している

create policy "ci positive control select all"
  on public.projects
  for select
  to authenticated
  using (true);
