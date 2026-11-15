-- =========================================================
-- 0005_verify：migration 0005（organizations）を本番に当てる前と後の確認
--
-- ・select だけ。書き込みは一切しない
-- ・Supabase の SQL Editor は最後の文の結果しか表示しないので、
--   セクションごとに範囲を選んで実行する
--     [PRE]    0005 を当てる直前に流す
--     [POST]   0005 を当てた直後に流す
--     [DETAIL] どこかが不合格だったときに、原因を探すために流す
-- ・結果の列：n（順番）/ check_name / actual（実際の値）/ expected（期待する値）/ ok
--     ok = true  … 合格
--     ok = false … 不合格（expected と actual を見比べる）
--     ok = null  … 目で見比べる行（expected がかっこ書き。合否を出す行の expected はかっこで始めない）
-- ・件数と案件の指紋（md5）は、PRE と POST で同じ check_name の行に出る。
--   2 つの結果を並べて、actual が同じなら合格
--   - PRE と POST の間に招待・案件の作成・ファイルの追加・支払いがあると、ずれる。続けて流すこと
--   - 指紋は updated_at を文字にしたものを含むので、同じ SQL Editor（同じタイムゾーン）で流すこと
-- ・ロールバックした後に [PRE] をもう一度流すと、0004 の状態に戻ったかを確認できる
-- =========================================================


