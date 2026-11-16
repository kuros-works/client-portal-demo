-- =========================================================
-- 0005_rollback：migration 0005（organizations）を元に戻す
-- 0005 で変えたことを、逆の順番で戻す。0004 の後と同じ状態にする
--
-- ■ 元に戻せないもの（実行すると消えて、戻ってこない）
--   1. organizations と organization_members の中身は全部消える
--      - 0005 の後に管理者が入力した会社名
--      - スタッフの所属（誰がどの会社のスタッフか）
--      - オーナーとスタッフの関係
--   2. projects.organization_id の列と値は消える
--      どの会社の案件かは、client_id（＝作成時のオーナー）からしか分からなくなる
--   3. スタッフとして招待した人は、ログインとプロフィール（role = client）が残るが、
--      どの案件の client_id にもなっていないので何も見えなくなる。必要なら手で消す
--      （auth.users の削除は本番の操作なので、別に確認を取ってから行う）
--
-- ■ 実行する前に
--   - 本番のコードを 0005 より前（main）に戻すのと同時に行う。
--     0005 用のコードは organizations を読むので、DB だけ戻すと動かなくなる
--   - 0005_verify.sql の [POST] の「既存データの移しかえ」の行と [DETAIL] D1-post を流しておく。
--     client_id とその会社のオーナーが違う案件があると、戻した後はオーナーではなく
--     client_id の人だけがその案件を見られるようになる
--   - client_id が null の案件があると、下の確認で止まり、何も変わらずに終わる
--     （client_id の not null に戻せないため。先に client_id を手で埋める）
--
-- ■ このファイルがしないこと
--   - supabase_migrations.schema_migrations（CLI の履歴）には触らない。
--     0005 を CLI（supabase db push など）で当てた場合は、履歴の 0005 の行を手で直す
--   - Storage のファイルの実体には触らない（0005 は Storage の中身を変えていない）
--
-- ■ 実行した後に
--   - 0005_verify.sql の [PRE] を流して、0004 の状態に戻ったことを確認する
--     （ok が false の行が無く、件数と指紋が 0005 を当てる前と同じなら合格。
--      0005 の後に案件やお客様が増えていれば、その分だけ件数と指紋は変わる）
-- =========================================================

begin;


-- ---------------------------------------------------------
-- 0. 先に止める確認：ここで例外になれば、何も変わらずに全体が取り消される
-- ---------------------------------------------------------
do $$
declare
  n bigint;
begin
  -- 0005 が当たっていなければ、戻すものが無い
  if to_regclass('public.organizations') is null
     or to_regclass('public.organization_members') is null then
    raise exception 'rollback stopped: migration 0005 is not applied (organizations tables are missing)';
  end if;

  -- client_id が null の案件があると、client_id を not null に戻せない
  select count(*) into n from public.projects where client_id is null;
  if n > 0 then
    raise exception 'rollback stopped: % project(s) have client_id null; fill client_id first', n;
  end if;
end
$$;


-- ---------------------------------------------------------
-- 1. 権限：projects の insert 列から organization_id を外す（0004 の列に戻す）
--    新しい 2 つの表の権限は、8 で表を消すと一緒に消える
-- ---------------------------------------------------------
revoke insert (organization_id) on public.projects from authenticated;


-- ---------------------------------------------------------
-- 2. storage.objects のお客様向けポリシーを 0003 の形に戻す
--    （関数 is_org_member を消す前に、それを使うポリシーを無くしておく）
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
        and p.client_id = (select auth.uid())
        and (p.amount is null or p.payment_status = 'paid')
    )
  );


-- ---------------------------------------------------------
-- 3. project_files のお客様向けポリシーを 0003 の形に戻す
-- ---------------------------------------------------------
drop policy "project_files: client select own" on public.project_files;

create policy "project_files: client select own"
  on public.project_files
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.projects p
      where p.id = project_files.project_id
        and p.client_id = (select auth.uid())
        and (p.amount is null or p.payment_status = 'paid')
    )
  );


-- ---------------------------------------------------------
-- 4. projects のお客様向けポリシーを 0001 の形に戻す
-- ---------------------------------------------------------
drop policy "projects: client select own" on public.projects;

create policy "projects: client select own"
  on public.projects
  for select
  to authenticated
  using (client_id = (select auth.uid()));


-- ---------------------------------------------------------
-- 5. 新しい 2 つの表のポリシーを消し、RLS を無効にする
--    （8 で表を消せば一緒に消えるが、0005 の逆の順番が分かるように書く）
-- ---------------------------------------------------------
drop policy "organization_members: client select same org" on public.organization_members;
drop policy "organization_members: admin all"              on public.organization_members;
drop policy "organizations: client select own"             on public.organizations;
drop policy "organizations: admin all"                     on public.organizations;

alter table public.organization_members disable row level security;
alter table public.organizations        disable row level security;


-- ---------------------------------------------------------
-- 6. 関数を消す（まだ使っているものがあればここでエラーになり、全体が取り消される）
-- ---------------------------------------------------------
drop function public.is_org_owner(uuid);
drop function public.is_org_member(uuid);


-- ---------------------------------------------------------
-- 7. projects を 0004 の形に戻す
--    client_id を not null に戻してから、organization_id を消す
--    （列を消すと、外部キーと列の権限も一緒に消える。行は更新しないので updated_at は変わらない）
-- ---------------------------------------------------------
alter table public.projects
  alter column client_id set not null;

drop index public.projects_organization_id_idx;

alter table public.projects
  drop column organization_id;


-- ---------------------------------------------------------
-- 8. 新しい 2 つの表を消す（所属 → 会社の順。中身も消える＝元に戻せない）
--    部分ユニークインデックス・制約・権限も一緒に消える
-- ---------------------------------------------------------
drop table public.organization_members;
drop table public.organizations;


commit;
