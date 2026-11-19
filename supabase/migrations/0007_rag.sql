-- =========================================================
-- 0007_rag：RAG 用の DB（案件メモ・検索用の chunk・類似検索の関数）
--
-- ・vector 拡張を extensions スキーマに入れる。
--   すでに入っている場合は、ここでエラーになって全体が取り消される
--   （if not exists は付けない。別のスキーマに入っていると extensions.vector が見つからず、
--    0007_rollback.sql で拡張を消すと、0007 の前の状態とずれるため）
-- ・project_notes：1 案件 1 メモ。お客様に見せる前提の内容だけを書く
--   （質問への答えに使うので、ここに書いたことはお客様に見えるのと同じ）
-- ・project_chunks：メモ・ファイルを分割して埋め込みを付けた行。最初の版の取り込みはメモだけ
--   ファイル由来の行の見え方（請求なし or 支払い済みのときだけ）は、chunk に写さず
--   ポリシーで projects を毎回見る（あとで請求を付けた案件の行も、自動で見えなくなる）
-- ・match_project_chunks：security invoker なので RLS がそのまま効く。
--   service_role で呼ぶと全社の行が返るため、EXECUTE は authenticated だけに与える
--   演算子は search_path = '' のため operator(extensions.<=>) と書く。HNSW 索引は作らない
-- ・書き込みは管理者本人のセッション（authenticated）＋「admin all」ポリシーで行う。
--   この機能では service_role を使わない（service_role の権限は seed 用）
-- ・新しい表の権限は、表ごとに anon・authenticated・service_role から全部外してから、必要な分だけ付ける
--   （Supabase の初期設定で、新しい表には 3 つのロールに全部の権限が付くため）
-- ・unique nulls not distinct は Postgres 15 から。本番は 17
-- ・当てる前と後に supabase/sql/0007_verify.sql の [PRE] / [POST] を流す
-- =========================================================

begin;


-- ---------------------------------------------------------
-- 1. vector 拡張（extensions スキーマ）
-- ---------------------------------------------------------
create extension vector with schema extensions;


-- ---------------------------------------------------------
-- 2. project_files に (id, project_id) の一意制約を足す
--    project_chunks の複合外部キーの参照先にする。
--    ファイル由来の chunk が、別の案件のファイルを指せないようにするため
--    （id は主キーなので、既存の行がこの制約で失敗することはない）
-- ---------------------------------------------------------
alter table public.project_files
  add constraint project_files_id_project_id_key unique (id, project_id);


