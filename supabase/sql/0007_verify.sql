-- =========================================================
-- 0007_verify：migration 0007（RAG 用の DB）を本番に当てる前と後の確認
--
-- ・select だけ。書き込みは一切しない
-- ・Supabase の SQL Editor は最後の文の結果しか表示しないので、
--   セクションごとに範囲を選んで実行する
--     [PRE]    0007 を当てる直前に流す
--     [POST]   0007 を当てた直後に流す
--     [DETAIL] どこかが不合格だったときに、原因を探すために流す
-- ・結果の列：n（順番）/ check_name / actual（実際の値）/ expected（期待する値）/ ok
--     ok = true  … 合格
--     ok = false … 不合格（expected と actual を見比べる）
--     ok = null  … 目で見比べる行（expected がかっこ書き。合否を出す行の expected はかっこで始めない）
-- ・件数と案件の指紋（md5）は、PRE と POST で同じ check_name の行に出る。
--   2 つの結果を並べて、actual が同じなら合格
--   - PRE と POST の間に招待・案件の作成・ファイルの追加・支払いがあると、ずれる。続けて流すこと
--   - 指紋は updated_at を文字にしたものを含むので、同じ SQL Editor（同じタイムゾーン）で流すこと
-- ・新しい 2 表（project_notes・project_chunks）の件数は、POST で 0 なら合格
-- ・権限の行は has_table_privilege で見る。MAINTAIN は information_schema に出ないため。
--   'MAINTAIN' は Postgres 17 からの名前なので、16 以下では PRE がエラーになる
-- ・vector 型は search_path によって表示が変わらないよう、「スキーマ名.型名」で出す
--   （format_type は search_path に入っている型をスキーマ名なしで出すため）
-- ・名前の並びは collate "C"（文字コード順）でそろえる
-- ・revoke は「自分（postgres）が付けた権限」だけを外す。本番で別の役割（supabase_admin など）が
--   付けた権限があると、0007 はエラーにならずにその分が残る。POST の 40〜61・77〜78 が不合格なら、
--   [DETAIL] D3・D4 の grantor（付けた役割）を見る
-- ・ロールバックした後に [PRE] をもう一度流すと、0006 の後の状態に戻ったかを確認できる
-- =========================================================


