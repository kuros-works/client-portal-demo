-- =========================================================
-- restore-c.sql：陽性対照 C の後に、consume_question_quota を元に戻す
-- ・ローカル専用。本番では流さない（seed のユーザー admin@seed.test がいなければ止まる）
-- ・本文（$$ から $$ まで）は supabase/migrations/0008_question_quota.sql と文字まで同じにしてある
-- ・戻した後は prosrc-c.sql の結果が 0008 の本文と同じこと、verify-rls が 422 PASS / FAIL 0 に戻ることを確かめる
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
    where u.question_count < daily_limit
  returning u.question_count into used;

  if used is null then
    return query select false, 0;
  else
    return query select true, daily_limit - used;
  end if;
end
$$;
commit;
