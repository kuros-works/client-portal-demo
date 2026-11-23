-- =========================================================
-- 0010_rollback：migration 0010（Storage のお客様向けポリシーに project_files の行の条件を足す）を元に戻す
-- 「project-files: client select own」を 0005 と同じ定義に作り直す。0009 の後と同じ形にする
--
-- ■ 注意：戻すと、project_files の行が無い実体も、パスの先頭フォルダが自社の案件で支払いの条件を
--   満たせば、お客様から読めるようになる（0010 を当てる前と同じ）。
--   戻す前に 0010_verify.sql の [DETAIL] D2 で、行の無い実体が残っていないか見る
--
-- ■ このファイルがしないこと
--   - 管理者のポリシー（project-files: admin all）には触らない（0010 も触っていない）
--   - Storage の実体・project_files の行には触らない
--   - supabase_migrations.schema_migrations（CLI の履歴）には触らない。
--     0010 を CLI（supabase migration up / db push など）で当てた場合は、
--     `pnpm supabase migration repair 0010 --status reverted` で直す
--
-- ■ 実行した後に
--   - 0010_verify.sql の [PRE] を流して、0009 の後の状態に戻ったことを確認する
--     （ok が false の行が無く、件数と指紋が 0010 を当てる前と同じなら合格）
-- =========================================================

begin;


-- ---------------------------------------------------------
-- 0. 先に止める確認：ここで例外になれば、何も変わらずに全体が取り消される
--    client select own が無い、または 0010 の形（project_files の storage_path を見る）でなければ、
--    0010 が当たっていないので何もせず止める
-- ---------------------------------------------------------
do $$
declare
  q text;
begin
  select pol.qual into q
  from pg_policies pol
  where pol.schemaname = 'storage'
    and pol.tablename = 'objects'
    and pol.policyname = 'project-files: client select own';

  if not found then
    raise exception 'rollback stopped: policy "project-files: client select own" on storage.objects does not exist';
  end if;

  if q is null or strpos(q, 'project_files') = 0 or strpos(q, 'storage_path') = 0 then
    raise exception 'rollback stopped: migration 0010 is not applied (client select own does not check project_files.storage_path)';
  end if;
end
$$;


-- ---------------------------------------------------------
-- 1. client select own を 0005 と同じ定義に戻す
--    name は 0002 と同じく storage.objects.name と明示する
-- ---------------------------------------------------------
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
        and public.is_org_member(p.organization_id)
        and (p.amount is null or p.payment_status = 'paid')
    )
  );


commit;