-- =========================================================
-- [PRE] 0007 を当てる直前に流す
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
  -- Postgres の版と、0006 まで当たっていること
  -- ---------------------------------------------------------

  -- 合格：true（Postgres 17 以上。MAINTAIN の権限がある版）
  select 1 as n,
    'pre: server version is 17 or later (MAINTAIN exists)'::text as check_name,
    (current_setting('server_version_num')::int >= 170000)::text as actual,
    'true'::text as expected

  -- 合格：true（0005 の 2 つの表がある）
  union all
  select 2,
    'pre: 0005 tables organizations / organization_members exist',
    (to_regclass('public.organizations') is not null
       and to_regclass('public.organization_members') is not null)::text,
    'true'

  -- 合格：true（0006 で projects.client_id が消えている）
  union all
  select 3,
    'pre: 0006 applied (column projects.client_id does not exist)',
    (not exists (
      select 1 from pg_attribute a
      where a.attrelid = 'public.projects'::regclass
        and a.attname = 'client_id'
        and not a.attisdropped
    ))::text,
    'true'

  -- ---------------------------------------------------------
  -- vector 拡張：使えるが、まだ入っていないこと（中身は [DETAIL] D5）
  -- ---------------------------------------------------------

  -- 合格：true（vector 拡張がこのサーバーで使える）
  union all
  select 4,
    'pre: extension vector is available',
    (exists (select 1 from pg_available_extensions e where e.name = 'vector'))::text,
    'true'

  -- 合格：0（まだ入っていない。入っていると 0007 の create extension がエラーで止まる）
  union all
  select 5,
    'pre: extension vector is not installed yet',
    (select count(*) from pg_extension e where e.extname = 'vector')::text,
    '0'

  -- 合格：true（extensions スキーマがある）
  union all
  select 6,
    'pre: schema extensions exists',
    (to_regnamespace('extensions') is not null)::text,
    'true'

  -- 合格：true（authenticated が extensions スキーマの USAGE を持つ。
  --        無いと、0007 の後に authenticated が vector 型・演算子を使えない）
  union all
  select 7,
    'pre: authenticated has USAGE on schema extensions',
    (case when to_regnamespace('extensions') is null then 'no schema'
          else has_schema_privilege('authenticated'::name, 'extensions', 'USAGE')::text
     end),
    'true'

  -- 参考：入る版
  union all
  select 8,
    'info: extension vector default version',
    (select e.default_version from pg_available_extensions e where e.name = 'vector'),
    '(参考)'

  -- ---------------------------------------------------------
  -- 0007 で作るものが、まだ無いこと
  -- ---------------------------------------------------------

  -- 合格：true（新しい 2 表が無い）
  union all
  select 10,
    'pre: tables project_notes / project_chunks do not exist',
    (to_regclass('public.project_notes') is null
       and to_regclass('public.project_chunks') is null)::text,
    'true'

  -- 合格：0（関数 match_project_chunks が無い。vector 型がまだ無いので名前で探す）
  union all
  select 11,
    'pre: functions named public.match_project_chunks',
    (select count(*)
     from pg_proc p
     join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public'
       and p.proname = 'match_project_chunks')::text,
    '0'

  -- 合格：0（project_files の一意制約 project_files_id_project_id_key が無い）
  union all
  select 12,
    'pre: constraint project_files_id_project_id_key does not exist',
    (select count(*)
     from pg_constraint con
     where con.conrelid = 'public.project_files'::regclass
       and con.conname = 'project_files_id_project_id_key')::text,
    '0'

  -- ---------------------------------------------------------
  -- 列ごとの権限（authenticated の projects。0007 で変えない）
  -- ---------------------------------------------------------

  -- 合格：amount,name,organization_id,status（0006 の後の形）
  union all
  select 30,
    'authenticated INSERT columns on projects',
    (select string_agg(a.attname, ',' order by a.attname)
     from pg_attribute a
     where a.attrelid = 'public.projects'::regclass
       and a.attnum > 0 and not a.attisdropped
       and has_column_privilege('authenticated'::name, a.attrelid, a.attnum, 'INSERT')),
    'amount,name,organization_id,status'

  -- 合格：amount,status
  union all
  select 31,
    'authenticated UPDATE columns on projects',
    (select string_agg(a.attname, ',' order by a.attname)
     from pg_attribute a
     where a.attrelid = 'public.projects'::regclass
       and a.attnum > 0 and not a.attisdropped
       and has_column_privilege('authenticated'::name, a.attrelid, a.attnum, 'UPDATE')),
    'amount,status'

  -- ---------------------------------------------------------
  -- 既存の 6 表の権限（0006 の後の形。0007 で変えない。POST の同じ行と同じ）
  -- ---------------------------------------------------------

  -- 合格：5 つの表は SELECT,INSERT,UPDATE,DELETE だけ。stripe_events は SELECT,INSERT だけ
  union all
  select v.n,
    'service_role table privileges on ' || v.tbl,
    (select coalesce(string_agg(t.pr, ',' order by t.o), 'none')
     from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'])
          with ordinality as t(pr, o)
     where has_table_privilege('service_role'::name, to_regclass('public.' || v.tbl), t.pr)),
    v.expected
  from (values
    (40, 'profiles',             'SELECT,INSERT,UPDATE,DELETE'),
    (41, 'projects',             'SELECT,INSERT,UPDATE,DELETE'),
    (42, 'project_files',        'SELECT,INSERT,UPDATE,DELETE'),
    (43, 'stripe_events',        'SELECT,INSERT'),
    (44, 'organizations',        'SELECT,INSERT,UPDATE,DELETE'),
    (45, 'organization_members', 'SELECT,INSERT,UPDATE,DELETE')
  ) as v(n, tbl, expected)

  -- 合格：0004・0005 で付けた分だけ（projects の insert / update は列ごとなので、表全体では SELECT だけ）
  union all
  select v.n,
    'authenticated table privileges on ' || v.tbl,
    (select coalesce(string_agg(t.pr, ',' order by t.o), 'none')
     from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'])
          with ordinality as t(pr, o)
     where has_table_privilege('authenticated'::name, to_regclass('public.' || v.tbl), t.pr)),
    v.expected
  from (values
    (50, 'profiles',             'SELECT'),
    (51, 'projects',             'SELECT'),
    (52, 'project_files',        'SELECT,INSERT,DELETE'),
    (53, 'stripe_events',        'none'),
    (54, 'organizations',        'SELECT'),
    (55, 'organization_members', 'SELECT')
  ) as v(n, tbl, expected)

  -- 合格：none（anon は 6 つの表のどれにも、何も無い）
  union all
  select 60,
    'anon table privileges on the 6 tables',
    (select coalesce(string_agg(v.tbl || ':' || t.pr, ',' order by v.o, t.o), 'none')
     from unnest(array['profiles','projects','project_files','stripe_events',
                       'organizations','organization_members']) with ordinality as v(tbl, o)
     cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'])
          with ordinality as t(pr, o)
     where has_table_privilege('anon'::name, to_regclass('public.' || v.tbl), t.pr)),
    'none'

  -- ---------------------------------------------------------
  -- 件数と案件の指紋（POST の同じ check_name の行と見比べる）
  -- ---------------------------------------------------------

  union all
  select 90, 'count: profiles',
    (select count(*) from public.profiles)::text,
    '(PRE と POST で同じ)'

  union all
  select 91, 'count: organizations',
    (select count(*) from public.organizations)::text,
    '(PRE と POST で同じ)'

  union all
  select 92, 'count: organization_members',
    (select count(*) from public.organization_members)::text,
    '(PRE と POST で同じ)'

  union all
  select 93, 'count: projects',
    (select count(*) from public.projects)::text,
    '(PRE と POST で同じ)'

  union all
  select 94, 'count: project_files',
    (select count(*) from public.project_files)::text,
    '(PRE と POST で同じ)'

  union all
  select 95, 'count: stripe_events',
    (select count(*) from public.stripe_events)::text,
    '(PRE と POST で同じ)'

  union all
  select 96, 'count: storage objects in project-files',
    (select count(*) from storage.objects o where o.bucket_id = 'project-files')::text,
    '(PRE と POST で同じ)'

  -- 案件の id・organization_id・status・amount・payment_status・updated_at を id 順につないだ md5。
  -- 0007 は projects の行を更新しないので、PRE と同じなら合格
  union all
  select 97, 'fingerprint: projects (id, organization_id, status, amount, payment_status, updated_at)',
    (select md5(coalesce(string_agg(
       p.id::text || '|' || p.organization_id::text || '|' || p.status
         || '|' || coalesce(p.amount::text, '-') || '|' || p.payment_status
         || '|' || p.updated_at::text,
       ',' order by p.id), ''))
     from public.projects p),
    '(PRE と POST で同じ)'

) c
order by c.n;