-- =========================================================
-- [PRE] 0005 を当てる直前に流す
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
  -- 0004 まで当たっていること
  -- ---------------------------------------------------------

  -- 合格：true（0004 で作ったトリガーがある）
  select 1 as n,
    'pre: 0004 trigger profiles_prevent_role_change exists'::text as check_name,
    (exists (
      select 1 from pg_trigger t
      where t.tgrelid = 'public.profiles'::regclass
        and t.tgname = 'profiles_prevent_role_change'
    ))::text as actual,
    'true'::text as expected

  -- 合格：amount,client_id,name,status（0004 の列ごとの insert。organization_id はまだ無い）
  union all
  select 2,
    'pre: authenticated INSERT columns on projects',
    (select string_agg(a.attname, ',' order by a.attname)
     from pg_attribute a
     where a.attrelid = 'public.projects'::regclass
       and a.attnum > 0 and not a.attisdropped
       and has_column_privilege('authenticated'::name, a.attrelid, a.attnum, 'INSERT')),
    'amount,client_id,name,status'

  -- 合格：amount,status（0004 の列ごとの update）
  union all
  select 3,
    'pre: authenticated UPDATE columns on projects',
    (select string_agg(a.attname, ',' order by a.attname)
     from pg_attribute a
     where a.attrelid = 'public.projects'::regclass
       and a.attnum > 0 and not a.attisdropped
       and has_column_privilege('authenticated'::name, a.attrelid, a.attnum, 'UPDATE')),
    'amount,status'

  -- ---------------------------------------------------------
  -- 0005 で作るものが、まだ無いこと
  -- ---------------------------------------------------------

  -- 合格：true（表 organizations が無い）
  union all
  select 10,
    'pre: table public.organizations does not exist',
    (to_regclass('public.organizations') is null)::text,
    'true'

  -- 合格：true（表 organization_members が無い）
  union all
  select 11,
    'pre: table public.organization_members does not exist',
    (to_regclass('public.organization_members') is null)::text,
    'true'

  -- 合格：true（projects.organization_id が無い）
  union all
  select 12,
    'pre: column projects.organization_id does not exist',
    (not exists (
      select 1 from pg_attribute a
      where a.attrelid = 'public.projects'::regclass
        and a.attname = 'organization_id'
        and not a.attisdropped
    ))::text,
    'true'

  -- 合格：true（インデックス projects_organization_id_idx が無い）
  union all
  select 13,
    'pre: index public.projects_organization_id_idx does not exist',
    (to_regclass('public.projects_organization_id_idx') is null)::text,
    'true'

  -- 合格：0（public に is_org_member / is_org_owner という名前の関数が無い。引数違いも含む）
  union all
  select 14,
    'pre: functions is_org_member / is_org_owner do not exist',
    (select count(*)
     from pg_proc p
     join pg_namespace ns on ns.oid = p.pronamespace
     where ns.nspname = 'public'
       and p.proname in ('is_org_member', 'is_org_owner'))::text,
    '0'

  -- 合格：true（projects のお客様向けポリシーが、まだ client_id で判定している＝0001 の形）
  union all
  select 15,
    'pre: policy "projects: client select own" uses client_id',
    (select pol.qual like '%client_id%'
     from pg_policies pol
     where pol.schemaname = 'public' and pol.tablename = 'projects'
       and pol.policyname = 'projects: client select own')::text,
    'true'

  -- 合格：true（project_files のお客様向けポリシーが client_id ＋支払いの条件＝0003 の形）
  union all
  select 16,
    'pre: policy "project_files: client select own" uses client_id + payment',
    (select pol.qual like '%client_id%' and pol.qual like '%payment_status%'
     from pg_policies pol
     where pol.schemaname = 'public' and pol.tablename = 'project_files'
       and pol.policyname = 'project_files: client select own')::text,
    'true'

  -- 合格：true（storage のお客様向けポリシーが client_id ＋支払いの条件＝0003 の形）
  union all
  select 17,
    'pre: policy "project-files: client select own" (storage) uses client_id + payment',
    (select pol.qual like '%client_id%' and pol.qual like '%payment_status%'
     from pg_policies pol
     where pol.schemaname = 'storage' and pol.tablename = 'objects'
       and pol.policyname = 'project-files: client select own')::text,
    'true'

  -- ---------------------------------------------------------
  -- 0005 が途中で失敗しないこと
  -- ---------------------------------------------------------

  -- 合格：0（client_id が null の案件が無い。0004 までは not null なので必ず 0 のはず）
  union all
  select 20,
    'pre: projects with client_id null',
    (select count(*) from public.projects p where p.client_id is null)::text,
    '0'

  -- 合格：0（client_id が client 以外＝admin などの案件が無い。
  --        1 件でもあると、0005 の organization_id の not null で失敗して全体が取り消される。
  --        中身は [DETAIL] D1 で見る）
  union all
  select 21,
    'pre: projects whose client_id is not a client profile',
    (select count(*)
     from public.projects p
     left join public.profiles pr on pr.id = p.client_id
     where pr.role is distinct from 'client')::text,
    '0'

  -- 参考：0 でなくても失敗はしない。同じ名前（メールアドレス）の会社が複数できるだけ
  union all
  select 22,
    'info: duplicated emails among client profiles',
    (select count(*) from (
       select pr.email
       from public.profiles pr
       where pr.role = 'client'
       group by pr.email
       having count(*) > 1
     ) d)::text,
    '(参考。0 でなくても可)'

  -- ---------------------------------------------------------
  -- 件数と案件の指紋（POST の同じ check_name の行と見比べる）
  -- ---------------------------------------------------------

  union all
  select 90, 'count: profiles (all)',
    (select count(*) from public.profiles)::text,
    '(PRE と POST で同じ)'

  -- この数が、POST で作られる会社の数・オーナーの数になる
  union all
  select 91, 'count: profiles (client)',
    (select count(*) from public.profiles where role = 'client')::text,
    '(PRE と POST で同じ)'

  union all
  select 92, 'count: profiles (admin)',
    (select count(*) from public.profiles where role = 'admin')::text,
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

  -- 案件の id・client_id・updated_at を id 順につないだ md5。
  -- 0005 は client_id も updated_at も変えないので、PRE と同じなら合格
  union all
  select 97, 'fingerprint: projects (id, client_id, updated_at)',
    (select md5(coalesce(string_agg(
       p.id::text || '|' || coalesce(p.client_id::text, '-') || '|' || p.updated_at::text,
       ',' order by p.id), ''))
     from public.projects p),
    '(PRE と POST で同じ)'

) c
order by c.n;


