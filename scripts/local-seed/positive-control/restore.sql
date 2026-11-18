-- =========================================================
-- restore.sql：RAG の陽性対照の後に、project_chunks の「client select own」を元に戻す
-- ・ローカル専用。本番では流さない（seed のユーザー admin@seed.test がいなければ止まる）
-- ・式は supabase/migrations/0007_rag.sql の元のポリシーと同じ
-- ・戻した後は qual.sql の結果が壊す前と文字まで同じこと、verify-rls が 384 PASS / FAIL 0 に戻ることを確かめる
-- =========================================================
begin;
do $$
begin
  if not exists (select 1 from auth.users where email = 'admin@seed.test') then
    raise exception 'stopped: this is not the local seed database';
  end if;
end
$$;
drop policy "project_chunks: client select own" on public.project_chunks;
create policy "project_chunks: client select own"
  on public.project_chunks
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.projects p
      where p.id = project_chunks.project_id
        and public.is_org_member(p.organization_id)
        and (
          project_chunks.source_type = 'note'
          or p.amount is null
          or p.payment_status = 'paid'
        )
    )
  );
commit;