-- =========================================================
-- [POST] 0007 を当てた直後に流す
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
  -- vector 拡張
  -- ---------------------------------------------------------

  -- 合格：extensions（vector 拡張が extensions スキーマに入っている）
  select 1 as n,
    'post: extension vector schema'::text as check_name,
    (select ns.nspname::text
     from pg_extension e
     join pg_namespace ns on ns.oid = e.extnamespace
     where e.extname = 'vector') as actual,
    'extensions'::text as expected

  -- 参考：入った版
  union all
  select 2,
    'info: extension vector installed version',
    (select e.extversion from pg_extension e where e.extname = 'vector'),
    '(参考)'

  -- ---------------------------------------------------------
  -- project_notes（中身は [DETAIL] D1）
  -- ---------------------------------------------------------

  -- 合格：右の文字列と同じ（列・型・not null。名前の順）
  union all
  select 10,
    'post: project_notes columns (name type [not null])',
    (select string_agg(
       a.attname || ' ' ||
       case when t.typnamespace = 'pg_catalog'::regnamespace
            then format_type(a.atttypid, a.atttypmod)
            else tn.nspname || '.' || t.typname || coalesce('(' || nullif(a.atttypmod, -1)::text || ')', '')
       end ||
       case when a.attnotnull then ' not null' else '' end,
       ',' order by a.attname collate "C")
     from pg_attribute a
     join pg_type t on t.oid = a.atttypid
     join pg_namespace tn on tn.oid = t.typnamespace
     where a.attrelid = 'public.project_notes'::regclass
       and a.attnum > 0 and not a.attisdropped),
    'body text not null,created_at timestamp with time zone not null,'
      || 'project_id uuid not null,updated_at timestamp with time zone not null'

  -- 合格：created_at=now(),updated_at=now()（初期値）
  union all
  select 11,
    'post: project_notes column defaults',
    (select string_agg(a.attname || '=' || pg_get_expr(d.adbin, d.adrelid), ',' order by a.attname collate "C")
     from pg_attrdef d
     join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
     where d.adrelid = 'public.project_notes'::regclass),
    'created_at=now(),updated_at=now()'

  -- 合格：project_notes_pkey:p,project_notes_project_id_fkey:f（主キー・外部キー・一意・check の名前と種類）
  union all
  select 12,
    'post: project_notes constraints (name:type)',
    (select string_agg(con.conname || ':' || con.contype::text, ',' order by con.conname collate "C")
     from pg_constraint con
     where con.conrelid = 'public.project_notes'::regclass
       and con.contype in ('p', 'u', 'f', 'c')),
    'project_notes_pkey:p,project_notes_project_id_fkey:f'

  -- 合格：projects (id) への外部キーで on delete cascade（c）、match simple（s）
  union all
  select 13,
    'post: project_notes foreign keys',
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
     where con.conrelid = 'public.project_notes'::regclass
       and con.contype = 'f'),
    'project_notes_project_id_fkey: (project_id) -> projects (id) on delete c match s'

  -- 合格：project_notes_pkey（索引は主キーの 1 つだけ）
  union all
  select 14,
    'post: project_notes indexes',
    (select string_agg(ic.relname, ',' order by ic.relname collate "C")
     from pg_index i
     join pg_class ic on ic.oid = i.indexrelid
     where i.indrelid = 'public.project_notes'::regclass),
    'project_notes_pkey'

  -- 合格：public.set_updated_at type=19 enabled=O
  --       （19 = row(1) + before(2) + update(16)。O = 有効）
  union all
  select 15,
    'post: trigger project_notes_set_updated_at',
    (select pn.nspname || '.' || p.proname || ' type=' || t.tgtype::text || ' enabled=' || t.tgenabled::text
     from pg_trigger t
     join pg_proc p on p.oid = t.tgfoid
     join pg_namespace pn on pn.oid = p.pronamespace
     where t.tgrelid = 'public.project_notes'::regclass
       and t.tgname = 'project_notes_set_updated_at'),
    'public.set_updated_at type=19 enabled=O'

  -- 合格：1（外部キー用の内部トリガーを除くと、トリガーは上の 1 つだけ）
  union all
  select 16,
    'post: project_notes non-internal triggers',
    (select count(*)
     from pg_trigger t
     where t.tgrelid = 'public.project_notes'::regclass
       and not t.tgisinternal)::text,
    '1'

  -- ---------------------------------------------------------
  -- project_chunks（中身は [DETAIL] D1）
  -- ---------------------------------------------------------

  -- 合格：右の文字列と同じ（列・型・not null。名前の順。embedding は extensions.vector(1024)）
  union all
  select 20,
    'post: project_chunks columns (name type [not null])',
    (select string_agg(
       a.attname || ' ' ||
       case when t.typnamespace = 'pg_catalog'::regnamespace
            then format_type(a.atttypid, a.atttypmod)
            else tn.nspname || '.' || t.typname || coalesce('(' || nullif(a.atttypmod, -1)::text || ')', '')
       end ||
       case when a.attnotnull then ' not null' else '' end,
       ',' order by a.attname collate "C")
     from pg_attribute a
     join pg_type t on t.oid = a.atttypid
     join pg_namespace tn on tn.oid = t.typnamespace
     where a.attrelid = 'public.project_chunks'::regclass
       and a.attnum > 0 and not a.attisdropped),
    'chunk_index integer not null,content text not null,created_at timestamp with time zone not null,'
      || 'embedding extensions.vector(1024) not null,embedding_model text not null,file_id uuid,'
      || 'id uuid not null,project_id uuid not null,source_label text not null,source_type text not null'

  -- 合格：created_at=now(),id=gen_random_uuid()
  union all
  select 21,
    'post: project_chunks column defaults',
    (select string_agg(a.attname || '=' || pg_get_expr(d.adbin, d.adrelid), ',' order by a.attname collate "C")
     from pg_attrdef d
     join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
     where d.adrelid = 'public.project_chunks'::regclass),
    'created_at=now(),id=gen_random_uuid()'

  -- 合格：右の文字列と同じ（主キー・外部キー 2 つ・一意 1 つ・check 3 つ）
  union all
  select 22,
    'post: project_chunks constraints (name:type)',
    (select string_agg(con.conname || ':' || con.contype::text, ',' order by con.conname collate "C")
     from pg_constraint con
     where con.conrelid = 'public.project_chunks'::regclass
       and con.contype in ('p', 'u', 'f', 'c')),
    'project_chunks_chunk_index_check:c,project_chunks_file_fkey:f,project_chunks_pkey:p,'
      || 'project_chunks_project_id_fkey:f,project_chunks_source_chunk_key:u,'
      || 'project_chunks_source_file_check:c,project_chunks_source_type_check:c'

  -- 合格：右の文字列と同じ
  --       file_fkey は (file_id, project_id) -> project_files (id, project_id)。
  --       match simple（s）なので、file_id が null の行（メモ由来）は確認の対象外
  union all
  select 23,
    'post: project_chunks foreign keys',
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
     where con.conrelid = 'public.project_chunks'::regclass
       and con.contype = 'f'),
    'project_chunks_file_fkey: (file_id,project_id) -> project_files (id,project_id) on delete c match s; '
      || 'project_chunks_project_id_fkey: (project_id) -> projects (id) on delete c match s'

  -- 合格：nulls not distinct: project_id,source_type,file_id,chunk_index（列の順番も含めて）
  union all
  select 24,
    'post: project_chunks_source_chunk_key (nulls / columns)',
    (select case when i.indnullsnotdistinct then 'nulls not distinct' else 'nulls distinct' end
         || ': '
         || (select string_agg(a.attname, ',' order by k.ord)
             from unnest(con.conkey) with ordinality as k(attnum, ord)
             join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum)
     from pg_constraint con
     join pg_index i on i.indexrelid = con.conindid
     where con.conrelid = 'public.project_chunks'::regclass
       and con.conname = 'project_chunks_source_chunk_key'),
    'nulls not distinct: project_id,source_type,file_id,chunk_index'

  -- 合格：true（3 つの check の中身。定義の文字で確かめる。全文は [DETAIL] D1）
  --       source_file_check：(source_type = 'file') = (file_id IS NOT NULL)
  --       source_type_check：'note' と 'file'
  --       chunk_index_check：chunk_index >= 0
  union all
  select 25,
    'post: project_chunks check constraint definitions',
    (select bool_and(case con.conname
              when 'project_chunks_source_file_check' then
                pg_get_constraintdef(con.oid) like '%source_type = ''file''%'
                and pg_get_constraintdef(con.oid) like '%file_id IS NOT NULL%'
              when 'project_chunks_source_type_check' then
                pg_get_constraintdef(con.oid) like '%''note''%'
                and pg_get_constraintdef(con.oid) like '%''file''%'
              when 'project_chunks_chunk_index_check' then
                pg_get_constraintdef(con.oid) like '%chunk_index >= 0%'
              else false
            end)::text
     from pg_constraint con
     where con.conrelid = 'public.project_chunks'::regclass
       and con.contype = 'c'),
    'true'

  -- 合格：project_chunks_pkey,project_chunks_source_chunk_key
  --       （project_id の検索は一意制約の索引を使う。project_chunks_project_id_idx・HNSW 索引は無い）
  union all
  select 26,
    'post: project_chunks indexes',
    (select string_agg(ic.relname, ',' order by ic.relname collate "C")
     from pg_index i
     join pg_class ic on ic.oid = i.indexrelid
     where i.indrelid = 'public.project_chunks'::regclass),
    'project_chunks_pkey,project_chunks_source_chunk_key'

  -- 合格：0（外部キー用の内部トリガーを除くと、トリガーは無い）
  union all
  select 27,
    'post: project_chunks non-internal triggers',
    (select count(*)
     from pg_trigger t
     where t.tgrelid = 'public.project_chunks'::regclass
       and not t.tgisinternal)::text,
    '0'

  -- 合格：u: id,project_id（project_files に足した一意制約）
  union all
  select 28,
    'post: project_files_id_project_id_key (type / columns)',
    (select con.contype::text || ': '
         || (select string_agg(a.attname, ',' order by k.ord)
             from unnest(con.conkey) with ordinality as k(attnum, ord)
             join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum)
     from pg_constraint con
     where con.conrelid = 'public.project_files'::regclass
       and con.conname = 'project_files_id_project_id_key'),
    'u: id,project_id'

  -- ---------------------------------------------------------
  -- 列ごとの権限（authenticated の projects。PRE と同じ）
  -- ---------------------------------------------------------

  union all
  select 30,
    'authenticated INSERT columns on projects',
    (select string_agg(a.attname, ',' order by a.attname)
     from pg_attribute a
     where a.attrelid = 'public.projects'::regclass
       and a.attnum > 0 and not a.attisdropped
       and has_column_privilege('authenticated'::name, a.attrelid, a.attnum, 'INSERT')),
    'amount,name,organization_id,status'

  union all
  select 31,
    'authenticated UPDATE columns on projects',
    (select string_agg(a.attname, ',' order by a.attname)
     from pg_attribute a
     where a.attrelid = 'public.projects'::regclass
       and a.attnum > 0 and not a.attisdropped
       and has_column_privilege('authenticated'::name, a.attrelid, a.attnum, 'UPDATE')),
    'amount,status'

  -- ---------------------------------------------------------
  -- RLS とポリシー（中身は [DETAIL] D2）
  -- ---------------------------------------------------------

  -- 合格：project_chunks=true,project_notes=true
  union all
  select 32,
    'post: RLS enabled on project_chunks / project_notes',
    (select string_agg(cl.relname || '=' || cl.relrowsecurity::text, ',' order by cl.relname collate "C")
     from pg_class cl
     where cl.oid in ('public.project_chunks'::regclass, 'public.project_notes'::regclass)),
    'project_chunks=true,project_notes=true'

  -- 合格：右の文字列と同じ（表 | ポリシー名 | permissive | 操作 | 対象ロール）
  union all
  select 33,
    'post: policies on project_chunks / project_notes',
    (select string_agg(
       pol.tablename || ' | ' || pol.policyname || ' | ' || pol.permissive || ' | ' || pol.cmd
         || ' | ' || array_to_string(pol.roles, ','),
       '; ' order by pol.tablename collate "C", pol.policyname collate "C")
     from pg_policies pol
     where pol.schemaname = 'public'
       and pol.tablename in ('project_chunks', 'project_notes')),
    'project_chunks | project_chunks: admin all | PERMISSIVE | ALL | authenticated; '
      || 'project_chunks | project_chunks: client select own | PERMISSIVE | SELECT | authenticated; '
      || 'project_notes | project_notes: admin all | PERMISSIVE | ALL | authenticated; '
      || 'project_notes | project_notes: client select own | PERMISSIVE | SELECT | authenticated'

  -- 合格：true（ポリシーの中身。定義の文字で確かめる。全文は [DETAIL] D2）
  --       admin all：using / with check の両方に is_admin()
  --       client select own（notes）：is_org_member。with check なし
  --       client select own（chunks）：is_org_member と、source_type・amount IS NULL・payment_status の条件。with check なし
  union all
  select 34,
    'post: policy expressions on project_chunks / project_notes',
    (select bool_and(case
              when pol.policyname like '%: admin all' then
                coalesce(pol.qual, '') like '%is_admin()%'
                and coalesce(pol.with_check, '') like '%is_admin()%'
              when pol.policyname = 'project_notes: client select own' then
                coalesce(pol.qual, '') like '%is_org_member%'
                and pol.with_check is null
              when pol.policyname = 'project_chunks: client select own' then
                coalesce(pol.qual, '') like '%is_org_member%'
                and coalesce(pol.qual, '') like '%source_type = ''note''%'
                and coalesce(pol.qual, '') like '%amount IS NULL%'
                and coalesce(pol.qual, '') like '%payment_status = ''paid''%'
                and pol.with_check is null
              else false
            end)::text
     from pg_policies pol
     where pol.schemaname = 'public'
       and pol.tablename in ('project_chunks', 'project_notes')),
    'true'

  -- ---------------------------------------------------------
  -- 表の権限（MAINTAIN も含めて has_table_privilege で見る。付いている分だけ並ぶ）
  -- 40〜45・50〜55・60 は PRE と同じ。46〜47・56〜57・61 は 0007_rag.sql の grant と同じ
  -- ---------------------------------------------------------

  union all
  select v.n,
    'service_role table privileges on ' || v.tbl,
    (select coalesce(string_agg(t.pr, ',' order by t.o), 'none')
     from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'])
          with ordinality as t(pr, o)
     where has_table_privilege('service_role'::name, to_regclass('public.' || v.tbl), t.pr)),
    v.expected
  from (values
    (40, 'profiles',             'SELECT,INSERT,UPDATE,DELETE'),
    (41, 'projects',             'SELECT,INSERT,UPDATE,DELETE'),
    (42, 'project_files',        'SELECT,INSERT,UPDATE,DELETE'),
    (43, 'stripe_events',        'SELECT,INSERT'),
    (44, 'organizations',        'SELECT,INSERT,UPDATE,DELETE'),
    (45, 'organization_members', 'SELECT,INSERT,UPDATE,DELETE'),
    (46, 'project_notes',        'SELECT,INSERT,UPDATE,DELETE'),
    (47, 'project_chunks',       'SELECT,INSERT,UPDATE,DELETE')
  ) as v(n, tbl, expected)

  union all
  select v.n,
    'authenticated table privileges on ' || v.tbl,
    (select coalesce(string_agg(t.pr, ',' order by t.o), 'none')
     from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'])
          with ordinality as t(pr, o)
     where has_table_privilege('authenticated'::name, to_regclass('public.' || v.tbl), t.pr)),
    v.expected
  from (values
    (50, 'profiles',             'SELECT'),
    (51, 'projects',             'SELECT'),
    (52, 'project_files',        'SELECT,INSERT,DELETE'),
    (53, 'stripe_events',        'none'),
    (54, 'organizations',        'SELECT'),
    (55, 'organization_members', 'SELECT'),
    (56, 'project_notes',        'SELECT,INSERT,UPDATE'),
    (57, 'project_chunks',       'SELECT,INSERT,DELETE')
  ) as v(n, tbl, expected)

  -- 合格：none（PRE と同じ）
  union all
  select 60,
    'anon table privileges on the 6 tables',
    (select coalesce(string_agg(v.tbl || ':' || t.pr, ',' order by v.o, t.o), 'none')
     from unnest(array['profiles','projects','project_files','stripe_events',
                       'organizations','organization_members']) with ordinality as v(tbl, o)
     cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'])
          with ordinality as t(pr, o)
     where has_table_privilege('anon'::name, to_regclass('public.' || v.tbl), t.pr)),
    'none'

  -- 合格：none（anon は新しい 2 表にも、何も無い）
  union all
  select 61,
    'anon table privileges on project_notes / project_chunks',
    (select coalesce(string_agg(v.tbl || ':' || t.pr, ',' order by v.o, t.o), 'none')
     from unnest(array['project_notes','project_chunks']) with ordinality as v(tbl, o)
     cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'])
          with ordinality as t(pr, o)
     where has_table_privilege('anon'::name, to_regclass('public.' || v.tbl), t.pr)),
    'none'

  -- 合格：0（新しい 2 表に列ごとの権限が無い。権限は表全体の grant だけ）
  union all
  select 62,
    'post: column-level ACLs on project_notes / project_chunks',
    (select count(*)
     from pg_attribute a
     where a.attrelid in ('public.project_notes'::regclass, 'public.project_chunks'::regclass)
       and a.attnum > 0 and not a.attisdropped
       and a.attacl is not null)::text,
    '0'

  -- ---------------------------------------------------------
  -- 関数 match_project_chunks（中身は [DETAIL] D4）
  -- ---------------------------------------------------------

  -- 合格：1（同じ名前の関数は 1 つだけ。引数の違う古い版が残っていない）
  union all
  select 70,
    'post: functions named public.match_project_chunks',
    (select count(*)
     from pg_proc p
     join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public'
       and p.proname = 'match_project_chunks')::text,
    '1'

  -- 合格：false（security invoker）
  union all
  select 71,
    'post: match_project_chunks prosecdef (security definer)',
    (select p.prosecdef::text from pg_proc p
     where p.oid = to_regprocedure('public.match_project_chunks(extensions.vector, integer, uuid)')),
    'false'

  -- 合格：search_path=""（search_path = '' が入っている）
  union all
  select 72,
    'post: match_project_chunks proconfig',
    (select array_to_string(p.proconfig, ',') from pg_proc p
     where p.oid = to_regprocedure('public.match_project_chunks(extensions.vector, integer, uuid)')),
    'search_path=""'

  -- 合格：sql/s（言語 sql・stable）
  union all
  select 73,
    'post: match_project_chunks language / volatility',
    (select l.lanname || '/' || p.provolatile::text
     from pg_proc p
     join pg_language l on l.oid = p.prolang
     where p.oid = to_regprocedure('public.match_project_chunks(extensions.vector, integer, uuid)')),
    'sql/s'

  -- 合格：引数の名前・型（スキーマ名.型名）・初期値のある引数の数
  union all
  select 74,
    'post: match_project_chunks arguments',
    (select array_to_string(p.proargnames[1:p.pronargs], ',')
         || ' / '
         || (select string_agg(tn.nspname || '.' || t.typname, ',' order by k.ord)
             from unnest(p.proargtypes::oid[]) with ordinality as k(typ, ord)
             join pg_type t on t.oid = k.typ
             join pg_namespace tn on tn.oid = t.typnamespace)
         || ' / defaults=' || p.pronargdefaults::text
     from pg_proc p
     where p.oid = to_regprocedure('public.match_project_chunks(extensions.vector, integer, uuid)')),
    'query_embedding,match_count,filter_project_id / extensions.vector,pg_catalog.int4,pg_catalog.uuid / defaults=2'

  -- 合格：右の文字列と同じ（返す列。embedding は返さない）
  union all
  select 75,
    'post: match_project_chunks result columns',
    pg_get_function_result(to_regprocedure('public.match_project_chunks(extensions.vector, integer, uuid)')),
    'TABLE(id uuid, project_id uuid, source_type text, source_label text, content text, similarity double precision)'

  -- 合格：anon:false,authenticated:true,service_role:false
  union all
  select 76,
    'post: match_project_chunks EXECUTE by role',
    (select 'anon:' || has_function_privilege('anon'::name, f.oid, 'EXECUTE')::text
         || ',authenticated:' || has_function_privilege('authenticated'::name, f.oid, 'EXECUTE')::text
         || ',service_role:' || has_function_privilege('service_role'::name, f.oid, 'EXECUTE')::text
     from (select to_regprocedure('public.match_project_chunks(extensions.vector, integer, uuid)')::oid as oid) f),
    'anon:false,authenticated:true,service_role:false'

  -- 合格：0（PUBLIC への EXECUTE が無い）
  union all
  select 77,
    'post: match_project_chunks EXECUTE granted to PUBLIC',
    (select count(*)
     from pg_proc p
     cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
     where p.oid = to_regprocedure('public.match_project_chunks(extensions.vector, integer, uuid)')
       and x.grantee = 0
       and x.privilege_type = 'EXECUTE')::text,
    '0'

  -- ---------------------------------------------------------
  -- authenticated が vector を使えること（security invoker の関数・embedding の読み書きに要る）
  -- ---------------------------------------------------------

  -- 合格：true（extensions スキーマの USAGE）
  union all
  select 78,
    'post: authenticated has USAGE on schema extensions',
    has_schema_privilege('authenticated'::name, 'extensions', 'USAGE')::text,
    'true'

  -- 合格：true（演算子 extensions.<=>(vector, vector) の関数を実行できる）
  union all
  select 79,
    'post: authenticated can execute extensions.<=> (vector, vector)',
    (select has_function_privilege('authenticated'::name, o.oprcode::oid, 'EXECUTE')::text
     from pg_operator o
     join pg_namespace ns on ns.oid = o.oprnamespace
     where ns.nspname = 'extensions'
       and o.oprname = '<=>'
       and o.oprleft = 'extensions.vector'::regtype
       and o.oprright = 'extensions.vector'::regtype),
    'true'

  -- ---------------------------------------------------------
  -- 件数と案件の指紋（PRE の同じ check_name の行と見比べる）
  -- ---------------------------------------------------------

  union all
  select 90, 'count: profiles',
    (select count(*) from public.profiles)::text,
    '(PRE と POST で同じ)'

  union all
  select 91, 'count: organizations',
    (select count(*) from public.organizations)::text,
    '(PRE と POST で同じ)'

  union all
  select 92, 'count: organization_members',
    (select count(*) from public.organization_members)::text,
    '(PRE と POST で同じ)'

  union all
  select 93, 'count: projects',
    (select count(*) from public.projects)::text,
    '(PRE と POST で同じ)'

  union all
  select 94, 'count: project_files',
    (select count(*) from public.project_files)::text,
    '(PRE と POST で同じ)'

  union all
  select 95, 'count: stripe_events',
    (select count(*) from public.stripe_events)::text,
    '(PRE と POST で同じ)'

  union all
  select 96, 'count: storage objects in project-files',
    (select count(*) from storage.objects o where o.bucket_id = 'project-files')::text,
    '(PRE と POST で同じ)'

  union all
  select 97, 'fingerprint: projects (id, organization_id, status, amount, payment_status, updated_at)',
    (select md5(coalesce(string_agg(
       p.id::text || '|' || p.organization_id::text || '|' || p.status
         || '|' || coalesce(p.amount::text, '-') || '|' || p.payment_status
         || '|' || p.updated_at::text,
       ',' order by p.id), ''))
     from public.projects p),
    '(PRE と POST で同じ)'

  -- 合格：0（新しい表はまだ空）
  union all
  select 98, 'count: project_notes',
    (select count(*) from public.project_notes)::text,
    '0'

  union all
  select 99, 'count: project_chunks',
    (select count(*) from public.project_chunks)::text,
    '0'

) c
order by c.n;