-- ---------------------------------------------------------
-- 3. project_notes：案件メモ（1 案件 1 メモ）
--    案件を消すとメモも消える
-- ---------------------------------------------------------
create table public.project_notes (
  project_id uuid primary key references public.projects (id) on delete cascade,
  body       text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- updated_at は projects と同じ関数（0001 の set_updated_at）で更新時に自動で now() にする
create trigger project_notes_set_updated_at
  before update on public.project_notes
  for each row execute function public.set_updated_at();


-- ---------------------------------------------------------
-- 4. project_chunks：検索用の chunk
--    - source_type = 'note' のときは file_id が null、'file' のときは必須（check 制約）
--    - (file_id, project_id) は project_files (id, project_id) への複合外部キー。
--      ファイルの行を消すと chunk も消える。file_id が null の行（メモ由来）は確認の対象外
--    - 同じ出所の chunk_index は重ならない。file_id が null どうしも重複とみなす（nulls not distinct）
--    - embedding_model は埋め込みを作ったモデル名（モデルを変えたときに作り直す行を探すため）
-- ---------------------------------------------------------
create table public.project_chunks (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references public.projects (id) on delete cascade,
  file_id         uuid,
  source_type     text not null check (source_type in ('note', 'file')),
  source_label    text not null,
  chunk_index     integer not null check (chunk_index >= 0),
  content         text not null,
  embedding       extensions.vector(1024) not null,
  embedding_model text not null,
  created_at      timestamptz not null default now(),
  constraint project_chunks_file_fkey
    foreign key (file_id, project_id)
    references public.project_files (id, project_id)
    on delete cascade,
  constraint project_chunks_source_file_check
    check ((source_type = 'file') = (file_id is not null)),
  constraint project_chunks_source_chunk_key
    unique nulls not distinct (project_id, source_type, file_id, chunk_index)
);


-- ---------------------------------------------------------
-- 5. match_project_chunks(query_embedding, match_count, filter_project_id)
--    - 見える chunk の中から、query_embedding に近い順に返す（コサイン距離）
--    - filter_project_id が null なら、見える全案件が対象
--    - 件数は DB 側で 1〜10 に収める（null は 6 件として扱う）
--    - query_embedding が null なら 0 件
--    - security invoker：呼んだ人の RLS がそのまま効く（お客様は自社の見えてよい行だけ）
--    - 引数の vector(1024) の次元は Postgres では強制されない。
--      次元が違うと距離の計算でエラーになる
-- ---------------------------------------------------------
create function public.match_project_chunks(
  query_embedding   extensions.vector(1024),
  match_count       integer default 6,
  filter_project_id uuid default null
)
returns table (
  id           uuid,
  project_id   uuid,
  source_type  text,
  source_label text,
  content      text,
  similarity   double precision
)
language sql
stable
security invoker
set search_path = ''
as $$
  select
    c.id,
    c.project_id,
    c.source_type,
    c.source_label,
    c.content,
    1 - (c.embedding operator(extensions.<=>) query_embedding) as similarity
  from public.project_chunks c
  where query_embedding is not null
    and (filter_project_id is null or c.project_id = filter_project_id)
  order by c.embedding operator(extensions.<=>) query_embedding
  limit least(greatest(coalesce(match_count, 6), 1), 10);
$$;

-- 実行できるのは authenticated だけ
-- service_role から外すのは、RLS を通らずに全社の chunk が返るのを防ぐため
revoke execute on function public.match_project_chunks(extensions.vector, integer, uuid)
  from public, anon, service_role;
grant execute on function public.match_project_chunks(extensions.vector, integer, uuid)
  to authenticated;


-- ---------------------------------------------------------
-- 6. RLS を有効化（新しい 2 つの表）
-- ---------------------------------------------------------
alter table public.project_notes  enable row level security;
alter table public.project_chunks enable row level security;


-- ---------------------------------------------------------
-- 7. project_notes のポリシー
--    管理者：全操作 / お客様：自分の会社の案件のメモを見るだけ（支払いの状態に関係なく見える）
-- ---------------------------------------------------------
create policy "project_notes: admin all"
  on public.project_notes
  for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy "project_notes: client select own"
  on public.project_notes
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.projects p
      where p.id = project_notes.project_id
        and public.is_org_member(p.organization_id)
    )
  );


-- ---------------------------------------------------------
-- 8. project_chunks のポリシー
--    管理者：全操作
--    お客様：自分の会社の案件の chunk を見るだけ。
--            メモ由来はいつでも、ファイル由来は project_files と同じく
--            「請求なし」か「支払い済み」のときだけ
-- ---------------------------------------------------------
create policy "project_chunks: admin all"
  on public.project_chunks
  for all
  to authenticated
  using (public.is_admin())
  with check (public.is_admin());

create policy "project_chunks: client select own"
  on public.project_chunks
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.projects p
      where p.id = project_chunks.project_id
        and public.is_org_member(p.organization_id)
        and (
          project_chunks.source_type = 'note'
          or p.amount is null
          or p.payment_status = 'paid'
        )
    )
  );


-- ---------------------------------------------------------
-- 9. テーブルの権限
--    いったん anon・authenticated・service_role から全部外してから、必要な分だけ付ける
--    - authenticated：書き込みは「admin all」ポリシーだけが通る
--        project_notes  … select・insert・update（保存は upsert。削除は案件の削除に連動）
--        project_chunks … select・insert・delete（作り直しは「消してから入れる」。update なし）
--    - service_role：seed 用に select・insert・update・delete
--      （TRUNCATE・REFERENCES・TRIGGER・MAINTAIN は付けない）
--    - anon：何も付けない
--    ※ authenticated が embedding を読み書きするには extensions スキーマの USAGE が要る。
--      Supabase の初期設定で付いている前提（0007_verify.sql の POST で確かめる）
-- ---------------------------------------------------------
revoke all on public.project_notes  from anon, authenticated, service_role;
revoke all on public.project_chunks from anon, authenticated, service_role;

grant select, insert, update on public.project_notes  to authenticated;
grant select, insert, delete on public.project_chunks to authenticated;

grant select, insert, update, delete on public.project_notes  to service_role;
grant select, insert, update, delete on public.project_chunks to service_role;


commit;
