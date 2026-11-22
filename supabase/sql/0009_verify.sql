-- =========================================================
-- 0009_verify：migration 0009（ファイルの取り込みの状態）を本番に当てる前と後の確認
--
-- ・select だけ。書き込みは一切しない
-- ・Supabase の SQL Editor は最後の文の結果しか表示しないので、
--   セクションごとに範囲を選んで実行する
--     [PRE]    0009 を当てる直前に流す
--     [POST]   0009 を当てた直後に流す
--     [DETAIL] どこかが不合格だったときに、原因を探すために流す
-- ・結果の列：n（順番）/ check_name / actual（実際の値）/ expected（期待する値）/ ok
--     ok = true  … 合格
--     ok = false … 不合格（expected と actual を見比べる）
--     ok = null  … 目で見比べる行（expected がかっこ書き。合否を出す行の expected はかっこで始めない）
-- ・project_files・project_chunks の件数と指紋（md5）は、PRE と POST で同じ check_name の行に出る。
--   2 つの結果を並べて、actual が同じなら合格
--   - PRE と POST の間にファイルの追加・削除・メモの保存があると、ずれる。続けて流すこと
--     （0009 を当てた後にファイルを上げると、取り込みの状態の行が pending 以外になり、POST 23 も不合格になる）
--   - 指紋は uploaded_at・created_at を文字にしたものを含むので、同じ SQL Editor（同じタイムゾーン）で流すこと
-- ・権限の行は has_table_privilege で見る。MAINTAIN は information_schema に出ないため。
--   'MAINTAIN' は Postgres 17 からの名前なので、16 以下ではエラーになる
-- ・名前の並びは collate "C"（文字コード順）でそろえる
-- ・revoke は「自分（postgres）が付けた権限」だけを外す。本番で別の役割（supabase_admin など）が
--   付けた権限があると、0009 はエラーにならずにその分が残る。POST の 40〜44 が不合格なら、
--   [DETAIL] D3 の grantor（付けた役割）を見る
-- ・ロールバックした後に [PRE] をもう一度流すと、0008 の後の状態に戻ったかを確認できる
-- =========================================================


-- =========================================================
-- [PRE] 0009 を当てる直前に流す
-- 合格の条件：ok が false の行が 1 つもないこと。件数と指紋の行は控えておく（スクリーンショットなど）
-- =========================================================
select
  c.n,
  c.check_name,
  c.actual,
  c.expected,
  case when c.expected like '(%' then null
       else c.actual is not distinct from c.expected
  end as ok
