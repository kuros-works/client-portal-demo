-- =========================================================
-- 0005_organizations：会社単位の役割（オーナー / スタッフ）
-- projects を「人（client_id）」から「会社（organization_id）」に切り替える準備
-- client_id は残し、not null だけ外す（0006 で消す）
-- =========================================================

begin;


-- ---------------------------------------------------------
-- organizations：会社
-- ---------------------------------------------------------
create table public.organizations (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  created_at timestamptz not null default now()
);


-- ---------------------------------------------------------
-- organization_members：会社とユーザーの所属（役割は owner / staff）
-- 会社を消すと所属も消える。プロフィールを消すと、その人の所属も消える
-- 1 人が入れる会社は 1 社だけ（user_id に一意）
-- オーナーは 1 社に 1 人（部分ユニークインデックス）
-- ---------------------------------------------------------
create table public.organization_members (
  organization_id uuid not null references public.organizations (id) on delete cascade,
  user_id         uuid not null references public.profiles (id) on delete cascade,
  role            text not null check (role in ('owner', 'staff')),
  created_at      timestamptz not null default now(),
  constraint organization_members_pkey primary key (organization_id, user_id),
  constraint organization_members_user_id_key unique (user_id)
);

create unique index organization_members_one_owner_idx
  on public.organization_members (organization_id)
  where role = 'owner';


-- ---------------------------------------------------------
-- projects に organization_id を追加（埋めたあとで not null にする）
-- 会社が案件を持っている間は、その会社を削除できない
-- ---------------------------------------------------------
alter table public.projects
  add column organization_id uuid references public.organizations (id) on delete restrict;

create index projects_organization_id_idx on public.projects (organization_id);


-- ---------------------------------------------------------
-- 今ある案件を埋める
-- role = 'client' の人全員（案件の有無を問わない）に 1 社ずつ会社を作り（名前は email）、
-- その人をオーナーにする。案件の organization_id は、client_id の人の会社で埋める
-- email は一意とは限らないので、先に「お客様 → 新しい会社ID」の対応表を作ってから使う
-- client_id が client 以外（admin など）の案件があると、埋まらずに下の not null で失敗する
-- ---------------------------------------------------------
create temporary table organization_backfill on commit drop as
select
  pr.id              as user_id,
  pr.email           as email,
  gen_random_uuid()  as organization_id
from public.profiles pr
where pr.role = 'client';

insert into public.organizations (id, name)
select b.organization_id, b.email
from organization_backfill b;

insert into public.organization_members (organization_id, user_id, role)
select b.organization_id, b.user_id, 'owner'
from organization_backfill b;

-- 埋めるだけで updated_at を変えないよう、この更新の間だけ updated_at のトリガーを止める
-- （同じトランザクション内で戻すので、失敗しても止まったままにはならない）
alter table public.projects disable trigger projects_set_updated_at;

update public.projects p
set organization_id = b.organization_id
from organization_backfill b
where p.client_id = b.user_id;

alter table public.projects enable trigger projects_set_updated_at;

-- 1 件でも埋まっていなければ、ここで失敗して全体が取り消される
alter table public.projects
  alter column organization_id set not null,
  alter column client_id drop not null;


-- ---------------------------------------------------------
-- is_org_member(org) / is_org_owner(org)：ログイン中のユーザーがその会社のメンバー / オーナーか
-- security definer で RLS を通さずに organization_members を読む（ポリシーの無限ループ防止）
-- ---------------------------------------------------------
create function public.is_org_member(org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_members m
    where m.organization_id = org
      and m.user_id = (select auth.uid())
  );
$$;

create function public.is_org_owner(org uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.organization_members m
    where m.organization_id = org
      and m.user_id = (select auth.uid())
      and m.role = 'owner'
  );
$$;

-- is_admin と同じく、実行できるのは authenticated だけ
revoke execute on function public.is_org_member(uuid) from public, anon;
revoke execute on function public.is_org_owner(uuid)  from public, anon;
grant execute on function public.is_org_member(uuid) to authenticated;
grant execute on function public.is_org_owner(uuid)  to authenticated;


-- ---------------------------------------------------------
-- RLS を有効化（新しい 2 つの表）
-- ---------------------------------------------------------
alter table public.organizations        enable row level security;
alter table public.organization_members enable row level security;


-- ---------------------------------------------------------
-- organizations のポリシー
-- 管理者：全操作 / メンバー：自分の会社を見るだけ
-- ---------------------------------------------------------
create policy "organizations: admin all"
  on public.organizations
  for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy "organizations: client select own"
  on public.organizations
  for select
  to authenticated
  using (public.is_org_member(id));


-- ---------------------------------------------------------
-- organization_members のポリシー
-- 管理者：全操作 / メンバー：同じ会社のメンバーの行を見るだけ
-- ---------------------------------------------------------
create policy "organization_members: admin all"
  on public.organization_members
  for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy "organization_members: client select same org"
  on public.organization_members
  for select
  to authenticated
  using (public.is_org_member(organization_id));


-- ---------------------------------------------------------
-- projects のお客様向けポリシー：自分の会社の案件を見るだけ
-- ---------------------------------------------------------
drop policy "projects: client select own" on public.projects;

create policy "projects: client select own"
  on public.projects
  for select
  to authenticated
  using (public.is_org_member(organization_id));


-- ---------------------------------------------------------
-- project_files のお客様向けポリシー
-- 自分の会社の案件で、かつ「請求なし」か「支払い済み」のときだけ見える（0003 の条件を残す）
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
        and public.is_org_member(p.organization_id)
        and (p.amount is null or p.payment_status = 'paid')
    )
  );


-- ---------------------------------------------------------
-- storage.objects のお客様向けポリシー（project-files バケット）
-- project_files と同じ条件。name は 0002 と同じく明示する
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


-- ---------------------------------------------------------
-- テーブルの権限
-- 新しい 2 つの表：0004 と同じく、いったん全部外してから authenticated に select だけ
-- 書き込み（会社の作成・メンバーの追加）はサーバー側で service_role を使う
-- projects：insert の列名つき grant に organization_id を足す（client_id は 0006 まで残す）
-- ---------------------------------------------------------
revoke all on public.organizations        from anon, authenticated;
revoke all on public.organization_members from anon, authenticated;

grant select on public.organizations        to authenticated;
grant select on public.organization_members to authenticated;

grant select, insert, update, delete on public.organizations        to service_role;
grant select, insert, update, delete on public.organization_members to service_role;

grant insert (organization_id) on public.projects to authenticated;


commit;
