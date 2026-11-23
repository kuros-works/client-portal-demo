-- =========================================================
-- 0010_verify：migration 0010（Storage のお客様向けポリシーに project_files の行の条件を足す）を
-- 本番に当てる前と後の確認
--
-- ・select だけ。書き込みは一切しない
-- ・Supabase の SQL Editor は最後の文の結果しか表示しないので、
--   セクションごとに範囲を選んで実行する
--     [PRE]    0010 を当てる直前に流す
--     [POST]   0010 を当てた直後に流す
--     [DETAIL] どこかが不合格だったときに、原因を探すために流す
-- ・結果の列：n（順番）/ check_name / actual（実際の値）/ expected（期待する値）/ ok
--     ok = true  … 合格
--     ok = false … 不合格（expected と actual を見比べる）
--     ok = null  … 目で見比べる行（expected がかっこ書き。合否を出す行の expected はかっこで始めない）
-- ・バケットの実体の数・行の無い実体の数・project_files の件数と指紋（md5）・admin all の式の md5 は、
--   PRE と POST で同じ check_name の行に出る。2 つの結果を並べて、actual が同じなら合格
--   - PRE と POST の間にファイルの追加・削除があると、ずれる。続けて流すこと
--   - 指紋は uploaded_at を文字にしたものを含むので、同じ SQL Editor（同じタイムゾーン）で流すこと
-- ・「行の無い実体」は、project-files バケットの実体のうち、同じ storage_path の project_files の行が
--   無いもの（行を消した後に Storage の削除だけ失敗したもの）。0 でなくても不合格ではない。
--   0010 の後は、お客様からは読めなくなる（管理者は読める・消せる）。中身は [DETAIL] D2
-- ・ポリシーの式に文字が入っているかは strpos で見る（like は使わない）。like の _ は任意の 1 文字なので、
--   '%project_files%' はバケット名の 'project-files' にも当たってしまう
-- ・名前の並びは collate "C"（文字コード順）でそろえる
-- ・ロールバックした後に [PRE] をもう一度流すと、0009 の後の状態に戻ったかを確認できる
-- =========================================================


-- =========================================================
-- [PRE] 0010 を当てる直前に流す
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
  -- 0009 まで当たっていること
  -- ---------------------------------------------------------

  -- 合格：true（0009 の表がある）
  select 1 as n,
    'pre: 0009 applied (project_file_ingests exists)'::text as check_name,
    (to_regclass('public.project_file_ingests') is not null)::text as actual,
    'true'::text as expected

  -- 合格：true（ポリシーで使う is_org_member(uuid)・is_admin() がある）
  union all
  select 2,
    'pre: functions public.is_org_member(uuid) / public.is_admin() exist',
    (to_regprocedure('public.is_org_member(uuid)') is not null
       and to_regprocedure('public.is_admin()') is not null)::text,
    'true'

  -- 合格：true（ポリシーで使う project_files.storage_path がある）
  union all
  select 3,
    'pre: column project_files.storage_path exists',
    (exists (
      select 1 from pg_attribute a
      where a.attrelid = 'public.project_files'::regclass
        and a.attname = 'storage_path' and a.attnum > 0 and not a.attisdropped
    ))::text,
    'true'

  -- ---------------------------------------------------------
  -- storage.objects のポリシー（0005 の形。中身は [DETAIL] D1）
  -- ---------------------------------------------------------

  -- 合格：右の文字列と同じ（project-files のポリシーは 2 つ）
  union all
  select 10,
    'storage.objects project-files policies (name | permissive | cmd | roles)',
    (select coalesce(string_agg(
       pol.policyname || ' | ' || pol.permissive || ' | ' || pol.cmd || ' | '
         || array_to_string(pol.roles, ','),
       '; ' order by pol.policyname collate "C"), 'none')
     from pg_policies pol
     where pol.schemaname = 'storage'
       and pol.tablename = 'objects'
       and pol.policyname like 'project-files:%'),
    'project-files: admin all | PERMISSIVE | ALL | authenticated; '
      || 'project-files: client select own | PERMISSIVE | SELECT | authenticated'

  -- 合格：true（client select own は 0005 の形。project_files は見ていない）
  union all
  select 11,
    'pre: client select own qual is the 0005 form (no project_files)',
    (select (strpos(pol.qual, 'project_files') = 0
             and strpos(pol.qual, 'is_org_member') > 0
             and strpos(pol.qual, 'payment_status') > 0)::text
     from pg_policies pol
     where pol.schemaname = 'storage' and pol.tablename = 'objects'
       and pol.policyname = 'project-files: client select own'),
    'true'

  -- ---------------------------------------------------------
  -- 件数と指紋（POST の同じ check_name の行と見比べる）
  -- ---------------------------------------------------------

  -- admin all の式（using / with check）の md5。0010 は admin all を変えないので、PRE と同じなら合格
  union all
  select 80, 'fingerprint: admin all qual / with_check',
    (select md5(coalesce(pol.qual, '-') || '|' || coalesce(pol.with_check, '-'))
     from pg_policies pol
     where pol.schemaname = 'storage' and pol.tablename = 'objects'
       and pol.policyname = 'project-files: admin all'),
    '(PRE と POST で同じ)'

  union all
  select 90, 'count: storage objects in project-files',
    (select count(*) from storage.objects o where o.bucket_id = 'project-files')::text,
    '(PRE と POST で同じ)'

  union all
  select 91, 'count: storage objects without a project_files row',
    (select count(*) from storage.objects o
     where o.bucket_id = 'project-files'
       and not exists (select 1 from public.project_files f where f.storage_path = o.name))::text,
    '(PRE と POST で同じ)'

  union all
  select 92, 'count: project_files',
    (select count(*) from public.project_files)::text,
    '(PRE と POST で同じ)'

  -- ファイルの全部の列を id 順につないだ md5。0010 は project_files を変えないので、PRE と同じなら合格
  union all
  select 93, 'fingerprint: project_files (id, project_id, file_name, storage_path, size, uploaded_at)',
    (select md5(coalesce(string_agg(
       f.id::text || '|' || f.project_id::text || '|' || f.file_name
         || '|' || f.storage_path || '|' || f.size::text || '|' || f.uploaded_at::text,
       ',' order by f.id), ''))
     from public.project_files f),
    '(PRE と POST で同じ)'

) c
order by c.n;


