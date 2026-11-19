-- =========================================================
-- 0006_rollback：migration 0006（client_id の削除・service_role の権限）を元に戻す
-- 0006 で変えたことを、逆の順番で戻す。0005 の後と同じ形にする
--
-- ■ 注意：client_id の値は元に戻らない
--   - 戻しても client_id は「今の会社のオーナー」で埋まる。
--     0006 の前に入っていた値（作成時のオーナー）は、0006 で列ごと消えているので戻せない
--   - 0006 の前に null だった案件（PR #10 の後に作った案件・今朝作ったテスト案件など）も、
--     オーナーで埋まる
--   - オーナーのいない会社の案件は null のまま残る（件数は実行時に NOTICE で出る）
--   - client_id の列は projects の最後の列として作り直される（元は status の次）。
--     列の順番に頼るコードは無いので、動きは変わらない
--
-- ■ 実行する前に
--   - アプリのコードは戻さなくてよい（PR #10 の後のコードは client_id を読みも書きもしない）。
--     戻した後に作る案件の client_id は null になる（null 可なので問題ない）
--   - この後さらに 0005_rollback.sql を流す場合、client_id が null の案件があるとそこで止まる。
--     先に client_id を手で埋める
--   - 本番の stripe_events の service_role には、もともと UPDATE・DELETE が無かった
--     （0006 の本番の [PRE] 43 が false だった理由）。本番で rollback するときは、
--     stripe_events に UPDATE・DELETE を grant し直さないこと。
--     下の「1.」の `grant update, delete on public.stripe_events to service_role;` の 1 行を
--     消してから流す（その場合、戻した後の [PRE] 43 は、0006 を当てる前の本番と同じく false になる）
--
-- ■ このファイルがしないこと
--   - supabase_migrations.schema_migrations（CLI の履歴）には触らない。
--     0006 を CLI（supabase db push など）で当てた場合は、履歴の 0006 の行を手で直す
--   - 関数・シーケンスの初期設定（default privileges）には触らない（0006 も触っていない）
--
-- ■ 実行した後に
--   - 0006_verify.sql の [PRE] を流して、0005 の後の状態に戻ったことを確認する
--     （ok が false の行が無く、件数と指紋が 0006 を当てる前と同じなら合格。
--      client_id を埋める間は updated_at のトリガーを止めるので、指紋は変わらない。
--      [PRE] 21 の「client_id が null の案件」は、オーナーのいない会社の案件の数になる）
-- =========================================================

begin;


-- ---------------------------------------------------------
-- 0. 先に止める確認：ここで例外になれば、何も変わらずに全体が取り消される
-- ---------------------------------------------------------
do $$
begin
  -- 0006 が当たっていなければ（client_id がまだあれば）、戻すものが無い
  if exists (
    select 1 from pg_attribute a
    where a.attrelid = 'public.projects'::regclass
      and a.attname = 'client_id'
      and not a.attisdropped
  ) then
    raise exception 'rollback stopped: migration 0006 is not applied (projects.client_id still exists)';
  end if;

  -- client_id を埋めるのに、0005 の会社とメンバーが要る
  if to_regclass('public.organization_members') is null then
    raise exception 'rollback stopped: migration 0005 is not applied (organization_members is missing)';
  end if;
end
$$;


-- ---------------------------------------------------------
-- 1. service_role に、0006 で外した権限を付け直す（Supabase の初期設定の形に戻す）
-- ---------------------------------------------------------
grant update, delete on public.stripe_events to service_role;

grant truncate, references, trigger, maintain
  on public.profiles,
     public.projects,
     public.project_files,
     public.stripe_events,
     public.organizations,
     public.organization_members
  to service_role;


-- ---------------------------------------------------------
-- 2. projects.client_id を null 可で作り直す
--    外部キーは 0001 と同じく profiles への on delete restrict（名前は projects_client_id_fkey になる）
-- ---------------------------------------------------------
alter table public.projects
  add column client_id uuid references public.profiles (id) on delete restrict;

create index projects_client_id_idx on public.projects (client_id);


-- ---------------------------------------------------------
-- 3. 各案件の client_id を、その会社の今のオーナーで埋める
--    埋めるだけで updated_at を変えないよう、この更新の間だけ updated_at のトリガーを止める
--    （0005 と同じ。同じトランザクション内で戻すので、失敗しても止まったままにはならない）
--    amount は変えないので、支払い済みの行のトリガー（prevent_paid_amount_change）には当たらない
-- ---------------------------------------------------------
alter table public.projects disable trigger projects_set_updated_at;

update public.projects p
set client_id = m.user_id
from public.organization_members m
where m.organization_id = p.organization_id
  and m.role = 'owner';

alter table public.projects enable trigger projects_set_updated_at;

-- オーナーのいない会社の案件は null のまま。件数だけ知らせる
do $$
declare
  n bigint;
begin
  select count(*) into n from public.projects where client_id is null;
  if n > 0 then
    raise notice '% project(s) still have client_id null (their organization has no owner)', n;
  end if;
end
$$;


-- ---------------------------------------------------------
-- 4. authenticated の projects の insert 列に client_id を戻す（0005 の後の形）
-- ---------------------------------------------------------
grant insert (client_id) on public.projects to authenticated;


commit;
