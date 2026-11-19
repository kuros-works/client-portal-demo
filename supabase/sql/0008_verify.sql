-- =========================================================
-- 0008_verify：migration 0008（質問の回数制限）を本番に当てる前と後の確認
--
-- ・select だけ。書き込みは一切しない（consume_question_quota も呼ばない）
-- ・Supabase の SQL Editor は最後の文の結果しか表示しないので、
--   セクションごとに範囲を選んで実行する
--     [PRE]    0008 を当てる直前に流す（0007 の [POST] の後）
--     [POST]   0008 を当てた直後に流す
--     [DETAIL] どこかが不合格だったときに、原因を探すために流す
-- ・結果の列：n（順番）/ check_name / actual（実際の値）/ expected（期待する値）/ ok
--     ok = true  … 合格
--     ok = false … 不合格（expected と actual を見比べる）
--     ok = null  … 目で見比べる行（expected がかっこ書き。合否を出す行の expected はかっこで始めない）
-- ・件数と案件の指紋（md5）は、PRE と POST で同じ check_name の行に出る。
--   2 つの結果を並べて、actual が同じなら合格
--   - PRE と POST の間に招待・案件の作成・ファイルの追加・支払い・メモの保存があると、ずれる。続けて流すこと
--   - 指紋は updated_at を文字にしたものを含むので、同じ SQL Editor（同じタイムゾーン）で流すこと
-- ・新しい表（question_usage）の件数は、POST で 0 なら合格
-- ・権限の行は has_table_privilege で見る。MAINTAIN は information_schema に出ないため。
--   'MAINTAIN' は Postgres 17 からの名前なので、16 以下では PRE がエラーになる
-- ・名前の並びは collate "C"（文字コード順）でそろえる
-- ・revoke は「自分（postgres）が付けた権限」だけを外す。本番で別の役割（supabase_admin など）が
--   付けた権限があると、0008 はエラーにならずにその分が残る。POST の 48・58・61・63・76〜77 が
--   不合格なら、[DETAIL] D3・D4 の grantor（付けた役割）を見る
-- ・ロールバックした後に [PRE] をもう一度流すと、0007 の後の状態に戻ったかを確認できる
-- =========================================================


-- =========================================================
-- [PRE] 0008 を当てる直前に流す
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
  -- Postgres の版と、0007 まで当たっていること
  -- ---------------------------------------------------------

  -- 合格：true（Postgres 17 以上。MAINTAIN の権限がある版）
  select 1 as n,
    'pre: server version is 17 or later (MAINTAIN exists)'::text as check_name,
    (current_setting('server_version_num')::int >= 170000)::text as actual,
    'true'::text as expected

  -- 合格：true（0007 の 2 つの表と関数がある）
  union all
  select 2,
    'pre: 0007 applied (project_notes / project_chunks / match_project_chunks exist)',
    (to_regclass('public.project_notes') is not null
       and to_regclass('public.project_chunks') is not null
       and exists (
         select 1
         from pg_proc p
         join pg_namespace ns on ns.oid = p.pronamespace
         where ns.nspname = 'public'
           and p.proname = 'match_project_chunks'
       ))::text,
    'true'

  -- 合格：true（外部キーの参照先 profiles (id) が主キー）
  union all
  select 3,
    'pre: profiles (id) is the primary key',
    (exists (
      select 1
      from pg_constraint con
      where con.conrelid = 'public.profiles'::regclass
        and con.contype = 'p'
        and con.conkey = array[(select a.attnum from pg_attribute a
                                where a.attrelid = 'public.profiles'::regclass
                                  and a.attname = 'id')]::int2[]
    ))::text,
    'true'

  -- ---------------------------------------------------------
  -- 0008 で作るものが、まだ無いこと
  -- ---------------------------------------------------------

  -- 合格：true（question_usage が無い）
  union all
  select 10,
    'pre: table question_usage does not exist',
    (to_regclass('public.question_usage') is null)::text,
    'true'

  -- 合格：0（同じ名前の関数が無い。引数の違う版も含めて名前で探す）
  union all
  select 11,
    'pre: functions named public.consume_question_quota',
    (select count(*)
     from pg_proc p
     join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public'
       and p.proname = 'consume_question_quota')::text,
    '0'

  -- ---------------------------------------------------------
  -- 列ごとの権限（authenticated の projects。0008 で変えない）
  -- ---------------------------------------------------------

  -- 合格：amount,name,organization_id,status
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
  -- 既存の 8 表の権限（0007 の後の形。0008 で変えない。POST の同じ行と同じ）
  -- ---------------------------------------------------------

  -- 合格：stripe_events は SELECT,INSERT だけ。ほかの 7 表は SELECT,INSERT,UPDATE,DELETE だけ
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

  -- 合格：0004・0005・0007 で付けた分だけ（projects の insert / update は列ごとなので、表全体では SELECT だけ）
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

  -- 合格：none（anon は 8 つの表のどれにも、何も無い）
  union all
  select 60,
    'anon table privileges on the 8 tables',
    (select coalesce(string_agg(v.tbl || ':' || t.pr, ',' order by v.o, t.o), 'none')
     from unnest(array['profiles','projects','project_files','stripe_events',
                       'organizations','organization_members',
                       'project_notes','project_chunks']) with ordinality as v(tbl, o)
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
  -- 0008 は projects の行を更新しないので、PRE と同じなら合格
  union all
  select 97, 'fingerprint: projects (id, organization_id, status, amount, payment_status, updated_at)',
    (select md5(coalesce(string_agg(
       p.id::text || '|' || p.organization_id::text || '|' || p.status
         || '|' || coalesce(p.amount::text, '-') || '|' || p.payment_status
         || '|' || p.updated_at::text,
       ',' order by p.id), ''))
     from public.projects p),
    '(PRE と POST で同じ)'

  union all
  select 98, 'count: project_notes',
    (select count(*) from public.project_notes)::text,
    '(PRE と POST で同じ)'

  union all
  select 99, 'count: project_chunks',
    (select count(*) from public.project_chunks)::text,
    '(PRE と POST で同じ)'

) c
order by c.n;