-- =========================================================
-- [POST] 0005 を当てた直後に流す
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
  -- 表と列
  -- ---------------------------------------------------------

  -- 合格：右の文字列と同じ（列の名前・型・not null）
  select 1 as n,
    'post: organizations columns'::text as check_name,
    (select string_agg(
       a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
         || case when a.attnotnull then ' not null' else '' end,
       ', ' order by a.attnum)
     from pg_attribute a
     where a.attrelid = to_regclass('public.organizations')
       and a.attnum > 0 and not a.attisdropped) as actual,
    'id uuid not null, name text not null, created_at timestamp with time zone not null'::text as expected

  -- 合格：id=gen_random_uuid(), created_at=now()（初期値）
  union all
  select 2,
    'post: organizations defaults',
    (select string_agg(a.attname || '=' || pg_get_expr(d.adbin, d.adrelid), ', ' order by a.attnum)
     from pg_attrdef d
     join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
     where d.adrelid = to_regclass('public.organizations')),
    'id=gen_random_uuid(), created_at=now()'

  -- 合格：右の文字列と同じ
  union all
  select 3,
    'post: organization_members columns',
    (select string_agg(
       a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
         || case when a.attnotnull then ' not null' else '' end,
       ', ' order by a.attnum)
     from pg_attribute a
     where a.attrelid = to_regclass('public.organization_members')
       and a.attnum > 0 and not a.attisdropped),
    'organization_id uuid not null, user_id uuid not null, role text not null, created_at timestamp with time zone not null'

  -- 合格：created_at=now()
  union all
  select 4,
    'post: organization_members defaults',
    (select string_agg(a.attname || '=' || pg_get_expr(d.adbin, d.adrelid), ', ' order by a.attnum)
     from pg_attrdef d
     join pg_attribute a on a.attrelid = d.adrelid and a.attnum = d.adnum
     where d.adrelid = to_regclass('public.organization_members')),
    'created_at=now()'

  -- 合格：uuid not null（organization_id が追加され、not null になっている）
  union all
  select 5,
    'post: projects.organization_id type / not null',
    (select format_type(a.atttypid, a.atttypmod) || case when a.attnotnull then ' not null' else '' end
     from pg_attribute a
     where a.attrelid = 'public.projects'::regclass
       and a.attname = 'organization_id' and not a.attisdropped),
    'uuid not null'

  -- 合格：uuid（client_id は残っていて、not null が外れている）
  union all
  select 6,
    'post: projects.client_id type / nullable',
    (select format_type(a.atttypid, a.atttypmod) || case when a.attnotnull then ' not null' else '' end
     from pg_attribute a
     where a.attrelid = 'public.projects'::regclass
       and a.attname = 'client_id' and not a.attisdropped),
    'uuid'

  -- ---------------------------------------------------------
  -- 制約とインデックス
  -- ---------------------------------------------------------

  -- 合格：PRIMARY KEY (organization_id, user_id)
  union all
  select 10,
    'post: organization_members primary key',
    (select pg_get_constraintdef(con.oid)
     from pg_constraint con
     where con.conrelid = to_regclass('public.organization_members')
       and con.conname = 'organization_members_pkey'),
    'PRIMARY KEY (organization_id, user_id)'

  -- 合格：UNIQUE (user_id)（1 人 1 社）
  union all
  select 11,
    'post: organization_members unique user_id',
    (select pg_get_constraintdef(con.oid)
     from pg_constraint con
     where con.conrelid = to_regclass('public.organization_members')
       and con.conname = 'organization_members_user_id_key'),
    'UNIQUE (user_id)'

  -- 合格：true（CHECK 制約がちょうど 1 つあり、'owner' と 'staff' を含む。定義の全文は [DETAIL] D3）
  union all
  select 12,
    'post: organization_members role check (owner / staff)',
    (select count(*) = 1
            and bool_and(pg_get_constraintdef(con.oid) like '%''owner''%'
                     and pg_get_constraintdef(con.oid) like '%''staff''%'
                     and pg_get_constraintdef(con.oid) like '%role%')
     from pg_constraint con
     where con.conrelid = to_regclass('public.organization_members')
       and con.contype = 'c')::text,
    'true'

  -- 合格：organizations / c（会社を消すと所属も消える：on delete cascade）
  union all
  select 13,
    'post: FK organization_members.organization_id',
    (select rc.relname::text || ' / ' || con.confdeltype::text
     from pg_constraint con
     join pg_attribute a on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
     join pg_class rc on rc.oid = con.confrelid
     where con.contype = 'f'
       and con.conrelid = to_regclass('public.organization_members')
       and a.attname = 'organization_id'),
    'organizations / c'

  -- 合格：profiles / c（プロフィールを消すと所属も消える：on delete cascade）
  union all
  select 14,
    'post: FK organization_members.user_id',
    (select rc.relname::text || ' / ' || con.confdeltype::text
     from pg_constraint con
     join pg_attribute a on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
     join pg_class rc on rc.oid = con.confrelid
     where con.contype = 'f'
       and con.conrelid = to_regclass('public.organization_members')
       and a.attname = 'user_id'),
    'profiles / c'

  -- 合格：organizations / r（案件がある会社は消せない：on delete restrict）
  union all
  select 15,
    'post: FK projects.organization_id',
    (select rc.relname::text || ' / ' || con.confdeltype::text
     from pg_constraint con
     join pg_attribute a on a.attrelid = con.conrelid and a.attnum = con.conkey[1]
     join pg_class rc on rc.oid = con.confrelid
     where con.contype = 'f'
       and con.conrelid = 'public.projects'::regclass
       and a.attname = 'organization_id'),
    'organizations / r'

  -- 合格：true（一意・organization_id の 1 列・条件が role = 'owner'＝オーナーは 1 社に 1 人）
  union all
  select 16,
    'post: index organization_members_one_owner_idx (unique, where owner)',
    (select i.indisunique
            and i.indnatts = 1
            and a.attname = 'organization_id'
            and i.indrelid = to_regclass('public.organization_members')
            and pg_get_expr(i.indpred, i.indrelid) like '%role = ''owner''%'
     from pg_index i
     join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
     where i.indexrelid = to_regclass('public.organization_members_one_owner_idx'))::text,
    'true'

  -- 合格：true（projects(organization_id) のインデックス）
  union all
  select 17,
    'post: index projects_organization_id_idx on projects(organization_id)',
    (select i.indrelid = 'public.projects'::regclass
            and i.indnatts = 1
            and a.attname = 'organization_id'
     from pg_index i
     join pg_attribute a on a.attrelid = i.indrelid and a.attnum = i.indkey[0]
     where i.indexrelid = to_regclass('public.projects_organization_id_idx'))::text,
    'true'

  -- ---------------------------------------------------------
  -- 関数（security definer・search_path の固定・stable・戻り値・実行権限）
  -- ---------------------------------------------------------

  -- 合格：true（security definer・stable・boolean を返す・search_path="" に固定。
  --        proconfig の中身は [DETAIL] D5）
  union all
  select 20,
    'post: is_org_member(uuid) definer / stable / search_path',
    (select p.prosecdef
            and p.provolatile = 's'
            and p.prorettype = 'boolean'::regtype
            and 'search_path=""' = any (coalesce(p.proconfig, '{}'))
     from pg_proc p
     where p.oid = to_regprocedure('public.is_org_member(uuid)'))::text,
    'true'

  -- 合格：authenticated=true anon=false public=false
  union all
  select 21,
    'post: is_org_member(uuid) EXECUTE privileges',
    (select 'authenticated=' || has_function_privilege('authenticated'::name, p.oid, 'EXECUTE')::text
         || ' anon=' || has_function_privilege('anon'::name, p.oid, 'EXECUTE')::text
         || ' public=' || exists (
              select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
              where x.grantee = 0 and x.privilege_type = 'EXECUTE')::text
     from pg_proc p
     where p.oid = to_regprocedure('public.is_org_member(uuid)')),
    'authenticated=true anon=false public=false'

  -- 合格：true（20 と同じ）
  union all
  select 22,
    'post: is_org_owner(uuid) definer / stable / search_path',
    (select p.prosecdef
            and p.provolatile = 's'
            and p.prorettype = 'boolean'::regtype
            and 'search_path=""' = any (coalesce(p.proconfig, '{}'))
     from pg_proc p
     where p.oid = to_regprocedure('public.is_org_owner(uuid)'))::text,
    'true'

  -- 合格：authenticated=true anon=false public=false
  union all
  select 23,
    'post: is_org_owner(uuid) EXECUTE privileges',
    (select 'authenticated=' || has_function_privilege('authenticated'::name, p.oid, 'EXECUTE')::text
         || ' anon=' || has_function_privilege('anon'::name, p.oid, 'EXECUTE')::text
         || ' public=' || exists (
              select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) x
              where x.grantee = 0 and x.privilege_type = 'EXECUTE')::text
     from pg_proc p
     where p.oid = to_regprocedure('public.is_org_owner(uuid)')),
    'authenticated=true anon=false public=false'

  -- ---------------------------------------------------------
  -- トリガー（0005 は新しく作らない。途中で止めた updated_at のトリガーが戻っていること）
  -- ---------------------------------------------------------

  -- 合格：O（有効）。D なら止まったまま
  union all
  select 30,
    'post: trigger projects_set_updated_at enabled',
    (select t.tgenabled::text
     from pg_trigger t
     where t.tgrelid = 'public.projects'::regclass
       and t.tgname = 'projects_set_updated_at'),
    'O'

  -- 合格：0（projects のトリガーで、止まっているものが無い）
  union all
  select 31,
    'post: disabled triggers on projects',
    (select count(*)
     from pg_trigger t
     where t.tgrelid = 'public.projects'::regclass
       and not t.tgisinternal
       and t.tgenabled = 'D')::text,
    '0'

  -- ---------------------------------------------------------
  -- RLS の有効化
  -- ---------------------------------------------------------

  -- 合格：true
  union all
  select 40,
    'post: RLS enabled on organizations',
    (select cl.relrowsecurity from pg_class cl where cl.oid = to_regclass('public.organizations'))::text,
    'true'

  -- 合格：true
  union all
  select 41,
    'post: RLS enabled on organization_members',
    (select cl.relrowsecurity from pg_class cl where cl.oid = to_regclass('public.organization_members'))::text,
    'true'

  -- ---------------------------------------------------------
  -- ポリシー（qual の全文は [DETAIL] D4）
  -- ---------------------------------------------------------

  -- 合格：2（admin all と client select own の 2 つだけ）
  union all
  select 50,
    'post: policy count on organizations',
    (select count(*) from pg_policies pol
     where pol.schemaname = 'public' and pol.tablename = 'organizations')::text,
    '2'

  -- 合格：true（ALL・authenticated・using と with check が is_admin()）
  union all
  select 51,
    'post: policy "organizations: admin all"',
    (select pol.cmd = 'ALL'
            and pol.roles = array['authenticated']::name[]
            and pol.qual like '%is_admin()%'
            and pol.with_check like '%is_admin()%'
     from pg_policies pol
     where pol.schemaname = 'public' and pol.tablename = 'organizations'
       and pol.policyname = 'organizations: admin all')::text,
    'true'

  -- 合格：true（SELECT・authenticated・is_org_member(id)）
  union all
  select 52,
    'post: policy "organizations: client select own"',
    (select pol.cmd = 'SELECT'
            and pol.roles = array['authenticated']::name[]
            and pol.qual like '%is_org_member(id)%'
     from pg_policies pol
     where pol.schemaname = 'public' and pol.tablename = 'organizations'
       and pol.policyname = 'organizations: client select own')::text,
    'true'

  -- 合格：2
  union all
  select 53,
    'post: policy count on organization_members',
    (select count(*) from pg_policies pol
     where pol.schemaname = 'public' and pol.tablename = 'organization_members')::text,
    '2'

  -- 合格：true（ALL・authenticated・using と with check が is_admin()）
  union all
  select 54,
    'post: policy "organization_members: admin all"',
    (select pol.cmd = 'ALL'
            and pol.roles = array['authenticated']::name[]
            and pol.qual like '%is_admin()%'
            and pol.with_check like '%is_admin()%'
     from pg_policies pol
     where pol.schemaname = 'public' and pol.tablename = 'organization_members'
       and pol.policyname = 'organization_members: admin all')::text,
    'true'

  -- 合格：true（SELECT・authenticated・is_org_member(organization_id)。自分自身の表を直接読まない）
  union all
  select 55,
    'post: policy "organization_members: client select same org"',
    (select pol.cmd = 'SELECT'
            and pol.roles = array['authenticated']::name[]
            and pol.qual like '%is_org_member(organization_id)%'
     from pg_policies pol
     where pol.schemaname = 'public' and pol.tablename = 'organization_members'
       and pol.policyname = 'organization_members: client select same org')::text,
    'true'

  -- 合格：2（projects は admin all と client select own の 2 つのまま）
  union all
  select 56,
    'post: policy count on projects',
    (select count(*) from pg_policies pol
     where pol.schemaname = 'public' and pol.tablename = 'projects')::text,
    '2'

  -- 合格：true（会社で判定し、client_id を使っていない）
  union all
  select 57,
    'post: policy "projects: client select own" uses is_org_member',
    (select pol.cmd = 'SELECT'
            and pol.roles = array['authenticated']::name[]
            and pol.qual like '%is_org_member(organization_id)%'
            and pol.qual not like '%client_id%'
     from pg_policies pol
     where pol.schemaname = 'public' and pol.tablename = 'projects'
       and pol.policyname = 'projects: client select own')::text,
    'true'

  -- 合格：2
  union all
  select 58,
    'post: policy count on project_files',
    (select count(*) from pg_policies pol
     where pol.schemaname = 'public' and pol.tablename = 'project_files')::text,
    '2'

  -- 合格：true（会社で判定・支払いの条件が残っている・client_id を使っていない）
  union all
  select 59,
    'post: policy "project_files: client select own" uses is_org_member + payment',
    (select pol.cmd = 'SELECT'
            and pol.roles = array['authenticated']::name[]
            and pol.qual like '%is_org_member(%'
            and pol.qual like '%amount IS NULL%'
            and pol.qual like '%payment_status%'
            and pol.qual not like '%client_id%'
     from pg_policies pol
     where pol.schemaname = 'public' and pol.tablename = 'project_files'
       and pol.policyname = 'project_files: client select own')::text,
    'true'

  -- 合格：2（storage.objects の project-files 用は admin all と client select own の 2 つ）
  union all
  select 60,
    'post: policy count on storage.objects (project-files:*)',
    (select count(*) from pg_policies pol
     where pol.schemaname = 'storage' and pol.tablename = 'objects'
       and pol.policyname like 'project-files:%')::text,
    '2'

  -- 合格：true（バケット・会社で判定・支払いの条件が残っている・client_id を使っていない）
  union all
  select 61,
    'post: policy "project-files: client select own" (storage) uses is_org_member + payment',
    (select pol.cmd = 'SELECT'
            and pol.roles = array['authenticated']::name[]
            and pol.qual like '%project-files%'
            and pol.qual like '%is_org_member(%'
            and pol.qual like '%amount IS NULL%'
            and pol.qual like '%payment_status%'
            and pol.qual not like '%client_id%'
     from pg_policies pol
     where pol.schemaname = 'storage' and pol.tablename = 'objects'
       and pol.policyname = 'project-files: client select own')::text,
    'true'

  -- ---------------------------------------------------------
  -- 権限（grant）
  -- ---------------------------------------------------------

  -- 合格：SELECT（authenticated は見るだけ。TRUNCATE なども無い）
  union all
  select 70,
    'post: authenticated table privileges on organizations',
    (select coalesce(string_agg(t.pr, ',' order by t.o), 'none')
     from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'])
          with ordinality as t(pr, o)
     where has_table_privilege('authenticated'::name, to_regclass('public.organizations'), t.pr)),
    'SELECT'

  -- 合格：SELECT
  union all
  select 71,
    'post: authenticated table privileges on organization_members',
    (select coalesce(string_agg(t.pr, ',' order by t.o), 'none')
     from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'])
          with ordinality as t(pr, o)
     where has_table_privilege('authenticated'::name, to_regclass('public.organization_members'), t.pr)),
    'SELECT'

  -- 合格：none（anon には何も無い）
  union all
  select 72,
    'post: anon table privileges on organizations',
    (select coalesce(string_agg(t.pr, ',' order by t.o), 'none')
     from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'])
          with ordinality as t(pr, o)
     where has_table_privilege('anon'::name, to_regclass('public.organizations'), t.pr)),
    'none'

  -- 合格：none
  union all
  select 73,
    'post: anon table privileges on organization_members',
    (select coalesce(string_agg(t.pr, ',' order by t.o), 'none')
     from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'])
          with ordinality as t(pr, o)
     where has_table_privilege('anon'::name, to_regclass('public.organization_members'), t.pr)),
    'none'

  -- 合格：true（service_role に select / insert / update / delete がそろっている。
  --        Supabase の初期設定でこれ以外が付いていても不合格にはしない）
  union all
  select 74,
    'post: service_role has SELECT/INSERT/UPDATE/DELETE on organizations',
    (select bool_and(has_table_privilege('service_role'::name, to_regclass('public.organizations'), t.pr))
     from unnest(array['SELECT','INSERT','UPDATE','DELETE']) as t(pr))::text,
    'true'

  -- 合格：true
  union all
  select 75,
    'post: service_role has SELECT/INSERT/UPDATE/DELETE on organization_members',
    (select bool_and(has_table_privilege('service_role'::name, to_regclass('public.organization_members'), t.pr))
     from unnest(array['SELECT','INSERT','UPDATE','DELETE']) as t(pr))::text,
    'true'

  -- 合格：SELECT（projects の表全体の権限は 0004 のまま select だけ）
  union all
  select 76,
    'post: authenticated table privileges on projects',
    (select coalesce(string_agg(t.pr, ',' order by t.o), 'none')
     from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'])
          with ordinality as t(pr, o)
     where has_table_privilege('authenticated'::name, 'public.projects'::regclass, t.pr)),
    'SELECT'

  -- 合格：amount,client_id,name,organization_id,status（organization_id が足されている）
  union all
  select 77,
    'post: authenticated INSERT columns on projects',
    (select string_agg(a.attname, ',' order by a.attname)
     from pg_attribute a
     where a.attrelid = 'public.projects'::regclass
       and a.attnum > 0 and not a.attisdropped
       and has_column_privilege('authenticated'::name, a.attrelid, a.attnum, 'INSERT')),
    'amount,client_id,name,organization_id,status'

  -- 合格：amount,status（update は 0004 のまま。organization_id は変えられない）
  union all
  select 78,
    'post: authenticated UPDATE columns on projects',
    (select string_agg(a.attname, ',' order by a.attname)
     from pg_attribute a
     where a.attrelid = 'public.projects'::regclass
       and a.attnum > 0 and not a.attisdropped
       and has_column_privilege('authenticated'::name, a.attrelid, a.attnum, 'UPDATE')),
    'amount,status'

  -- ---------------------------------------------------------
  -- 既存データの移しかえ（失敗したら [DETAIL] D1・D2 で中身を見る）
  -- ---------------------------------------------------------

  -- 合格：true（会社の数 ＝ client の人数。下の count 行にも両方の数を出す）
  union all
  select 80,
    'post: organizations count = client profiles count',
    ((select count(*) from public.organizations)
       = (select count(*) from public.profiles where role = 'client'))::text,
    'true'

  -- 合格：true（所属の数 ＝ 会社の数）
  union all
  select 81,
    'post: organization_members count = organizations count',
    ((select count(*) from public.organization_members)
       = (select count(*) from public.organizations))::text,
    'true'

  -- 合格：0（移しかえ直後は全員オーナー。スタッフはまだいない）
  union all
  select 82,
    'post: members whose role is not owner',
    (select count(*) from public.organization_members m where m.role <> 'owner')::text,
    '0'

  -- 合格：0（どの会社のオーナーにもなっていない client がいない）
  union all
  select 83,
    'post: client profiles that are not an owner',
    (select count(*)
     from public.profiles pr
     where pr.role = 'client'
       and not exists (
         select 1 from public.organization_members m
         where m.user_id = pr.id and m.role = 'owner'
       ))::text,
    '0'

  -- 合格：0（admin など client 以外は、どの会社にも入っていない）
  union all
  select 84,
    'post: members whose profile is not a client',
    (select count(*)
     from public.organization_members m
     join public.profiles pr on pr.id = m.user_id
     where pr.role <> 'client')::text,
    '0'

  -- 合格：0（オーナーのいない会社が無い）
  union all
  select 85,
    'post: organizations without an owner',
    (select count(*)
     from public.organizations o
     where not exists (
       select 1 from public.organization_members m
       where m.organization_id = o.id and m.role = 'owner'
     ))::text,
    '0'

  -- 合格：0（会社名 ＝ オーナーのメールアドレス。当てた直後だけ成り立つ）
  union all
  select 86,
    'post: organizations whose name is not the owner email',
    (select count(*)
     from public.organizations o
     join public.organization_members m on m.organization_id = o.id and m.role = 'owner'
     join public.profiles pr on pr.id = m.user_id
     where o.name is distinct from pr.email)::text,
    '0'

  -- 合格：0（全部の案件が会社に結びついている）
  union all
  select 87,
    'post: projects with organization_id null',
    (select count(*) from public.projects p where p.organization_id is null)::text,
    '0'

  -- 合格：0（全部の案件で organization_id ＝ client_id の人がオーナーの会社）
  union all
  select 88,
    'post: projects whose organization is not the client_id owner''s',
    (select count(*)
     from public.projects p
     where not exists (
       select 1 from public.organization_members m
       where m.user_id = p.client_id
         and m.organization_id = p.organization_id
         and m.role = 'owner'
     ))::text,
    '0'

  -- 合格：0（client_id は残っている。移しかえで消えていない）
  union all
  select 89,
    'post: projects with client_id null',
    (select count(*) from public.projects p where p.client_id is null)::text,
    '0'

  -- ---------------------------------------------------------
  -- 件数と案件の指紋（PRE の同じ check_name の行と見比べる）
  -- ---------------------------------------------------------

  union all
  select 90, 'count: profiles (all)',
    (select count(*) from public.profiles)::text,
    '(PRE と POST で同じ)'

  union all
  select 91, 'count: profiles (client)',
    (select count(*) from public.profiles where role = 'client')::text,
    '(PRE と POST で同じ)'

  union all
  select 92, 'count: profiles (admin)',
    (select count(*) from public.profiles where role = 'admin')::text,
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
  select 97, 'fingerprint: projects (id, client_id, updated_at)',
    (select md5(coalesce(string_agg(
       p.id::text || '|' || coalesce(p.client_id::text, '-') || '|' || p.updated_at::text,
       ',' order by p.id), ''))
     from public.projects p),
    '(PRE と POST で同じ)'

  -- POST だけの行：PRE の「count: profiles (client)」と同じ数になっていれば合格
  union all
  select 98, 'count: organizations (POST only)',
    (select count(*) from public.organizations)::text,
    '(PRE の count: profiles (client) と同じ)'

  union all
  select 99, 'count: organization_members (POST only)',
    (select count(*) from public.organization_members)::text,
    '(PRE の count: profiles (client) と同じ)'

) c
order by c.n;