from (

  -- ---------------------------------------------------------
  -- Postgres の版と、0008 まで当たっていること
  -- ---------------------------------------------------------

  -- 合格：true（Postgres 17 以上。MAINTAIN の権限がある版）
  select 1 as n,
    'pre: server version is 17 or later (MAINTAIN exists)'::text as check_name,
    (current_setting('server_version_num')::int >= 170000)::text as actual,
    'true'::text as expected

  -- 合格：true（0007・0008 の表と関数がある）
  union all
  select 2,
    'pre: 0007 / 0008 applied (project_chunks / question_usage / consume_question_quota exist)',
    (to_regclass('public.project_chunks') is not null
       and to_regclass('public.question_usage') is not null
       and to_regprocedure('public.consume_question_quota()') is not null)::text,
    'true'

  -- 合格：true（外部キーの参照先 project_files (id) が主キー）
  union all
  select 3,
    'pre: project_files (id) is the primary key',
    (exists (
      select 1
      from pg_constraint con
      where con.conrelid = 'public.project_files'::regclass
        and con.contype = 'p'
        and con.conkey = array[(select a.attnum from pg_attribute a
                                where a.attrelid = 'public.project_files'::regclass
                                  and a.attname = 'id')]::int2[]
    ))::text,
    'true'

  -- 合格：true（ポリシーで使う is_admin() がある）
  union all
  select 4,
    'pre: function public.is_admin() exists',
    (to_regprocedure('public.is_admin()') is not null)::text,
    'true'

  -- ---------------------------------------------------------
  -- 0009 で作るものが、まだ無いこと
  -- ---------------------------------------------------------

  -- 合格：true（project_file_ingests が無い）
  union all
  select 10,
    'pre: table project_file_ingests does not exist',
    (to_regclass('public.project_file_ingests') is null)::text,
    'true'

  -- 合格：true（同じ名前の索引が無い）
  union all
  select 11,
    'pre: index project_chunks_file_id_project_id_idx does not exist',
    (to_regclass('public.project_chunks_file_id_project_id_idx') is null)::text,
    'true'

  -- ---------------------------------------------------------
  -- project_files・project_chunks の件数と指紋（POST の同じ check_name の行と見比べる）
  -- ---------------------------------------------------------

  union all
  select 90, 'count: project_files',
    (select count(*) from public.project_files)::text,
    '(PRE と POST で同じ)'

  -- ファイルの全部の列を id 順につないだ md5。0009 は project_files を変えないので、PRE と同じなら合格
  union all
  select 91, 'fingerprint: project_files (id, project_id, file_name, storage_path, size, uploaded_at)',
    (select md5(coalesce(string_agg(
       f.id::text || '|' || f.project_id::text || '|' || f.file_name
         || '|' || f.storage_path || '|' || f.size::text || '|' || f.uploaded_at::text,
       ',' order by f.id), ''))
     from public.project_files f),
    '(PRE と POST で同じ)'

  union all
  select 92, 'count: project_chunks',
    (select count(*) from public.project_chunks)::text,
    '(PRE と POST で同じ)'

  -- chunk の全部の列を id 順につないだ md5（content と embedding は md5 にしてからつなぐ）。
  -- 0009 は索引を足すだけで、行は変えないので、PRE と同じなら合格
  union all
  select 93, 'fingerprint: project_chunks (all columns, content / embedding as md5)',
    (select md5(coalesce(string_agg(
       ch.id::text || '|' || ch.project_id::text || '|' || coalesce(ch.file_id::text, '-')
         || '|' || ch.source_type || '|' || ch.source_label || '|' || ch.chunk_index::text
         || '|' || md5(ch.content) || '|' || md5(ch.embedding::text)
         || '|' || ch.embedding_model || '|' || ch.created_at::text,
       ',' order by ch.id), ''))
     from public.project_chunks ch),
    '(PRE と POST で同じ)'

) c
order by c.n;


-- =========================================================
-- [POST] 0009 を当てた直後に流す
-- 合格の条件：ok が false の行が 1 つもなく、件数と指紋の行が PRE と同じこと
-- =========================================================
select
  c.n,
  c.check_name,
  c.actual,
  c.expected,
  case when c.expected like '(%' then null
       else c.actual is not distinct from c.expected
  end as ok