-- =========================================================
-- [DETAIL] 不合格の行があったときに、1 つずつ選んで流す
-- =========================================================

-- D1（POST 10〜28 用）：新しい 2 表と project_files の制約の定義
-- ※ 0007 を当てる前は、project_files の行だけが出る
select cl.relname as table_name,
       con.conname,
       con.contype,
       pg_get_constraintdef(con.oid) as definition
from pg_constraint con
join pg_class cl on cl.oid = con.conrelid
join pg_namespace ns on ns.oid = cl.relnamespace
where ns.nspname = 'public'
  and cl.relname in ('project_notes', 'project_chunks', 'project_files')
order by 1, 2;

-- D2（POST 32〜34 用）：新しい 2 表のポリシーの中身
select pol.tablename, pol.policyname, pol.permissive, pol.roles, pol.cmd, pol.qual, pol.with_check
from pg_policies pol
where pol.schemaname = 'public'
  and pol.tablename in ('project_notes', 'project_chunks')
order by 1, 2;

-- D3（PRE / POST 40〜62 用）：8 つの表の権限を、付けた役割（grantor）ごとに並べる
-- MAINTAIN も出る（information_schema には出ない）
-- POST の合格：
--   service_role … 既存の 5 表と新しい 2 表で SELECT,INSERT,UPDATE,DELETE、stripe_events で SELECT,INSERT
--   authenticated … project_notes で SELECT,INSERT,UPDATE、project_chunks で SELECT,INSERT,DELETE
--   anon … 新しい 2 表に行が無い
--   grantor が postgres 以外の行が残っていれば、0007 の revoke では外れない（その役割で revoke する）
select cl.relname as table_name,
       pg_get_userbyid(x.grantee) as grantee,
       pg_get_userbyid(x.grantor) as grantor,
       string_agg(x.privilege_type, ',' order by x.privilege_type) as privileges
