-- =========================================================
-- break-c.sql：質問の回数制限の陽性対照 C。consume_question_quota から上限の where を外す
-- ・ローカル専用。本番では絶対に流さない（seed のユーザー admin@seed.test がいなければ止まる）
-- ・on conflict do update の「where u.question_count < daily_limit」だけを外し、
--   上限を過ぎても数え続ける状態にして、verify-rls が FAIL を出せるかを確かめる
--   （予想：6 FAIL / 461 PASS（total 467）。同時 25 回の 2 件・25 回の後の回数・21 回目・上限の後の回数・rollback の後の回数）
-- ・create or replace なので、持ち主と EXECUTE の権限はそのまま残る
-- ・終わったら必ず restore-c.sql で戻す
-- =========================================================
begin;
do $$
begin
  if not exists (select 1 from auth.users where email = 'admin@seed.test') then
    raise exception 'stopped: this is not the local seed database';
  end if;
end
$$;
create or replace function public.consume_question_quota()
returns table (
  allowed   boolean,
  remaining integer
)
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  daily_limit constant integer := 20;
  uid  uuid := auth.uid();
  used integer;
begin
  if uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;

  -- 上限に達していると where で更新されず、returning は 0 行（used は null のまま）
  insert into public.question_usage as u (user_id, day, question_count)
  values (uid, (now() at time zone 'utc')::date, 1)
  on conflict (user_id, day) do update
    set question_count = u.question_count + 1
  returning u.question_count into used;

  if used is null then
    return query select false, 0;
  else
    return query select true, daily_limit - used;
  end if;
end
$$;
commit;
