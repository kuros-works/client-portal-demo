-- =========================================================
-- 0001_init：テーブル3つ・RLS・Storage の初期設定
-- =========================================================


-- ---------------------------------------------------------
-- profiles：ユーザー情報と役割（auth.users と 1 対 1）
-- auth.users の行が消えたら、こちらも連動して消える
-- ---------------------------------------------------------
create table public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  email      text not null,
  name       text,
  role       text not null default 'client' check (role in ('admin', 'client')),
  created_at timestamptz not null default now()
);


-- ---------------------------------------------------------
-- 新しいユーザーが作られたら profiles 行を自動で作るトリガー
-- role は常に client（管理者は手動で昇格させる）
-- ---------------------------------------------------------
create function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, name, role)
  values (
    new.id,
    new.email,
    new.raw_user_meta_data ->> 'name',
    'client'
  );
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- ---------------------------------------------------------
-- projects：案件
-- お客様（client_id）が紐づいている間は、そのプロフィールを削除できない
-- ---------------------------------------------------------
create table public.projects (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  status     text not null default 'in_progress'
               check (status in ('in_progress', 'in_review', 'delivered')),
  client_id  uuid not null references public.profiles (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index projects_client_id_idx on public.projects (client_id);


-- ---------------------------------------------------------
-- projects.updated_at を更新時に自動で now() にするトリガー
-- ---------------------------------------------------------
create function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger projects_set_updated_at
  before update on public.projects
  for each row execute function public.set_updated_at();


-- ---------------------------------------------------------
-- project_files：案件のファイル情報（実体は Storage）
-- 案件を消したら行も連動して消える（Storage の実体は消えない点に注意）
-- ---------------------------------------------------------
create table public.project_files (
  id           uuid primary key default gen_random_uuid(),
  project_id   uuid not null references public.projects (id) on delete cascade,
  file_name    text not null,
  storage_path text not null unique,
  size         bigint not null check (size >= 0),
  uploaded_at  timestamptz not null default now()
);

create index project_files_project_id_idx on public.project_files (project_id);


-- ---------------------------------------------------------
-- is_admin()：ログイン中のユーザーが管理者かどうか
-- security definer で RLS を通さずに profiles を読む（ポリシーの無限ループ防止）
-- ---------------------------------------------------------
create function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.profiles
    where id = (select auth.uid())
      and role = 'admin'
  );
$$;


-- ---------------------------------------------------------
-- 関数の実行権限
-- is_admin はポリシー内で使うので authenticated だけ実行可
-- トリガー用の関数は直接呼べないようにする
-- ---------------------------------------------------------
revoke execute on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

revoke execute on function public.handle_new_user() from public, anon, authenticated;
revoke execute on function public.set_updated_at() from public, anon, authenticated;


-- ---------------------------------------------------------
-- RLS を有効化
-- ---------------------------------------------------------
alter table public.profiles      enable row level security;
alter table public.projects      enable row level security;
alter table public.project_files enable row level security;


-- ---------------------------------------------------------
-- profiles のポリシー
-- 管理者：全操作 / お客様：自分の行を見るだけ（role は変更不可）
-- ---------------------------------------------------------
create policy "profiles: admin all"
  on public.profiles
  for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy "profiles: client select own"
  on public.profiles
  for select
  to authenticated
  using (id = (select auth.uid()));


-- ---------------------------------------------------------
-- projects のポリシー
-- 管理者：全操作 / お客様：自分が client_id の案件を見るだけ
-- ---------------------------------------------------------
create policy "projects: admin all"
  on public.projects
  for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy "projects: client select own"
  on public.projects
  for select
  to authenticated
  using (client_id = (select auth.uid()));


-- ---------------------------------------------------------
-- project_files のポリシー
-- 管理者：全操作 / お客様：自分の案件のファイル情報を見るだけ
-- ---------------------------------------------------------
create policy "project_files: admin all"
  on public.project_files
  for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

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
    )
  );


-- ---------------------------------------------------------
-- テーブルの権限（自動公開しない設定を前提に、明示的に付与）
-- 行の制限は RLS が行う。anon には何も与えない
-- service_role はサーバー側の処理（招待など）用。RLS は通らない
-- ---------------------------------------------------------
grant usage on schema public to authenticated, service_role;

grant select, insert, update, delete on public.profiles      to authenticated, service_role;
grant select, insert, update, delete on public.projects      to authenticated, service_role;
grant select, insert, update, delete on public.project_files to authenticated, service_role;

revoke all on public.profiles      from anon;
revoke all on public.projects      from anon;
revoke all on public.project_files from anon;


-- ---------------------------------------------------------
-- Storage：非公開バケット project-files
-- パスは「案件ID/ファイルID」（ファイルID は project_files.id と同じ）、1ファイル 10MB まで
-- ---------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('project-files', 'project-files', false, 10485760)
on conflict (id) do nothing;


-- ---------------------------------------------------------
-- storage.objects のポリシー
-- 管理者：project-files バケット内の全操作
-- お客様：パスの先頭フォルダが自分の案件ID のファイルを読むだけ
-- ※ 「client select own」は name が projects.name に解決されてしまうため、
--    0002_fix_storage_client_policy.sql で storage.objects.name に直している
-- ---------------------------------------------------------
create policy "project-files: admin all"
  on storage.objects
  for all
  to authenticated
  using (bucket_id = 'project-files' and public.is_admin())
  with check (bucket_id = 'project-files' and public.is_admin());

create policy "project-files: client select own"
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'project-files'
    and exists (
      select 1
      from public.projects p
      where p.id::text = (storage.foldername(name))[1]
        and p.client_id = (select auth.uid())
    )
  );