from pg_class cl
join pg_namespace ns on ns.oid = cl.relnamespace
cross join lateral aclexplode(coalesce(cl.relacl, acldefault('r', cl.relowner))) x
where ns.nspname = 'public'
  and cl.relname in ('profiles', 'projects', 'project_files', 'stripe_events',
                     'organizations', 'organization_members',
                     'project_notes', 'project_chunks')
  and x.grantee in (select r.oid from pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role'))
group by cl.relname, x.grantee, x.grantor
order by 1, 2, 3;

-- D4（POST 70〜77 用）：match_project_chunks の定義と EXECUTE の権限（付けた役割ごと）
-- 合格：EXECUTE の grantee は authenticated と所有者（postgres）だけ。PUBLIC・anon・service_role の行が無い
select p.oid::regprocedure::text as function,
       p.prosecdef,
       p.provolatile,
       p.proconfig,
       pg_get_function_arguments(p.oid) as arguments,
       pg_get_function_result(p.oid) as result,
       case when x.grantee = 0 then 'PUBLIC' else pg_get_userbyid(x.grantee) end as grantee,
       pg_get_userbyid(x.grantor) as grantor,
       x.privilege_type
from pg_proc p
join pg_namespace ns on ns.oid = p.pronamespace
cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
where ns.nspname = 'public'
  and p.proname = 'match_project_chunks'
order by 1, 7;

-- D5（PRE 4〜8・POST 1〜2 用）：vector 拡張の状態
-- PRE の合格：installed_version が null（まだ入っていない）
-- POST の合格：installed_version が入り、schema が extensions
select a.name,
       a.default_version,
       a.installed_version,
       (select ns.nspname from pg_extension e join pg_namespace ns on ns.oid = e.extnamespace
        where e.extname = a.name) as schema
from pg_available_extensions a
where a.name = 'vector';

-- D6（PRE 7・POST 78〜79 用）：extensions スキーマの USAGE（ロールごと）
select r.rolname,
       has_schema_privilege(r.rolname, 'extensions', 'USAGE') as has_usage
from pg_roles r
where r.rolname in ('anon', 'authenticated', 'service_role')
order by 1;

-- D7（POST 62 用）：新しい 2 表の列ごとの権限
-- 合格：0 行
select a.attrelid::regclass::text as table_name, a.attname, a.attacl
from pg_attribute a
where a.attrelid in (to_regclass('public.project_notes'), to_regclass('public.project_chunks'))
  and a.attnum > 0 and not a.attisdropped
  and a.attacl is not null
order by 1, 2;
