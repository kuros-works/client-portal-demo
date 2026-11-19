-- =========================================================
-- prosrc-c.sql：consume_question_quota の本文（prosrc）と、その md5・長さを表示する
-- ・ローカル専用（陽性対照 C 用）。select だけで、何も変えない
-- ・壊す前に控え、戻した後にもう一度流して、md5 が同じになったことを確かめる
-- ・流し方：node scripts/local-seed/positive-control/run-sql.mjs scripts/local-seed/positive-control/prosrc-c.sql
-- =========================================================
select md5(p.prosrc) as prosrc_md5,
       length(p.prosrc) as prosrc_length,
       p.prosecdef,
       p.provolatile,
       p.proconfig,
       pg_get_userbyid(p.proowner) as owner,
       p.proacl::text as acl,
       p.prosrc
from pg_proc p
where p.oid = to_regprocedure('public.consume_question_quota()');
