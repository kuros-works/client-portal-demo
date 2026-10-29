-- =========================================================
-- 0003_project_payments：案件ごとの請求（Stripe）の準備
-- =========================================================

begin;


-- ---------------------------------------------------------
-- projects に請求用の4列を追加
-- amount：usd のセント単位。null は「請求なし」。Stripe の最低額に合わせて 50 以上
-- payment_status / paid_at / stripe_session_id は Webhook（service_role）だけが書く
-- stripe_session_id は一意（null は複数あってよい）
-- ---------------------------------------------------------
alter table public.projects
  add column amount            integer check (amount >= 50),
  add column payment_status    text not null default 'unpaid'
                                 check (payment_status in ('unpaid', 'paid')),
  add column paid_at           timestamptz,
  add column stripe_session_id text unique;


-- ---------------------------------------------------------
-- 整合性：payment_status が 'paid' なら paid_at は必ず入っている
-- ---------------------------------------------------------
alter table public.projects
  add constraint projects_paid_requires_paid_at
    check (payment_status <> 'paid' or paid_at is not null);


-- ---------------------------------------------------------
-- projects の列ごとの権限（authenticated）
-- 表全体の insert / update を外し、画面で使う列と amount だけ付け直す
--   insert：name, status, client_id（createProject）+ amount
--   update：status（updateProjectStatus）+ amount
-- 支払いの3列は管理者でも書けない。select / delete は今までどおり
-- updated_at はトリガーが書くので、列の権限は不要
-- service_role は 0001 の表全体の権限のまま（全列を書ける）
-- ---------------------------------------------------------
revoke insert, update on public.projects from authenticated;

grant insert (name, status, client_id, amount) on public.projects to authenticated;
grant update (status, amount)                  on public.projects to authenticated;


-- ---------------------------------------------------------
-- 支払い済み（payment_status = 'paid'）の行は amount を変えられないトリガー
-- 管理者・service_role を問わず、すべての更新に効く
-- ---------------------------------------------------------
create function public.prevent_paid_amount_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if old.payment_status = 'paid' and new.amount is distinct from old.amount then
    raise exception 'amount cannot be changed after payment'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger projects_prevent_paid_amount_change
  before update on public.projects
  for each row execute function public.prevent_paid_amount_change();

-- トリガー用の関数は直接呼べないようにする（0001 の set_updated_at と同じ）
revoke execute on function public.prevent_paid_amount_change() from public, anon, authenticated;


-- ---------------------------------------------------------
-- project_files のお客様向けポリシー
-- 自分の案件で、かつ「請求なし」か「支払い済み」のときだけ見える
-- projects は呼び出し側の権限（RLS あり）で読むので、関数は作らない
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
-- storage.objects のお客様向けポリシー（project-files バケット）
-- project_files と同じ条件を追加。name は 0002 と同じく明示する
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
-- stripe_events：Webhook で受け取ったイベントの記録（event_id で重複を防ぐ）
-- 本番では SQL Editor で作成済み。同じ定義を書き起こし、新しい環境でも同じ表ができるようにする
-- ---------------------------------------------------------
create table if not exists public.stripe_events (
  event_id       text not null,
  event_type     text not null,
  session_id     text null,
  amount_total   integer null,
  currency       text null,
  payment_status text null,
  customer_email text null,
  received_at    timestamp with time zone not null default now(),
  constraint stripe_events_pkey primary key (event_id)
);


-- ---------------------------------------------------------
-- stripe_events の RLS と権限
-- RLS は有効・ポリシーなし（service_role は RLS を通らない）
-- anon / authenticated には何も与えず、service_role は select と insert だけ
-- ---------------------------------------------------------
alter table public.stripe_events enable row level security;

revoke all on public.stripe_events from anon, authenticated;
grant select, insert on public.stripe_events to service_role;


commit;
