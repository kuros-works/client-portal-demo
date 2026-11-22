-- =========================================================
-- 0009_rollback：migration 0009（ファイルの取り込みの状態）を元に戻す
-- 0009 で作ったもの（表 project_file_ingests・索引 project_chunks_file_id_project_id_idx）を、
-- 逆の順番で消す。0008 の後と同じ形にする
--
-- ■ 注意：project_file_ingests の中身（ファイルごとの取り込みの状態）は消える
--   - 状態は取り込み直せば作り直せるデータなので、消えても困らない（件数は実行時に NOTICE で出る）
--   - project_files の行・Storage の実体・project_chunks の行には触らない
--     （アプリの取り込みで作ったファイル由来の chunk は残る。0007 の形のままで使える）
--
-- ■ 実行する前に
--   - アプリに取り込みのコード（ingestProjectFile・管理画面の取り込みの状態の表示）が入っている場合は、
--     先にそのコードを戻すか止める（戻した後は、アップロード・管理画面の一覧がエラーになる）
--   - 0008 も戻すときは、このファイルを先に流してから 0008_rollback.sql を流す（当てた順の逆）
--
-- ■ このファイルがしないこと
--   - supabase_migrations.schema_migrations（CLI の履歴）には触らない。
--     0009 を CLI（supabase migration up / db push など）で当てた場合は、
--     `pnpm supabase migration repair 0009 --status reverted` で直す
--   - テーブルの初期設定（default privileges）には触らない（0009 も触っていない）
--
-- ■ 実行した後に
--   - 0009_verify.sql の [PRE] を流して、0008 の後の状態に戻ったことを確認する
--     （ok が false の行が無く、件数と指紋が 0009 を当てる前と同じなら合格）
-- =========================================================

begin;


-- ---------------------------------------------------------
-- 0. 先に止める確認：ここで例外になれば、何も変わらずに全体が取り消される
--    0009 は 1 つのトランザクションなので、一部だけ当たっていることはないはず。
--    1 つでも欠けていれば、思っていない状態なので止める
-- ---------------------------------------------------------
do $$
declare
  missing text[] := array[]::text[];
  n bigint;
begin
  if to_regclass('public.project_file_ingests') is null then
    missing := missing || 'table public.project_file_ingests'::text;
  end if;

  if to_regclass('public.project_chunks_file_id_project_id_idx') is null then
    missing := missing || 'index public.project_chunks_file_id_project_id_idx'::text;
  end if;

  if cardinality(missing) > 0 then
    raise exception 'rollback stopped: migration 0009 is not (fully) applied; missing: %',
      array_to_string(missing, ', ');
  end if;

  -- 消える状態の行の件数を知らせる
  select count(*) into n from public.project_file_ingests;
  if n > 0 then
    raise notice '% project_file_ingests row(s) will be deleted', n;
  end if;
end
$$;


-- ---------------------------------------------------------
-- 1. 索引 project_chunks_file_id_project_id_idx を消す（0009 の 3. の逆）
--    project_chunks の行・制約・ほかの索引は変わらない
-- ---------------------------------------------------------
drop index public.project_chunks_file_id_project_id_idx;


-- ---------------------------------------------------------
-- 2. project_file_ingests を消す（0009 の 1.・4.・5. の逆）
--    ポリシー・制約・権限・外部キー用の内部トリガーも一緒に消える
--    cascade は付けない。ほかにこの表を使うもの（ビューなど）があれば、ここでエラーになる
-- ---------------------------------------------------------
drop table public.project_file_ingests;


commit;