-- =========================================================
-- [DETAIL] 不合格の行があったときに、1 つずつ選んで流す
-- =========================================================

-- D1（PRE 21 / POST 88 用）：client_id が client ではない案件、または会社が client_id のオーナーの会社と違う案件
-- 合格：0 行
-- ※ POST の前に流すと organization_id の列が無いのでエラーになる。PRE では D1-pre を使う
-- D1-pre
select p.id, p.name, p.client_id, pr.email, pr.role
from public.projects p
left join public.profiles pr on pr.id = p.client_id
where pr.role is distinct from 'client'
order by p.created_at;

-- D1-post
select p.id, p.name, p.client_id, p.organization_id,
       m.organization_id as client_owner_org, m.role as client_member_role
from public.projects p
left join public.organization_members m on m.user_id = p.client_id
where m.organization_id is distinct from p.organization_id
   or m.role is distinct from 'owner'
order by p.created_at;

-- D2（POST 80〜86 用）：client と所属の対応。会社に入っていない client、client 以外のメンバーなど
-- 合格：全行で role = client・member_role = owner・org_name = email
select pr.id, pr.email, pr.role,
       m.organization_id, m.role as member_role, o.name as org_name
from public.profiles pr
full join public.organization_members m on m.user_id = pr.id
left join public.organizations o on o.id = m.organization_id
where pr.role = 'client' or m.user_id is not null
order by pr.email;

