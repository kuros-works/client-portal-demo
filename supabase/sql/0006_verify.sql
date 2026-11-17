-- =========================================================
-- 0006_verify：migration 0006（client_id の削除・service_role の権限）を本番に当てる前と後の確認
--
-- ・select だけ。書き込みは一切しない
-- ・Supabase の SQL Editor は最後の文の結果しか表示しないので、
--   セクションごとに範囲を選んで実行する
--     [PRE]    0006 を当てる直前に流す
--     [POST]   0006 を当てた直後に流す
--     [DETAIL] どこかが不合格だったときに、原因を探すために流す
-- ・結果の列：n（順番）/ check_name / actual（実際の値）/ expected（期待する値）/ ok
--     ok = true  … 合格
--     ok = false … 不合格（expected と actual を見比べる）
--     ok = null  … 目で見比べる行（expected がかっこ書き。合否を出す行の expected はかっこで始めない）
-- ・件数と案件の指紋（md5）は、PRE と POST で同じ check_name の行に出る。
--   2 つの結果を並べて、actual が同じなら合格
--   - PRE と POST の間に招待・案件の作成・ファイルの追加・支払いがあると、ずれる。続けて流すこと
--   - 指紋は updated_at を文字にしたものを含むので、同じ SQL Editor（同じタイムゾーン）で流すこと
--   - 指紋には client_id を含めない（0006 で消える列なので、PRE と POST で比べられない）
-- ・権限の行は has_table_privilege で見る。MAINTAIN は information_schema に出ないため。
--   'MAINTAIN' は Postgres 17 からの名前なので、16 以下では PRE がエラーになる（0006 も当てられない）
-- ・revoke は「自分（postgres）が付けた権限」だけを外す。本番で別の役割（supabase_admin など）が
--   付けた権限があると、0006 はエラーにならずにその分が残る。POST の 40〜45 が不合格なら、
--   [DETAIL] D3 の grantor（付けた役割）を見る
-- ・ロールバックした後に [PRE] をもう一度流すと、0005 の後の状態に戻ったかを確認できる
-- =========================================================