-- =========================================================
-- [POST] 0008 を当てた直後に流す
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
  -- question_usage（中身は [DETAIL] D1）
  -- ---------------------------------------------------------

  -- 合格：右の文字列と同じ（列・型・not null。名前の順）
  select 10 as n,
    'post: question_usage columns (name type [not null])'::text as check_name,
    (select string_agg(
       a.attname || ' ' || format_type(a.atttypid, a.atttypmod) ||
       case when a.attnotnull then ' not null' else '' end,
       ',' order by a.attname collate "C")
     from pg_attribute a
     where a.attrelid = 'public.question_usage'::regclass
       and a.attnum > 0 and not a.attisdropped) as actual,
    'day date not null,question_count integer not null,user_id uuid not null'::text as expected

  -- 合格：none（初期値は無い。値は関数が必ず入れる）
  union all
  select 11,
    'post: question_usage column defaults',
    (select coalesce(string_agg(a.attname || '=' || pg_get_expr(d.adbin, d.adrelid), ','
                                order by a.attname collate "C"), 'none')
     from pg_attrdef d
     join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
     where d.adrelid = 'public.question_usage'::regclass),
    'none'

  -- 合格：主キー・check・外部キーの 3 つ（名前と種類）
  union all
  select 12,
    'post: question_usage constraints (name:type)',
    (select string_agg(con.conname || ':' || con.contype::text, ',' order by con.conname collate "C")
     from pg_constraint con
     where con.conrelid = 'public.question_usage'::regclass
       and con.contype in ('p', 'u', 'f', 'c')),
    'question_usage_pkey:p,question_usage_question_count_check:c,question_usage_user_id_fkey:f'

  -- 合格：user_id,day（主キーの列。順番も含めて。on conflict (user_id, day) の対象）
  union all
  select 13,
    'post: question_usage primary key columns',
    (select string_agg(a.attname, ',' order by k.ord)
     from pg_constraint con
     cross join lateral unnest(con.conkey) with ordinality as k(attnum, ord)
     join pg_attribute a on a.attrelid = con.conrelid and a.attnum = k.attnum
     where con.conrelid = 'public.question_usage'::regclass
       and con.contype = 'p'),
    'user_id,day'

  -- 合格：profiles (id) への外部キーで on delete cascade（c）、match simple（s）
  union all
  select 14,
    'post: question_usage foreign keys',
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
     where con.conrelid = 'public.question_usage'::regclass
       and con.contype = 'f'),
    'question_usage_user_id_fkey: (user_id) -> profiles (id) on delete c match s'

  -- 合格：CHECK ((question_count >= 1))（上限の 20 は check に書かない。関数の中だけ）
  union all
  select 15,
    'post: question_usage check constraint definition',
    (select pg_get_constraintdef(con.oid)
     from pg_constraint con
     where con.conrelid = 'public.question_usage'::regclass
       and con.conname = 'question_usage_question_count_check'),
    'CHECK ((question_count >= 1))'

  -- 合格：question_usage_pkey（索引は主キーの 1 つだけ）
  union all
  select 16,
    'post: question_usage indexes',
    (select string_agg(ic.relname, ',' order by ic.relname collate "C")
     from pg_index i
     join pg_class ic on ic.oid = i.indexrelid
     where i.indrelid = 'public.question_usage'::regclass),
    'question_usage_pkey'

  -- 合格：0（外部キー用の内部トリガーを除くと、トリガーは無い）
  union all
  select 17,
    'post: question_usage non-internal triggers',
    (select count(*)
     from pg_trigger t
     where t.tgrelid = 'public.question_usage'::regclass
       and not t.tgisinternal)::text,
    '0'

  -- ---------------------------------------------------------
  -- RLS とポリシー（中身は [DETAIL] D2・D6）
  -- ---------------------------------------------------------

  -- 合格：rls=true,force=false
  --       （force が true だと、表の持ち主の関数も RLS に止められて、回数を数えられない）
  union all
  select 20,
    'post: question_usage RLS enabled / not forced',
    (select 'rls=' || cl.relrowsecurity::text || ',force=' || cl.relforcerowsecurity::text
     from pg_class cl
     where cl.oid = 'public.question_usage'::regclass),
    'rls=true,force=false'

  -- 合格：0（ポリシーは無い。読み書きは関数からだけ）
  union all
  select 21,
    'post: policies on question_usage',
    (select count(*)
     from pg_policies pol
     where pol.schemaname = 'public'
       and pol.tablename = 'question_usage')::text,
    '0'

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
  -- 表の権限（MAINTAIN も含めて has_table_privilege で見る。付いている分だけ並ぶ）
  -- 40〜47・50〜57・60 は PRE と同じ。48・58・61 は question_usage（3 つのロールとも none）
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
    (47, 'project_chunks',       'SELECT,INSERT,UPDATE,DELETE'),
    (48, 'question_usage',       'none')
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
    (57, 'project_chunks',       'SELECT,INSERT,DELETE'),
    (58, 'question_usage',       'none')
  ) as v(n, tbl, expected)

  -- 合格：none（PRE と同じ）
  union all
  select 60,
    'anon table privileges on the 8 tables',
    (select coalesce(string_agg(v.tbl || ':' || t.pr, ',' order by v.o, t.o), 'none')
     from unnest(array['profiles','projects','project_files','stripe_events',
                       'organizations','organization_members',
                       'project_notes','project_chunks']) with ordinality as v(tbl, o)
     cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'])
          with ordinality as t(pr, o)
     where has_table_privilege('anon'::name, to_regclass('public.' || v.tbl), t.pr)),
    'none'

  -- 合格：none（anon は question_usage にも、何も無い）
  union all
  select 61,
    'anon table privileges on question_usage',
    (select coalesce(string_agg(t.pr, ',' order by t.o), 'none')
     from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'])
          with ordinality as t(pr, o)
     where has_table_privilege('anon'::name, 'public.question_usage'::regclass, t.pr)),
    'none'

  -- 合格：0（列ごとの権限が無い）
  union all
  select 62,
    'post: column-level ACLs on question_usage',
    (select count(*)
     from pg_attribute a
     where a.attrelid = 'public.question_usage'::regclass
       and a.attnum > 0 and not a.attisdropped
       and a.attacl is not null)::text,
    '0'

  -- 合格：none（表の ACL に、持ち主以外の行が無い。PUBLIC や上の 3 つ以外のロールも含めて）
  union all
  select 63,
    'post: question_usage ACL entries other than the owner',
    (select coalesce(string_agg(
       case when x.grantee = 0 then 'PUBLIC' else pg_get_userbyid(x.grantee) end || ':' || x.privilege_type,
       ',' order by x.grantee, x.privilege_type), 'none')
     from pg_class cl
     cross join lateral aclexplode(coalesce(cl.relacl, acldefault('r', cl.relowner))) x
     where cl.oid = 'public.question_usage'::regclass
       and x.grantee <> cl.relowner),
    'none'

  -- ---------------------------------------------------------
  -- 関数 consume_question_quota（中身は [DETAIL] D4）
  -- ---------------------------------------------------------

  -- 合格：1（同じ名前の関数は 1 つだけ）
  union all
  select 70,
    'post: functions named public.consume_question_quota',
    (select count(*)
     from pg_proc p
     join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public'
       and p.proname = 'consume_question_quota')::text,
    '1'

  -- 合格：true（security definer）
  union all
  select 71,
    'post: consume_question_quota prosecdef (security definer)',
    (select p.prosecdef::text from pg_proc p
     where p.oid = to_regprocedure('public.consume_question_quota()')),
    'true'

  -- 合格：search_path=""（search_path = '' が入っている）
  union all
  select 72,
    'post: consume_question_quota proconfig',
    (select array_to_string(p.proconfig, ',') from pg_proc p
     where p.oid = to_regprocedure('public.consume_question_quota()')),
    'search_path=""'

  -- 合格：plpgsql/v（言語 plpgsql・volatile）
  union all
  select 73,
    'post: consume_question_quota language / volatility',
    (select l.lanname || '/' || p.provolatile::text
     from pg_proc p
     join pg_language l on l.oid = p.prolang
     where p.oid = to_regprocedure('public.consume_question_quota()')),
    'plpgsql/v'

  -- 合格：args=0（引数なし。だれの回数かは auth.uid() で決める）
  union all
  select 74,
    'post: consume_question_quota arguments',
    (select 'args=' || p.pronargs::text from pg_proc p
     where p.oid = to_regprocedure('public.consume_question_quota()')),
    'args=0'

  -- 合格：右の文字列と同じ（返す列）
  union all
  select 75,
    'post: consume_question_quota result columns',
    pg_get_function_result(to_regprocedure('public.consume_question_quota()')),
    'TABLE(allowed boolean, remaining integer)'

  -- 合格：anon:false,authenticated:true,service_role:false
  union all
  select 76,
    'post: consume_question_quota EXECUTE by role',
    (select 'anon:' || has_function_privilege('anon'::name, f.oid, 'EXECUTE')::text
         || ',authenticated:' || has_function_privilege('authenticated'::name, f.oid, 'EXECUTE')::text
         || ',service_role:' || has_function_privilege('service_role'::name, f.oid, 'EXECUTE')::text
     from (select to_regprocedure('public.consume_question_quota()')::oid as oid) f),
    'anon:false,authenticated:true,service_role:false'

  -- 合格：0（PUBLIC への EXECUTE が無い）
  union all
  select 77,
    'post: consume_question_quota EXECUTE granted to PUBLIC',
    (select count(*)
     from pg_proc p
     cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
     where p.oid = to_regprocedure('public.consume_question_quota()')
       and x.grantee = 0
       and x.privilege_type = 'EXECUTE')::text,
    '0'

  -- 合格：true（関数の持ち主と表の持ち主が同じ。持ち主は RLS を通らないので、ポリシーなしでも書ける）
  union all
  select 78,
    'post: consume_question_quota owner = question_usage owner',
    (select (p.proowner = cl.relowner)::text
     from pg_proc p, pg_class cl
     where p.oid = to_regprocedure('public.consume_question_quota()')
       and cl.oid = 'public.question_usage'::regclass),
    'true'

  -- 参考：持ち主（postgres のはず）
  union all
  select 79,
    'info: consume_question_quota owner',
    (select pg_get_userbyid(p.proowner)::text from pg_proc p
     where p.oid = to_regprocedure('public.consume_question_quota()')),
    '(参考：postgres のはず)'

  -- 合格：true（関数の本文。定義の文字で確かめる。全文は [DETAIL] D4）
  --       上限は 20・auth.uid() で本人を決める・null なら例外・
  --       on conflict (user_id, day) do update の where で上限を見る・日は UTC
  union all
  select 80,
    'post: consume_question_quota body',
    (select (p.prosrc like '%daily_limit constant integer := 20;%'
             and p.prosrc like '%uid  uuid := auth.uid();%'
             and p.prosrc like '%if uid is null then%raise exception%'
             and p.prosrc like '%on conflict (user_id, day) do update%'
             and p.prosrc like '%where u.question_count < daily_limit%'
             and p.prosrc like '%(now() at time zone ''utc'')::date%')::text
     from pg_proc p
     where p.oid = to_regprocedure('public.consume_question_quota()')),
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

  union all
  select 98, 'count: project_notes',
    (select count(*) from public.project_notes)::text,
    '(PRE と POST で同じ)'

  union all
  select 99, 'count: project_chunks',
    (select count(*) from public.project_chunks)::text,
    '(PRE と POST で同じ)'

  -- 合格：0（新しい表はまだ空）
  union all
  select 100, 'count: question_usage',
    (select count(*) from public.question_usage)::text,
    '0'

) c
order by c.n;


