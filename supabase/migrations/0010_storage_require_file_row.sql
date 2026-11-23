-- =========================================================
-- 0010_storage_require_file_row：Storage のお客様向けポリシーに「project_files に行がある」条件を足す
--
-- ・今まで（0005）は、パスの先頭フォルダが自社の案件 ID で、支払いの条件を満たせば読めた。
--   project_files の行は見ていなかったので、管理者がファイルの行を消した後に Storage の削除だけ
--   失敗すると（deleteProjectFile の storage_failed）、実体が残り、パス（storage_path）を知っている
--   同じ会社のお客様は Storage から直接読めた
-- ・0010 からは、storage.objects.name と同じ storage_path の行が project_files にあり、
--   その行の案件が「パスの先頭フォルダの案件」と同じときだけ読める。行の無い実体は読めない
-- ・会社の条件（is_org_member）と支払いの条件（amount が null または paid）は 0005 と同じ
-- ・name は storage.objects.name と明示する。サブクエリの中で name とだけ書くと、
--   projects.name（案件名）に解決されてしまい、エラーにならずに誰も読めなくなる（0002 で直した理由）
-- ・管理者のポリシー（project-files: admin all）は変えない。管理者は行の無い実体も読める・消せる
--   （残った実体を手で消すため）
-- ・当てる前と後に supabase/sql/0010_verify.sql の [PRE] / [POST] を流す。戻すときは 0010_rollback.sql
-- =========================================================

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
      from public.project_files f
      join public.projects p on p.id = f.project_id
      where f.storage_path = storage.objects.name
        and p.id::text = (storage.foldername(storage.objects.name))[1]
        and public.is_org_member(p.organization_id)
        and (p.amount is null or p.payment_status = 'paid')
    )
  );

commit;
