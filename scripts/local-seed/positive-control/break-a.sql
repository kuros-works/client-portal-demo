-- =========================================================
-- break-a.sql：RAG の陽性対照 A。project_chunks の「client select own」を using (true) にする
-- ・ローカル専用。本番では絶対に流さない（seed のユーザー admin@seed.test がいなければ止まる）
-- ・お客様に全社・全部の chunk が見える状態にして、verify-rls が FAIL を出せるかを確かめる
--   （予想：32 FAIL / 352 PASS）
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
  using (true);
commit;