from (

  -- ---------------------------------------------------------
  -- project_file_ingests の形（中身は [DETAIL] D1）
  -- ---------------------------------------------------------

  -- 合格：true（表がある）
  select 10 as n,
    'post: table project_file_ingests exists'::text as check_name,
    (to_regclass('public.project_file_ingests') is not null)::text as actual,
    'true'::text as expected

  -- 合格：右の文字列と同じ（列・型・not null。名前の順）
  union all
  select 11,
    'post: project_file_ingests columns (name type [not null])',
    (select string_agg(
       a.attname || ' ' || format_type(a.atttypid, a.atttypmod) ||
       case when a.attnotnull then ' not null' else '' end,
       ',' order by a.attname collate "C")
     from pg_attribute a
     where a.attrelid = to_regclass('public.project_file_ingests')
       and a.attnum > 0 and not a.attisdropped),
    'file_id uuid not null,ingest_error text,ingest_status text not null,ingested_at timestamp with time zone'

  -- 合格：主キー（＝外部キーの列）・check 2 つ・外部キーの 4 つ（名前と種類）
  union all
  select 12,
    'post: project_file_ingests constraints (name:type)',
    (select string_agg(con.conname || ':' || con.contype::text, ',' order by con.conname collate "C")
     from pg_constraint con
     where con.conrelid = to_regclass('public.project_file_ingests')
       and con.contype in ('p', 'u', 'f', 'c')),
    'project_file_ingests_error_check:c,project_file_ingests_file_id_fkey:f,'
      || 'project_file_ingests_pkey:p,project_file_ingests_status_check:c'

  -- 合格：project_files (id) への外部キーで on delete cascade（c）、match simple（s）
  union all
  select 13,
    'post: project_file_ingests foreign keys',
    (select string_agg(
       con.conname || ': ('
         || (select string_agg(a.attname, ',' order by k.ord)
             from unnest(con.conkey) with ordinality as k(attnum, ord)
             join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum)
         || ') -> ' || rc.relname || ' ('
         || (select string_agg(a.attname, ',' order by k.ord)
             from unnest(con.confkey) with ordinality as k(attnum, ord)
             join pg_attribute a on a.attrelid = con.confrelid and a.attnum = k.attnum)
         || ') on delete ' || con.confdeltype::text || ' match ' || con.confmatchtype::text,
       '; ' order by con.conname collate "C")
     from pg_constraint con
     join pg_class rc on rc.oid = con.confrelid
     where con.conrelid = to_regclass('public.project_file_ingests')
       and con.contype = 'f'),
    'project_file_ingests_file_id_fkey: (file_id) -> project_files (id) on delete c match s'

  -- 合格：ingest_status='pending'::text（初期値は ingest_status の pending だけ）
  union all
  select 14,
    'post: project_file_ingests column defaults',
    (select coalesce(string_agg(a.attname || '=' || pg_get_expr(d.adbin, d.adrelid), ','
                                order by a.attname collate "C"), 'none')
     from pg_attrdef d
     join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
     where d.adrelid = to_regclass('public.project_file_ingests')),
    'ingest_status=''pending''::text'

  -- 合格：true（check の中身。決めた種類だけ。全文は [DETAIL] D1）
  union all
  select 15,
    'post: project_file_ingests check constraint definitions',
    (select bool_and(case
              when con.conname = 'project_file_ingests_status_check' then
                pg_get_constraintdef(con.oid) like '%''pending''%'
                and pg_get_constraintdef(con.oid) like '%''ready''%'
                and pg_get_constraintdef(con.oid) like '%''failed''%'
                and pg_get_constraintdef(con.oid) like '%''skipped''%'
              when con.conname = 'project_file_ingests_error_check' then
                pg_get_constraintdef(con.oid) like '%ingest_error IS NULL%'
                and pg_get_constraintdef(con.oid) like '%''no_text''%'
                and pg_get_constraintdef(con.oid) like '%''too_long''%'
                and pg_get_constraintdef(con.oid) like '%''too_many_pages''%'
                and pg_get_constraintdef(con.oid) like '%''not_pdf''%'
                and pg_get_constraintdef(con.oid) like '%''rate_limited''%'
                and pg_get_constraintdef(con.oid) like '%''failed''%'
              else false
            end)::text
     from pg_constraint con
     where con.conrelid = to_regclass('public.project_file_ingests')
       and con.contype = 'c'),
    'true'

  -- 合格：0（外部キー用の内部トリガーを除くと、トリガーは無い。状態の行はアプリが upsert で書く）
  union all
  select 16,
    'post: project_file_ingests non-internal triggers',
    (select count(*)
     from pg_trigger t
     where t.tgrelid = to_regclass('public.project_file_ingests')
       and not t.tgisinternal)::text,
    '0'

  -- ---------------------------------------------------------
  -- 行（既存のファイルに pending の行が 1 つずつ）
  -- ---------------------------------------------------------

  -- 合格：true（行の数が project_files の件数と同じ）
  union all
  select 20,
    'post: project_file_ingests rows = project_files rows',
    ((select count(*) from public.project_file_ingests)
       = (select count(*) from public.project_files))::text,
    'true'

  -- 合格：0（状態の行が無いファイルが無い）
  union all
  select 21,
    'post: project_files without an ingest row',
    (select count(*)
     from public.project_files f
     where not exists (select 1 from public.project_file_ingests i where i.file_id = f.id))::text,
    '0'

  -- 参考：行の数（PRE の「count: project_files」と同じはず）
  union all
  select 22, 'info: count project_file_ingests',
    (select count(*) from public.project_file_ingests)::text,
    '(PRE の count: project_files と同じ)'

  -- 合格：none（全部 pending・ingest_error と ingested_at は null）
  union all
  select 23,
    'post: project_file_ingests rows other than pending / null / null',
    (select coalesce(string_agg(
       x.ingest_status || ':' || coalesce(x.ingest_error, '-') || ':'
         || case when x.has_at then 'set' else '-' end || '=' || x.cnt::text,
       ',' order by x.ingest_status collate "C", x.ingest_error collate "C"), 'none')
     from (
       select i.ingest_status, i.ingest_error, (i.ingested_at is not null) as has_at, count(*) as cnt
       from public.project_file_ingests i
       where i.ingest_status <> 'pending' or i.ingest_error is not null or i.ingested_at is not null
       group by 1, 2, 3
     ) x),
    'none'

  -- ---------------------------------------------------------
  -- RLS とポリシー（中身は [DETAIL] D2）
  -- ---------------------------------------------------------

  -- 合格：rls=true,force=false
  union all
  select 30,
    'post: project_file_ingests RLS enabled / not forced',
    (select 'rls=' || cl.relrowsecurity::text || ',force=' || cl.relforcerowsecurity::text
     from pg_class cl
     where cl.oid = to_regclass('public.project_file_ingests')),
    'rls=true,force=false'

  -- 合格：右の文字列と同じ（ポリシーは admin all の 1 つだけ。お客様向けのポリシーは無い）
  union all
  select 31,
    'post: policies on project_file_ingests (name | permissive | cmd | roles)',
    (select coalesce(string_agg(
       pol.policyname || ' | ' || pol.permissive || ' | ' || pol.cmd || ' | '
         || array_to_string(pol.roles, ','),
       '; ' order by pol.policyname collate "C"), 'none')
     from pg_policies pol
     where pol.schemaname = 'public'
       and pol.tablename = 'project_file_ingests'),
    'project_file_ingests: admin all | PERMISSIVE | ALL | authenticated'

  -- 合格：true（using / with check の両方に is_admin()。全文は [DETAIL] D2）
  union all
  select 32,
    'post: policy expressions on project_file_ingests',
    (select bool_and(
              coalesce(pol.qual, '') like '%is_admin()%'
              and coalesce(pol.with_check, '') like '%is_admin()%')::text
     from pg_policies pol
     where pol.schemaname = 'public'
       and pol.tablename = 'project_file_ingests'),
    'true'

  -- ---------------------------------------------------------
  -- 表の権限（MAINTAIN も含めて has_table_privilege で見る。付いている分だけ並ぶ）
  -- ---------------------------------------------------------

  -- 合格：SELECT,INSERT,UPDATE,DELETE（seed 用。TRUNCATE・REFERENCES・TRIGGER・MAINTAIN は無い）
  union all
  select 40,
    'service_role table privileges on project_file_ingests',
    (select coalesce(string_agg(t.pr, ',' order by t.o), 'none')
     from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'])
          with ordinality as t(pr, o)
     where has_table_privilege('service_role'::name, to_regclass('public.project_file_ingests'), t.pr)),
    'SELECT,INSERT,UPDATE,DELETE'

  -- 合格：SELECT,INSERT,UPDATE（delete はファイルの行の削除に連動するので付けない）
  union all
  select 41,
    'authenticated table privileges on project_file_ingests',
    (select coalesce(string_agg(t.pr, ',' order by t.o), 'none')
     from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'])
          with ordinality as t(pr, o)
     where has_table_privilege('authenticated'::name, to_regclass('public.project_file_ingests'), t.pr)),
    'SELECT,INSERT,UPDATE'

  -- 合格：none（anon は何も無い）
  union all
  select 42,
    'anon table privileges on project_file_ingests',
    (select coalesce(string_agg(t.pr, ',' order by t.o), 'none')
     from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'])
          with ordinality as t(pr, o)
     where has_table_privilege('anon'::name, to_regclass('public.project_file_ingests'), t.pr)),
    'none'

  -- 合格：0（列ごとの権限が無い）
  union all
  select 43,
    'post: column-level ACLs on project_file_ingests',
    (select count(*)
     from pg_attribute a
     where a.attrelid = to_regclass('public.project_file_ingests')
       and a.attnum > 0 and not a.attisdropped
       and a.attacl is not null)::text,
    '0'

  -- 合格：右の文字列と同じ（表の ACL の、持ち主以外の行。PUBLIC やほかのロールが無いことも見る）
  union all
  select 44,
    'post: project_file_ingests ACL entries other than the owner',
    (select coalesce(string_agg(
       case when x.grantee = 0 then 'PUBLIC' else pg_get_userbyid(x.grantee) end || ':' || x.privilege_type,
       ',' order by case when x.grantee = 0 then 'PUBLIC' else pg_get_userbyid(x.grantee) end collate "C",
                    x.privilege_type collate "C"), 'none')
     from pg_class cl
     cross join lateral aclexplode(coalesce(cl.relacl, acldefault('r', cl.relowner))) x
     where cl.oid = to_regclass('public.project_file_ingests')
       and x.grantee <> cl.relowner),
    'authenticated:INSERT,authenticated:SELECT,authenticated:UPDATE,'
      || 'service_role:DELETE,service_role:INSERT,service_role:SELECT,service_role:UPDATE'

  -- ---------------------------------------------------------
  -- 索引（project_chunks (file_id, project_id)。中身は [DETAIL] D4）
  -- ---------------------------------------------------------

  -- 合格：右の文字列と同じ（btree・一意でない・部分索引でない・列は file_id, project_id の順）
  union all
  select 50,
    'post: index project_chunks_file_id_project_id_idx (table | method | columns | unique | partial)',
    (select ti.relname || ' | ' || am.amname || ' | '
         || (select string_agg(a.attname, ',' order by k.ord)
             from unnest(i.indkey::int2[]) with ordinality as k(attnum, ord)
             join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum)
         || ' | unique=' || i.indisunique::text
         || ' | partial=' || (i.indpred is not null)::text
     from pg_index i
     join pg_class ic on ic.oid = i.indexrelid
     join pg_class ti on ti.oid = i.indrelid
     join pg_am am on am.oid = ic.relam
     where i.indexrelid = to_regclass('public.project_chunks_file_id_project_id_idx')),
    'project_chunks | btree | file_id,project_id | unique=false | partial=false'

  -- 合格：true（索引が使える状態。valid・ready）
  union all
  select 51,
    'post: index project_chunks_file_id_project_id_idx is valid',
    (select (i.indisvalid and i.indisready)::text
     from pg_index i
     where i.indexrelid = to_regclass('public.project_chunks_file_id_project_id_idx')),
    'true'

  -- ---------------------------------------------------------
  -- project_files・project_chunks の件数と指紋（PRE の同じ check_name の行と見比べる）
  -- ---------------------------------------------------------

  union all
  select 90, 'count: project_files',
    (select count(*) from public.project_files)::text,
    '(PRE と POST で同じ)'

  union all
  select 91, 'fingerprint: project_files (id, project_id, file_name, storage_path, size, uploaded_at)',
    (select md5(coalesce(string_agg(
       f.id::text || '|' || f.project_id::text || '|' || f.file_name
         || '|' || f.storage_path || '|' || f.size::text || '|' || f.uploaded_at::text,
       ',' order by f.id), ''))
     from public.project_files f),
    '(PRE と POST で同じ)'

  union all
  select 92, 'count: project_chunks',
    (select count(*) from public.project_chunks)::text,
    '(PRE と POST で同じ)'

  union all
  select 93, 'fingerprint: project_chunks (all columns, content / embedding as md5)',
    (select md5(coalesce(string_agg(
       ch.id::text || '|' || ch.project_id::text || '|' || coalesce(ch.file_id::text, '-')
         || '|' || ch.source_type || '|' || ch.source_label || '|' || ch.chunk_index::text
         || '|' || md5(ch.content) || '|' || md5(ch.embedding::text)
         || '|' || ch.embedding_model || '|' || ch.created_at::text,
       ',' order by ch.id), ''))
     from public.project_chunks ch),
    '(PRE と POST で同じ)'

) c
order by c.n;


