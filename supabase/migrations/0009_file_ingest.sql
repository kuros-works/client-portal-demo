-- =========================================================
-- 0009_file_ingest：ファイルの取り込み（PDF → chunk）の状態を記録する
--
-- ・状態は project_files の列ではなく、別の表 project_file_ingests に置く。
--   管理者もお客様も同じ authenticated ロールなので、列の権限では「管理者だけ」を表せない。
--   別の表にして「admin all」ポリシーだけを置けば、お客様には行が 1 つも見えず、
--   管理者は本人のセッションで読み書きできる（service_role は使わない。0007 と同じ方針）
-- ・1 ファイル 1 行。file_id は project_files(id) への外部キー（on delete cascade：
--   ファイルの行を消すと状態の行も消える）
-- ・ingest_status：pending / ready / failed / skipped（初期値 pending）
--   ingest_error：失敗・見送りの短い種類だけ（例 no_text・too_long・too_many_pages・not_pdf・rate_limited・failed）。
--   本文や例外のメッセージは入れない（check 制約で、決めた種類だけにする）
--   ingested_at：取り込みが終わった時刻
-- ・既存のファイルには、この migration で pending の行を 1 つずつ作る
-- ・状態の行はトリガーで作らず、アプリの取り込み処理が upsert で書く。行が無いファイルは pending とみなす
-- ・project_chunks に (file_id, project_id) の索引を足す
--   （ファイルの行を消したときの cascade と、ファイルごとの chunk の入れ直しで使う）
-- ・新しい表の権限は、anon・authenticated・service_role から全部外してから必要な分だけ付ける
--   （Supabase の初期設定で、新しい表には 3 つのロールに全部の権限が付くため。
--    service_role の TRUNCATE・REFERENCES・TRIGGER・MAINTAIN もここで外れる）
-- ・project_files・project_chunks の権限とポリシーは変えない
-- ・当てる前と後に supabase/sql/0009_verify.sql の [PRE] / [POST] を流す（別途作る）
-- =========================================================

begin;


-- ---------------------------------------------------------
-- 1. project_file_ingests：ファイルごとの取り込みの状態
-- ---------------------------------------------------------
create table public.project_file_ingests (
  file_id       uuid primary key references public.project_files (id) on delete cascade,
  ingest_status text not null default 'pending',
  ingest_error  text,
  ingested_at   timestamptz,
  constraint project_file_ingests_status_check
    check (ingest_status in ('pending', 'ready', 'failed', 'skipped')),
  constraint project_file_ingests_error_check
    check (
      ingest_error is null
      or ingest_error in ('no_text', 'too_long', 'too_many_pages', 'not_pdf', 'rate_limited', 'failed')
    )
);


-- ---------------------------------------------------------
-- 2. 既存のファイルの行を pending で作る
-- ---------------------------------------------------------
insert into public.project_file_ingests (file_id)
select f.id
from public.project_files f;


-- ---------------------------------------------------------
-- 3. project_chunks の (file_id, project_id) の索引
--    project_chunks_file_fkey（0007）の列の順に合わせる
-- ---------------------------------------------------------
create index project_chunks_file_id_project_id_idx
  on public.project_chunks (file_id, project_id);


-- ---------------------------------------------------------
-- 4. RLS：管理者だけ（お客様向けのポリシーは置かない＝お客様には 0 行）
-- ---------------------------------------------------------
alter table public.project_file_ingests enable row level security;

create policy "project_file_ingests: admin all"
  on public.project_file_ingests
  for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());


-- ---------------------------------------------------------
-- 5. テーブルの権限
--    いったん anon・authenticated・service_role から全部外してから、必要な分だけ付ける
--    - authenticated：select・insert・update（書き込みは「admin all」ポリシーだけが通る）
--        削除はファイルの行の削除に連動するので delete は付けない
--    - service_role：seed 用に select・insert・update・delete
--      （TRUNCATE・REFERENCES・TRIGGER・MAINTAIN は付けない）
--    - anon：何も付けない
-- ---------------------------------------------------------
revoke all on public.project_file_ingests from anon, authenticated, service_role;

grant select, insert, update on public.project_file_ingests to authenticated;

grant select, insert, update, delete on public.project_file_ingests to service_role;


commit;
