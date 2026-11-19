-- =========================================================
-- 0007_rollback：migration 0007（RAG 用の DB）を元に戻す
-- 0007 で作ったものを、逆の順番で消す。0006 の後と同じ形にする
--
-- ■ 注意：project_notes の中身は戻せない
--   - 表ごと消すので、書いた案件メモはすべて失われる。必要なら先に書き出しておく
--     （件数は実行時に NOTICE で出る）
--   - project_chunks はメモ・ファイルから作り直せるデータなので、消えても困らない
--   - project_files の行と Storage の実体には触らない（消すのは一意制約だけ）
--
-- ■ 実行する前に
--   - vector 拡張は cascade なしで消す。0007_verify.sql の [PRE] 5 で
--     「0007 を当てる前は vector が入っていなかった」ことを確かめてから 0007 を当てた前提。
--     0007 の前から入っていた場合は、このファイルの「5.」を消してから流す
--   - ほかに vector を使うもの（別の表・関数など）があると、5. でエラーになり全体が取り消される
--   - アプリに RAG のコードが入っている場合は、先にそのコードを戻すか止める
--     （戻した後は、メモの保存・質問の検索がエラーになる）
--
-- ■ このファイルがしないこと
--   - supabase_migrations.schema_migrations（CLI の履歴）には触らない。
--     0007 を CLI（supabase migration up / db push など）で当てた場合は、履歴の 0007 の行を手で直す
--   - 関数・シーケンスの初期設定（default privileges）には触らない（0007 も触っていない）
--
-- ■ 実行した後に
--   - 0007_verify.sql の [PRE] を流して、0006 の後の状態に戻ったことを確認する
--     （ok が false の行が無く、件数と指紋が 0007 を当てる前と同じなら合格）
-- =========================================================

begin;


-- ---------------------------------------------------------
-- 0. 先に止める確認：ここで例外になれば、何も変わらずに全体が取り消される
--    0007 は 1 つのトランザクションなので、一部だけ当たっていることはないはず。
--    1 つでも欠けていれば、思っていない状態なので止める
-- ---------------------------------------------------------
do $$
declare
  missing text[] := array[]::text[];
  n bigint;
begin
  if to_regclass('public.project_notes') is null then
    missing := missing || 'table public.project_notes'::text;
  end if;

  if to_regclass('public.project_chunks') is null then
    missing := missing || 'table public.project_chunks'::text;
  end if;

  if not exists (
    select 1
    from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
    where ns.nspname = 'public'
      and p.proname = 'match_project_chunks'
  ) then
    missing := missing || 'function public.match_project_chunks'::text;
  end if;

  if not exists (
    select 1
    from pg_constraint con
    where con.conrelid = 'public.project_files'::regclass
      and con.conname = 'project_files_id_project_id_key'
  ) then
    missing := missing || 'constraint project_files_id_project_id_key'::text;
  end if;

  if not exists (select 1 from pg_extension e where e.extname = 'vector') then
    missing := missing || 'extension vector'::text;
  end if;

  if cardinality(missing) > 0 then
    raise exception 'rollback stopped: migration 0007 is not (fully) applied; missing: %',
      array_to_string(missing, ', ');
  end if;

  -- 消える案件メモの件数を知らせる（戻せないため）
  select count(*) into n from public.project_notes;
  if n > 0 then
    raise notice '% project note(s) will be deleted and cannot be restored', n;
  end if;
end
$$;


-- ---------------------------------------------------------
-- 1. 関数 match_project_chunks を消す
--    （project_chunks と vector 型に依存するので、先に消す）
-- ---------------------------------------------------------
drop function public.match_project_chunks(extensions.vector, integer, uuid);


-- ---------------------------------------------------------
-- 2. project_chunks を消す
--    ポリシー・制約・索引・外部キー用の内部トリガーも一緒に消える
--    cascade は付けない。ほかにこの表を使うもの（ビューなど）があれば、ここでエラーになる
-- ---------------------------------------------------------
drop table public.project_chunks;


-- ---------------------------------------------------------
-- 3. project_notes を消す（中身は戻せない）
--    ポリシー・トリガー（project_notes_set_updated_at）も一緒に消える
--    トリガーの関数 set_updated_at は 0001 のもので、projects も使うので残る
-- ---------------------------------------------------------
drop table public.project_notes;


-- ---------------------------------------------------------
-- 4. project_files の一意制約 (id, project_id) を消す
--    参照していた project_chunks の複合外部キーは 2. で消えている
-- ---------------------------------------------------------
alter table public.project_files
  drop constraint project_files_id_project_id_key;


-- ---------------------------------------------------------
-- 5. vector 拡張を消す（cascade なし）
--    0007 の前は入っていなかった前提（冒頭の注意書きを参照）
-- ---------------------------------------------------------
drop extension vector;


commit;