-- =========================================================
-- [DETAIL] 不合格の行があったときに、1 つずつ選んで流す
-- =========================================================

-- D1（POST 11〜16 用）：project_file_ingests の制約の定義
-- ※ 0009 を当てる前は、何も出ない
select cl.relname as table_name,
       con.conname,
       con.contype,
       pg_get_constraintdef(con.oid) as definition
from pg_constraint con
join pg_class cl on cl.oid = con.conrelid
join pg_namespace ns on ns.oid = cl.relnamespace
where ns.nspname = 'public'
  and cl.relname = 'project_file_ingests'
order by 1, 2;

-- D2（POST 31・32 用）：project_file_ingests のポリシー
-- 合格：「project_file_ingests: admin all」の 1 行だけ。qual・with_check の両方が is_admin()
select pol.tablename, pol.policyname, pol.permissive, pol.roles, pol.cmd, pol.qual, pol.with_check
from pg_policies pol
where pol.schemaname = 'public'
  and pol.tablename = 'project_file_ingests'
order by 1, 2;

-- D3（POST 40〜44 用）：project_file_ingests の権限を、付けた役割（grantor）ごとに並べる
-- MAINTAIN も出る（information_schema には出ない）
-- 合格：
--   service_role … DELETE,INSERT,SELECT,UPDATE
--   authenticated … INSERT,SELECT,UPDATE
--   anon・PUBLIC … 行が無い
--   grantor が postgres 以外の行が残っていれば、0009 の revoke では外れない（その役割で revoke する）
select cl.relname as table_name,
       case when x.grantee = 0 then 'PUBLIC' else pg_get_userbyid(x.grantee) end as grantee,
       pg_get_userbyid(x.grantor) as grantor,
       string_agg(x.privilege_type, ',' order by x.privilege_type) as privileges