-- =========================================================
-- [PRE] 0006 を当てる直前に流す
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
  -- Postgres の版と、0005 まで当たっていること
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

  -- 合格：uuid not null（0005 で organization_id が必須になっている）
  union all
  select 3,
    'pre: projects.organization_id type / not null',
    (select format_type(a.atttypid, a.atttypmod) || case when a.attnotnull then ' not null' else '' end
     from pg_attribute a
     where a.attrelid = 'public.projects'::regclass
       and a.attname = 'organization_id' and not a.attisdropped),
    'uuid not null'

  -- 合格：true（0005 の関数がある）
  union all
  select 4,
    'pre: 0005 functions is_org_member / is_org_owner exist',
    (to_regprocedure('public.is_org_member(uuid)') is not null
       and to_regprocedure('public.is_org_owner(uuid)') is not null)::text,
    'true'

  -- 合格：uuid（client_id はまだあり、null 可＝0005 の後の形）
  union all
  select 5,
    'pre: projects.client_id type / nullable',
    (select format_type(a.atttypid, a.atttypmod) || case when a.attnotnull then ' not null' else '' end
     from pg_attribute a
     where a.attrelid = 'public.projects'::regclass
       and a.attname = 'client_id' and not a.attisdropped),
    'uuid'

  -- ---------------------------------------------------------
  -- client_id を消しても、ほかが壊れないこと（中身は [DETAIL] D2）
  -- ---------------------------------------------------------

  -- 合格：0（client_id に依存するのは、一緒に消える外部キーとインデックスだけ）
  union all
  select 10,
    'pre: objects depending on projects.client_id (other than its FK and index)',
    (select count(*)
     from pg_depend d
     where d.refclassid = 'pg_class'::regclass
       and d.refobjid = 'public.projects'::regclass
       and d.refobjsubid = (select a.attnum from pg_attribute a
                            where a.attrelid = 'public.projects'::regclass
                              and a.attname = 'client_id' and not a.attisdropped)
       and not (d.classid = 'pg_constraint'::regclass
                and d.objid = (select con.oid from pg_constraint con
                               where con.conrelid = 'public.projects'::regclass
                                 and con.conname = 'projects_client_id_fkey'))
       and not (d.classid = 'pg_class'::regclass
                and d.objid = to_regclass('public.projects_client_id_idx')))::text,
    '0'

  -- 合格：0（public と storage のポリシーで、client_id を使うものが無い。0005 で切り替え済み）
  union all
  select 11,
    'pre: policies mentioning client_id (public / storage)',
    (select count(*)
     from pg_policies pol
     where pol.schemaname in ('public', 'storage')
       and (coalesce(pol.qual, '') like '%client_id%'
            or coalesce(pol.with_check, '') like '%client_id%'))::text,
    '0'

  -- 合格：0（public の関数の本体で client_id を使うものが無い。
  --        関数の本体は依存関係に出ないので、文字で探す）
  union all
  select 12,
    'pre: functions in public mentioning client_id',
    (select count(*)
     from pg_proc p
     join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public'
       and p.prosrc like '%client_id%')::text,
    '0'

  -- 合格：0（public のビューで client_id を使うものが無い）
  union all
  select 13,
    'pre: views in public mentioning client_id',
    (select count(*)
     from pg_class cl
     join pg_namespace ns on ns.oid = cl.relnamespace
     where ns.nspname = 'public'
       and cl.relkind in ('v', 'm')
       and pg_get_viewdef(cl.oid) like '%client_id%')::text,
    '0'

  -- ---------------------------------------------------------
  -- 今の client_id の値（消える値に、おかしなものが無いこと。中身は [DETAIL] D1）
  -- ---------------------------------------------------------

  -- 合格：0（client_id が入っている案件は、全部その会社のオーナー）
  union all
  select 20,
    'pre: projects whose client_id is set but is not the owner of its organization',
    (select count(*)
     from public.projects p
     where p.client_id is not null
       and not exists (
         select 1 from public.organization_members m
         where m.user_id = p.client_id
           and m.organization_id = p.organization_id
           and m.role = 'owner'
       ))::text,
    '0'

  -- 参考：PR #10 を出した後に作った案件は null。0 でなくても可
  union all
  select 21,
    'info: projects with client_id null',
    (select count(*) from public.projects p where p.client_id is null)::text,
    '(参考。0 でなくても可。PR #10 の後に作った案件)'

  -- ---------------------------------------------------------
  -- 列ごとの権限（authenticated の projects）
  -- ---------------------------------------------------------

  -- 合格：amount,client_id,name,organization_id,status（0005 の後の形）
  union all
  select 30,
    'authenticated INSERT columns on projects',
    (select string_agg(a.attname, ',' order by a.attname)
     from pg_attribute a
     where a.attrelid = 'public.projects'::regclass
       and a.attnum > 0 and not a.attisdropped
       and has_column_privilege('authenticated'::name, a.attrelid, a.attnum, 'INSERT')),
    'amount,client_id,name,organization_id,status'

  -- 合格：amount,status（0006 で変えない。POST の同じ行と同じ）
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
  -- ---------------------------------------------------------

  -- 合格：6 つの表すべてで全部（Supabase の初期設定のまま）
  union all
  select v.n,
    'service_role table privileges on ' || v.tbl,
    (select coalesce(string_agg(t.pr, ',' order by t.o), 'none')
     from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN'])
          with ordinality as t(pr, o)
     where has_table_privilege('service_role'::name, to_regclass('public.' || v.tbl), t.pr)),
    v.expected
  from (values
    (40, 'profiles',             'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'),
    (41, 'projects',             'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'),
    (42, 'project_files',        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'),
    (43, 'stripe_events',        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'),
    (44, 'organizations',        'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'),
    (45, 'organization_members', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
  ) as v(n, tbl, expected)

  -- 合格：0004・0005 で付けた分だけ（0006 で変えない。POST の同じ行と同じ）
  --       projects の insert / update は列ごとなので、表全体では SELECT だけ
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

  -- 合格：none（anon は 6 つの表のどれにも、何も無い。0006 で変えない）
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
  -- 0006 は行を更新しないので、PRE と同じなら合格
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
-- [POST] 0006 を当てた直後に流す
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
  -- client_id と、一緒に消えるもの
  -- ---------------------------------------------------------

  -- 合格：true（projects.client_id が無い）
  select 1 as n,
    'post: column projects.client_id does not exist'::text as check_name,
    (not exists (
      select 1 from pg_attribute a
      where a.attrelid = 'public.projects'::regclass
        and a.attname = 'client_id'
        and not a.attisdropped
    ))::text as actual,
    'true'::text as expected

  -- 合格：true（インデックス projects_client_id_idx が無い）
  union all
  select 2,
    'post: index public.projects_client_id_idx does not exist',
    (to_regclass('public.projects_client_id_idx') is null)::text,
    'true'

  -- 合格：0（projects から profiles への外部キーが無い）
  union all
  select 3,
    'post: foreign keys from projects to profiles',
    (select count(*)
     from pg_constraint con
     where con.conrelid = 'public.projects'::regclass
       and con.confrelid = 'public.profiles'::regclass
       and con.contype = 'f')::text,
    '0'

  -- 合格：uuid not null（organization_id は 0005 のまま）
  union all
  select 4,
    'post: projects.organization_id type / not null',
    (select format_type(a.atttypid, a.atttypmod) || case when a.attnotnull then ' not null' else '' end
     from pg_attribute a
     where a.attrelid = 'public.projects'::regclass
       and a.attname = 'organization_id' and not a.attisdropped),
    'uuid not null'

  -- 合格：右の文字列と同じ（projects の列。名前の順。client_id だけが無くなっている）
  union all
  select 5,
    'post: projects columns (sorted by name)',
    (select string_agg(a.attname, ',' order by a.attname)
     from pg_attribute a
     where a.attrelid = 'public.projects'::regclass
       and a.attnum > 0 and not a.attisdropped),
    'amount,created_at,id,name,organization_id,paid_at,payment_status,status,stripe_session_id,updated_at'

  -- ---------------------------------------------------------
  -- 列ごとの権限（authenticated の projects）
  -- ---------------------------------------------------------

  -- 合格：amount,name,organization_id,status（client_id が無くなっている）
  union all
  select 30,
    'authenticated INSERT columns on projects',
    (select string_agg(a.attname, ',' order by a.attname)
     from pg_attribute a
     where a.attrelid = 'public.projects'::regclass
       and a.attnum > 0 and not a.attisdropped
       and has_column_privilege('authenticated'::name, a.attrelid, a.attnum, 'INSERT')),
    'amount,name,organization_id,status'

  -- 合格：amount,status（PRE と同じ）
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
  -- ---------------------------------------------------------

  -- 合格：5 つの表は SELECT,INSERT,UPDATE,DELETE だけ。stripe_events は SELECT,INSERT だけ
  --       不合格なら [DETAIL] D3 で grantor を見る（postgres 以外が付けた権限は 0006 で外れない）
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

  -- 合格：PRE と同じ（0006 は authenticated の表の権限を変えない）
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

) c
order by c.n;


-- =========================================================
-- [DETAIL] 不合格の行があったときに、1 つずつ選んで流す
-- =========================================================

-- D1（PRE 20 用）：client_id が入っているのに、その会社のオーナーではない案件
-- 合格：0 行
-- ※ 0006 を当てた後は client_id の列が無いのでエラーになる（PRE でだけ使う）
select p.id, p.name, p.client_id, p.organization_id,
       m.organization_id as client_org, m.role as client_member_role
from public.projects p
left join public.organization_members m on m.user_id = p.client_id
where p.client_id is not null
  and (m.organization_id is distinct from p.organization_id
       or m.role is distinct from 'owner')
order by p.created_at;

-- D2（PRE 10〜13 用）：client_id に依存するもの・client_id を文字で含むもの
-- 合格：projects_client_id_fkey と projects_client_id_idx の 2 行だけ
-- ※ 0006 を当てた後は 0 行になる
select 'depend' as kind,
       d.classid::regclass::text as catalog,
       case d.classid
         when 'pg_class'::regclass then d.objid::regclass::text
         when 'pg_constraint'::regclass then (select con.conname::text from pg_constraint con where con.oid = d.objid)
         when 'pg_policy'::regclass then (select pl.polname::text from pg_policy pl where pl.oid = d.objid)
         when 'pg_rewrite'::regclass then (select rw.ev_class::regclass::text from pg_rewrite rw where rw.oid = d.objid)
         else d.objid::text
       end as object,
       d.deptype::text as detail
from pg_depend d
where d.refclassid = 'pg_class'::regclass
  and d.refobjid = 'public.projects'::regclass
  and d.refobjsubid = (select a.attnum from pg_attribute a
                       where a.attrelid = 'public.projects'::regclass
                         and a.attname = 'client_id' and not a.attisdropped)
union all
select 'policy', pol.schemaname || '.' || pol.tablename, pol.policyname, pol.cmd
from pg_policies pol
where pol.schemaname in ('public', 'storage')
  and (coalesce(pol.qual, '') like '%client_id%' or coalesce(pol.with_check, '') like '%client_id%')
union all
select 'function', ns.nspname, p.oid::regprocedure::text, ''
from pg_proc p
join pg_namespace ns on ns.oid = p.pronamespace
where ns.nspname = 'public' and p.prosrc like '%client_id%'
union all
select 'view', ns.nspname, cl.relname::text, cl.relkind::text
from pg_class cl
join pg_namespace ns on ns.oid = cl.relnamespace
where ns.nspname = 'public' and cl.relkind in ('v', 'm')
  and pg_get_viewdef(cl.oid) like '%client_id%'
order by 1, 2, 3;

-- D3（PRE / POST 40〜60 用）：6 つの表の権限を、付けた役割（grantor）ごとに並べる
-- MAINTAIN も出る（information_schema には出ない）
-- POST の合格：service_role は 5 つの表で SELECT,INSERT,UPDATE,DELETE、stripe_events で SELECT,INSERT。
--             grantor が postgres 以外の行が残っていれば、0006 では外れない（その役割で revoke する）
select cl.relname as table_name,
       pg_get_userbyid(x.grantee) as grantee,
       pg_get_userbyid(x.grantor) as grantor,
       string_agg(x.privilege_type, ',' order by x.privilege_type) as privileges
from pg_class cl
join pg_namespace ns on ns.oid = cl.relnamespace
cross join lateral aclexplode(coalesce(cl.relacl, acldefault('r', cl.relowner))) x
where ns.nspname = 'public'
  and cl.relname in ('profiles', 'projects', 'project_files', 'stripe_events',
                     'organizations', 'organization_members')
  and x.grantee in (select r.oid from pg_roles r where r.rolname in ('anon', 'authenticated', 'service_role'))
group by cl.relname, x.grantee, x.grantor
order by 1, 2, 3;

-- D4（PRE / POST 30〜31 用）：projects の列ごとの権限（authenticated）
select column_name, string_agg(privilege_type, ',' order by privilege_type) as privileges
from information_schema.column_privileges
where table_schema = 'public'
  and table_name = 'projects'
  and grantee = 'authenticated'
group by column_name
order by column_name;
