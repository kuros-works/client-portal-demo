-- =========================================================
-- break-b.sql：RAG の陽性対照 B。project_chunks の「client select own」から支払いの条件を外す
-- ・ローカル専用。本番では絶対に流さない（seed のユーザー admin@seed.test がいなければ止まる）
-- ・会社の条件（is_org_member）だけ残し、未払い案件のファイル由来の chunk が見える状態にして、
--   支払いの条件を見張るテストが FAIL を出せるかを確かめる
--   （予想：25 FAIL / 359 PASS。#4 は類似度 0 の同点の並び順しだいで 23〜25）
-- ・終わったら必ず restore.sql で戻す
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
    )
  );
commit;