from pg_class cl
cross join lateral aclexplode(coalesce(cl.relacl, acldefault('r', cl.relowner))) x
where cl.oid = to_regclass('public.project_file_ingests')
  and x.grantee <> cl.relowner
group by cl.relname, x.grantee, x.grantor
order by 1, 2, 3;

-- D4（POST 50・51 用）：project_chunks の索引の定義
-- 合格：project_chunks_file_id_project_id_idx が「USING btree (file_id, project_id)」で出る
select ic.relname as index_name,
       pg_get_indexdef(i.indexrelid) as definition,
       i.indisvalid,
       i.indisready
from pg_index i
join pg_class ic on ic.oid = i.indexrelid
where i.indrelid = 'public.project_chunks'::regclass
order by 1;

-- D5（POST 20〜23 用）：状態の行の内訳と、行が無いファイル
-- 合格：pending / null / null の 1 行だけで、件数が project_files と同じ。2 つ目の select は 0 行
select i.ingest_status, i.ingest_error, (i.ingested_at is not null) as has_ingested_at, count(*)
from public.project_file_ingests i
group by 1, 2, 3
order by 1, 2, 3;

select f.id, f.project_id, f.file_name
from public.project_files f
where not exists (select 1 from public.project_file_ingests i where i.file_id = f.id)
order by f.id;
