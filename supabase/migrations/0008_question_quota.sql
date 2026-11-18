-- =========================================================
-- 0008_question_quota：案件への質問（RAG）の回数制限（1 人 1 日 20 問）
--
-- ・question_usage：人ごと・日ごと（UTC）の質問の回数。質問の本文は保存しない
--   - 外部キーは profiles (id)（organization_members と同じ）。ユーザーを消すと回数も消える
--   - RLS は有効・ポリシーなし。anon・authenticated・service_role には何も与えない。
--     読み書きは下の関数（security definer）からだけ
--   - force row level security は付けない。付けると、表の持ち主（＝関数の持ち主）も
--     RLS に止められて、関数から書けなくなる
-- ・consume_question_quota()：1 回分を使い、使えたかと残りの回数を返す
--   - 引数なし。だれの回数かは auth.uid() で決める（他人の回数は指定できない）。null なら例外
--   - insert ... on conflict do update ... where で 1 文で数える。同時に呼ばれても、
--     行のロックで順番に処理され、where は最新の値で見直されるので、ちょうど上限の回数だけ通る
--   - 上限に達していれば、行は変えずに allowed = false・remaining = 0 を返す
--   - 日の区切りは UTC の 0 時（now() at time zone 'utc'）
--   - volatile（書き込むため。stable だと PostgREST が読み取り専用で呼ぶことがある）
--   - 上限の 20 はこの関数の中だけに書く（check 制約には書かない）
--   - EXECUTE は authenticated だけ（PUBLIC・anon・service_role から revoke）
-- ・アプリ側（askQuestion）は、案件の確認の後・埋め込みの前に呼ぶ。失敗した質問・
--   資料が見つからなかった質問も 1 回と数える（使った分を戻す処理はない）
-- ・新しい表の権限は、anon・authenticated・service_role から全部外す
--   （Supabase の初期設定で、新しい表には 3 つのロールに全部の権限が付くため）
-- ・当てる前と後に supabase/sql/0008_verify.sql の [PRE] / [POST] を流す
-- =========================================================

begin;


-- ---------------------------------------------------------
-- 1. question_usage：人ごと・日ごと（UTC）の質問の回数
-- ---------------------------------------------------------
create table public.question_usage (
  user_id        uuid not null references public.profiles (id) on delete cascade,
  day            date not null,
  question_count integer not null check (question_count >= 1),
  primary key (user_id, day)
);


-- ---------------------------------------------------------
-- 2. RLS を有効化（ポリシーは作らない）
--    authenticated などからは何も見えず、何も書けない。
--    表の持ち主（postgres）は RLS を通らないので、持ち主が同じ関数からは読み書きできる
-- ---------------------------------------------------------
alter table public.question_usage enable row level security;


-- ---------------------------------------------------------
-- 3. テーブルの権限：3 つのロールから全部外す（付け直さない）
--    service_role も外す（この機能では使わない。verify-rls はローカルの pg 接続で確かめる）
-- ---------------------------------------------------------
revoke all on public.question_usage from anon, authenticated, service_role;


-- ---------------------------------------------------------
-- 4. consume_question_quota()
--    戻り値：allowed（今回の質問を受け付けたか）・remaining（受け付けた後の残り。上限なら 0）
-- ---------------------------------------------------------
create function public.consume_question_quota()
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

-- 実行できるのは authenticated だけ
-- service_role から外すのは、auth.uid() が無い呼び出しで使う場面が無いため（呼んでも例外になる）
revoke execute on function public.consume_question_quota()
  from public, anon, service_role;
grant execute on function public.consume_question_quota()
  to authenticated;


commit;
