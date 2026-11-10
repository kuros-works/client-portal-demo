-- =========================================================
-- 0004_tighten_privileges：authenticated の権限を、アプリが使う分だけに絞る
-- =========================================================

begin;


-- ---------------------------------------------------------
-- 1. テーブルの権限：いったん全部外してから、必要な分だけ付け直す
-- ---------------------------------------------------------
revoke all on public.profiles      from anon, authenticated;
revoke all on public.projects      from anon, authenticated;
revoke all on public.project_files from anon, authenticated;

grant select on public.profiles to authenticated;

grant select                                   on public.projects to authenticated;
grant insert (name, status, client_id, amount) on public.projects to authenticated;
grant update (status, amount)                  on public.projects to authenticated;

grant select, insert, delete on public.project_files to authenticated;


-- ---------------------------------------------------------
-- 2. rls_auto_enable（ダッシュボードの「新規テーブルに自動で RLS」が作る関数）
-- 中身はダッシュボードが管理するので書き起こさない。実行権限だけ外す
-- 新しい環境には存在しないので、あるときだけ revoke する
-- ---------------------------------------------------------
do $$
declare
  f regprocedure;
begin
  for f in
    select p.oid::regprocedure
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname = 'rls_auto_enable'
  loop
    execute format(
      'revoke execute on function %s from public, anon, authenticated', f
    );
  end loop;
end
$$;


-- ---------------------------------------------------------
-- 3. profiles.role を anon / authenticated からは変えられないようにするトリガー
-- 権限（1）と RLS に加えた三重目の守り。将来 update (name) などを付けても role は守られる
-- SQL Editor（postgres）・service_role・handle_new_user（definer）からの変更は通す
-- ---------------------------------------------------------
create function public.prevent_profile_role_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'INSERT' and new.role <> 'client' then
      raise exception 'role cannot be set by this user'
        using errcode = 'insufficient_privilege';
    elsif tg_op = 'UPDATE' and new.role is distinct from old.role then
      raise exception 'role cannot be changed by this user'
        using errcode = 'insufficient_privilege';
    end if;
  end if;
  return new;
end;
$$;

create trigger profiles_prevent_role_change
  before insert or update on public.profiles
  for each row execute function public.prevent_profile_role_change();

revoke execute on function public.prevent_profile_role_change() from public, anon, authenticated;


commit;