-- D3（POST 10〜17 用）：新しい表と projects.organization_id まわりの制約・インデックスの定義
select cl.relname as table_name, con.conname, pg_get_constraintdef(con.oid) as definition
from pg_constraint con
join pg_class cl on cl.oid = con.conrelid
join pg_namespace ns on ns.oid = cl.relnamespace
where ns.nspname = 'public'
  and (cl.relname in ('organizations', 'organization_members')
       or (cl.relname = 'projects' and pg_get_constraintdef(con.oid) like '%organization_id%'))
union all
select tablename, indexname, indexdef
from pg_indexes
where schemaname = 'public'
  and indexname in ('organization_members_one_owner_idx', 'projects_organization_id_idx')
order by 1, 2;

-- D4（PRE 15〜17 / POST 50〜61 用）：関係するポリシーの全文
select schemaname, tablename, policyname, cmd, roles, qual, with_check
from pg_policies
where (schemaname = 'public'
       and tablename in ('organizations', 'organization_members', 'projects', 'project_files'))
   or (schemaname = 'storage' and tablename = 'objects' and policyname like 'project-files:%')
order by schemaname, tablename, policyname;

-- D5（POST 20〜23 用）：関数の設定と実行権限（is_admin も並べて比べる）
select p.oid::regprocedure as function,
       p.prosecdef as security_definer,
       p.provolatile as volatility,
       p.proconfig as config,
       p.proacl as acl
from pg_proc p
join pg_namespace ns on ns.oid = p.pronamespace
where ns.nspname = 'public'
  and p.proname in ('is_admin', 'is_org_member', 'is_org_owner')
order by 1;

-- D6（POST 70〜78 用）：新しい表と projects の権限の一覧
select table_name, grantee, string_agg(privilege_type, ',' order by privilege_type) as privileges
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name in ('organizations', 'organization_members', 'projects')
  and grantee in ('anon', 'authenticated', 'service_role')
group by table_name, grantee
union all
select table_name || '.' || column_name, grantee, string_agg(privilege_type, ',' order by privilege_type)
from information_schema.column_privileges
where table_schema = 'public'
  and table_name = 'projects'
  and grantee = 'authenticated'
group by table_name, column_name, grantee
order by 1, 2;
