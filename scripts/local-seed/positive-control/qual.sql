-- =========================================================
-- qual.sql：project_chunks の「client select own」ポリシーの式（qual）を表示する
-- ・ローカル専用（RAG の陽性対照用）。select だけで、何も変えない
-- ・壊す前に控え、戻した後にもう一度流して、文字まで同じになったことを確かめる
-- ・流し方：node scripts/local-seed/positive-control/run-sql.mjs scripts/local-seed/positive-control/qual.sql
-- =========================================================
select qual from pg_policies
where schemaname = 'public' and tablename = 'project_chunks'
  and policyname = 'project_chunks: client select own';
