-- =========================================================
-- 0008_rollback：migration 0008（質問の回数制限）を元に戻す
-- 0008 で作ったものを、逆の順番で消す。0007 の後と同じ形にする
--
-- ■ 注意：question_usage の中身（今日までの質問の回数）は消える
--   - 戻すと回数が 0 からになるだけで、困るデータではない（件数は実行時に NOTICE で出る）
--   - 質問の本文は元から保存していない
--
-- ■ 実行する前に
--   - アプリに回数制限のコード（askQuestion が consume_question_quota を呼ぶ）が入っている場合は、
--     先にそのコードを戻すか止める（戻した後は、質問のたびにエラーになる）
--   - 0007 も戻すときは、このファイルを先に流してから 0007_rollback.sql を流す
--     （0008 は 0007 のものを使っていないが、当てた順の逆で戻す）
--
-- ■ このファイルがしないこと
--   - supabase_migrations.schema_migrations（CLI の履歴）には触らない。
--     0008 を CLI（supabase migration up / db push など）で当てた場合は、履歴の 0008 の行を手で直す
--   - 関数・テーブルの初期設定（default privileges）には触らない（0008 も触っていない）
--
-- ■ 実行した後に
--   - 0008_verify.sql の [PRE] を流して、0007 の後の状態に戻ったことを確認する
--     （ok が false の行が無く、件数と指紋が 0008 を当てる前と同じなら合格）
-- =========================================================

begin;


-- ---------------------------------------------------------
-- 0. 先に止める確認：ここで例外になれば、何も変わらずに全体が取り消される
--    0008 は 1 つのトランザクションなので、一部だけ当たっていることはないはず。
--    1 つでも欠けていれば、思っていない状態なので止める
-- ---------------------------------------------------------
do $$
declare
  missing text[] := array[]::text[];
  n bigint;
begin
  if to_regclass('public.question_usage') is null then
    missing := missing || 'table public.question_usage'::text;
  end if;

  if to_regprocedure('public.consume_question_quota()') is null then
    missing := missing || 'function public.consume_question_quota()'::text;
  end if;

  if cardinality(missing) > 0 then
    raise exception 'rollback stopped: migration 0008 is not (fully) applied; missing: %',
      array_to_string(missing, ', ');
  end if;

  -- 消える回数の行の件数を知らせる
  select count(*) into n from public.question_usage;
  if n > 0 then
    raise notice '% question_usage row(s) will be deleted', n;
  end if;
end
$$;


-- ---------------------------------------------------------
-- 1. 関数 consume_question_quota を消す（question_usage を使うので、先に消す）
-- ---------------------------------------------------------
drop function public.consume_question_quota();


-- ---------------------------------------------------------
-- 2. question_usage を消す
--    制約・索引・外部キー用の内部トリガーも一緒に消える
--    cascade は付けない。ほかにこの表を使うもの（ビューなど）があれば、ここでエラーになる
-- ---------------------------------------------------------
drop table public.question_usage;


commit;
