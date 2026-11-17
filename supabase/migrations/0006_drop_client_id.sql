-- =========================================================
-- 0006_drop_client_id：projects.client_id を消し、service_role の余分な権限を外す
--
-- ・0005 で案件の持ち主は organization_id（会社）に切り替えた。client_id は
--   「作成時のオーナー」を入れておくだけの列で、コードも RLS も使っていない。
--   アプリのコード（PR #10）は client_id を書くのも読むのもやめたので、列ごと消す
-- ・service_role には、Supabase の初期設定（default privileges）で全部の権限
--   （arwdDxtm）が付いている。アプリが使わない TRUNCATE・REFERENCES・TRIGGER・MAINTAIN を外す
--   stripe_events は Webhook が select と insert しか使わないので、UPDATE・DELETE も外して
--   「書き足すだけの台帳」にする
-- ・MAINTAIN は Postgres 17 からの権限。16 以下ではこのファイルはエラーで止まる
-- ・当てる前と後に supabase/sql/0006_verify.sql の [PRE] / [POST] を流す
-- =========================================================

begin;


-- ---------------------------------------------------------
-- 1. authenticated の projects の insert 列から client_id を外す
--    （列を消せば一緒に消えるが、0004・0005 で付けた列ごとの権限を外すことを明示する）
-- ---------------------------------------------------------
revoke insert (client_id) on public.projects from authenticated;


-- ---------------------------------------------------------
-- 2. projects.client_id を消す
--    外部キー（projects_client_id_fkey：profiles への on delete restrict）と
--    インデックス（projects_client_id_idx）も一緒に消える
--    cascade は付けない。ほかにこの列を使うもの（ポリシー・ビューなど）があれば
--    ここでエラーになり、全体が取り消される
--    行は更新しないので、updated_at は変わらない
-- ---------------------------------------------------------
alter table public.projects
  drop column client_id;


-- ---------------------------------------------------------
-- 3. service_role の表の権限を、アプリが使う分だけにする
--    （service_role は RLS を通らないので、表の権限がそのまま「できること」になる）
--    - 6 つの表すべて：TRUNCATE・REFERENCES・TRIGGER・MAINTAIN を外す
--      select / insert / update / delete はそのまま（stripe_events を除く）
--    - stripe_events：さらに UPDATE・DELETE を外し、select と insert だけにする
--    関数・シーケンスの初期設定（default privileges）は今回は変えない
-- ---------------------------------------------------------
revoke truncate, references, trigger, maintain
  on public.profiles,
     public.projects,
     public.project_files,
     public.stripe_events,
     public.organizations,
     public.organization_members
  from service_role;

revoke update, delete on public.stripe_events from service_role;


commit;