-- =========================================================
-- [DETAIL] 不合格の行があったときに、1 つずつ選んで流す
-- =========================================================

-- D1（POST 10〜17 用）：question_usage の制約の定義
-- ※ 0008 を当てる前は、何も出ない
select cl.relname as table_name,
       con.conname,
       con.contype,
       pg_get_constraintdef(con.oid) as definition
from pg_constraint con
join pg_class cl on cl.oid = con.conrelid
join pg_namespace ns on ns.oid = cl.relnamespace
where ns.nspname = 'public'
  and cl.relname = 'question_usage'
order by 1, 2;

-- D2（POST 21 用）：question_usage のポリシー
-- 合格：0 行
select pol.tablename, pol.policyname, pol.permissive, pol.roles, pol.cmd, pol.qual, pol.with_check
from pg_policies pol
where pol.schemaname = 'public'
  and pol.tablename = 'question_usage'
order by 1, 2;

-- D3（PRE / POST 40〜63 用）：9 つの表の権限を、付けた役割（grantor）ごとに並べる
-- MAINTAIN も出る（information_schema には出ない）
-- POST の合格：
--   service_role … stripe_events で SELECT,INSERT、ほかの 7 表で SELECT,INSERT,UPDATE,DELETE、question_usage に行が無い
--   authenticated … 0007 の後と同じ。question_usage に行が無い
--   anon … どの表にも行が無い
--   grantor が postgres 以外の行が残っていれば、0008 の revoke では外れない（その役割で revoke する）
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
                     'project_notes', 'project_chunks', 'question_usage')
  and x.grantee in (select r.oid from pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role'))
group by cl.relname, x.grantee, x.grantor
order by 1, 2, 3;

-- D4（POST 70〜80 用）：consume_question_quota の定義と EXECUTE の権限（付けた役割ごと）
-- 合格：EXECUTE の grantee は authenticated と所有者（postgres）だけ。PUBLIC・anon・service_role の行が無い
select p.oid::regprocedure::text as function,
       pg_get_userbyid(p.proowner) as owner,
       p.prosecdef,
       p.provolatile,
       p.proconfig,
       pg_get_function_result(p.oid) as result,
       case when x.grantee = 0 then 'PUBLIC' else pg_get_userbyid(x.grantee) end as grantee,
       pg_get_userbyid(x.grantor) as grantor,
       x.privilege_type
from pg_proc p
join pg_namespace ns on ns.oid = p.pronamespace
cross join lateral aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
where ns.nspname = 'public'
  and p.proname = 'consume_question_quota'
order by 1, 7;

-- D4b（POST 80 用）：consume_question_quota の全文
select pg_get_functiondef(p.oid) as definition
from pg_proc p
join pg_namespace ns on ns.oid = p.pronamespace
where ns.nspname = 'public'
  and p.proname = 'consume_question_quota';

-- D5（POST 62 用）：question_usage の列ごとの権限
-- 合格：0 行
select a.attrelid::regclass::text as table_name, a.attname, a.attacl
from pg_attribute a
where a.attrelid = to_regclass('public.question_usage')
  and a.attnum > 0 and not a.attisdropped
  and a.attacl is not null
order by 1, 2;

-- D6（POST 20・78 用）：question_usage の RLS と、表・関数の持ち主
-- 合格：relrowsecurity = true、relforcerowsecurity = false、table_owner と function_owner が同じ
select cl.relname,
       cl.relrowsecurity,
       cl.relforcerowsecurity,
       pg_get_userbyid(cl.relowner) as table_owner,
       (select pg_get_userbyid(p.proowner) from pg_proc p
        where p.oid = to_regprocedure('public.consume_question_quota()')) as function_owner
from pg_class cl
where cl.oid = to_regclass('public.question_usage');