-- =========================================================
-- [POST] 0010 を当てた直後に流す
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
  -- storage.objects のポリシー（中身は [DETAIL] D1）
  -- ---------------------------------------------------------

  -- 合格：右の文字列と同じ（名前・cmd・roles は 0005 と変わらない）
  select 10 as n,
    'storage.objects project-files policies (name | permissive | cmd | roles)'::text as check_name,
    (select coalesce(string_agg(
       pol.policyname || ' | ' || pol.permissive || ' | ' || pol.cmd || ' | '
         || array_to_string(pol.roles, ','),
       '; ' order by pol.policyname collate "C"), 'none')
     from pg_policies pol
     where pol.schemaname = 'storage'
       and pol.tablename = 'objects'
       and pol.policyname like 'project-files:%') as actual,
    'project-files: admin all | PERMISSIVE | ALL | authenticated; '
      || 'project-files: client select own | PERMISSIVE | SELECT | authenticated'::text as expected

  -- 合格：true（client select own が project_files の行の storage_path を見る）
  union all
  select 11,
    'post: client select own qual checks project_files.storage_path',
    (select (strpos(pol.qual, 'project_files') > 0
             and strpos(pol.qual, 'storage_path') > 0)::text
     from pg_policies pol
     where pol.schemaname = 'storage' and pol.tablename = 'objects'
       and pol.policyname = 'project-files: client select own'),
    'true'

  -- 合格：true（会社・支払い・フォルダの条件は 0005 と同じく残っている）
  union all
  select 12,
    'post: client select own qual keeps folder / is_org_member / payment conditions',
    (select (strpos(pol.qual, 'foldername') > 0
             and strpos(pol.qual, 'is_org_member') > 0
             and strpos(pol.qual, 'payment_status') > 0
             and strpos(pol.qual, '''project-files''') > 0)::text
     from pg_policies pol
     where pol.schemaname = 'storage' and pol.tablename = 'objects'
       and pol.policyname = 'project-files: client select own'),
    'true'

  -- 合格：true（client select own は select だけなので with check は無い）
  union all
  select 13,
    'post: client select own has no with_check',
    (select (pol.with_check is null)::text
     from pg_policies pol
     where pol.schemaname = 'storage' and pol.tablename = 'objects'
       and pol.policyname = 'project-files: client select own'),
    'true'

  -- ---------------------------------------------------------
  -- 件数と指紋（PRE の同じ check_name の行と見比べる）
  -- ---------------------------------------------------------

  union all
  select 80, 'fingerprint: admin all qual / with_check',
    (select md5(coalesce(pol.qual, '-') || '|' || coalesce(pol.with_check, '-'))
     from pg_policies pol
     where pol.schemaname = 'storage' and pol.tablename = 'objects'
       and pol.policyname = 'project-files: admin all'),
    '(PRE と POST で同じ)'

  union all
  select 90, 'count: storage objects in project-files',
    (select count(*) from storage.objects o where o.bucket_id = 'project-files')::text,
    '(PRE と POST で同じ)'

  union all
  select 91, 'count: storage objects without a project_files row',
    (select count(*) from storage.objects o
     where o.bucket_id = 'project-files'
       and not exists (select 1 from public.project_files f where f.storage_path = o.name))::text,
    '(PRE と POST で同じ)'

  union all
  select 92, 'count: project_files',
    (select count(*) from public.project_files)::text,
    '(PRE と POST で同じ)'

  union all
  select 93, 'fingerprint: project_files (id, project_id, file_name, storage_path, size, uploaded_at)',
    (select md5(coalesce(string_agg(
       f.id::text || '|' || f.project_id::text || '|' || f.file_name
         || '|' || f.storage_path || '|' || f.size::text || '|' || f.uploaded_at::text,
       ',' order by f.id), ''))
     from public.project_files f),
    '(PRE と POST で同じ)'

) c
order by c.n;


-- =========================================================
-- [DETAIL] 不合格の行があったときに、1 つずつ選んで流す
-- =========================================================

-- D1（10〜13・80 用）：storage.objects の project-files のポリシーの全文
-- 合格：admin all は using / with check とも「bucket_id = 'project-files' and is_admin()」。
--       client select own は、0010 の後は project_files f と projects p を結び、
--       f.storage_path = objects.name の条件が入っている（0010 の前は projects だけ）
select pol.policyname, pol.permissive, pol.roles, pol.cmd, pol.qual, pol.with_check
from pg_policies pol
where pol.schemaname = 'storage'
  and pol.tablename = 'objects'
  and pol.policyname like 'project-files:%'
order by pol.policyname collate "C";

-- D2（91 用）：project_files の行が無い実体
-- 0010 の後はお客様から読めない。消すときは管理者が Storage から手で消す（この SQL は消さない）
select o.name, o.created_at, o.metadata ->> 'size' as size
from storage.objects o
where o.bucket_id = 'project-files'
  and not exists (select 1 from public.project_files f where f.storage_path = o.name)
order by o.name collate "C";
