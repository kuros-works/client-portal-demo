# local-seed

RLS 検証用のテストデータを、**ローカルの Supabase だけ**に作るスクリプト。

## 使い方

```bash
pnpm supabase start -x realtime,imgproxy,mailpit,edge-runtime,logflare,vector,supavisor
pnpm supabase status -o env > .env.seed.local   # git に入らない（.gitignore の .env*）
node scripts/local-seed/seed.mjs
```

- 何度実行しても同じ結果になる。実行のたびに `@seed.test` のユーザーと、その案件・ファイルを消して作り直す。
- `.env.seed.local` にはキーが入る。画面に表示したり、コミットしたりしない。

## 作られるデータ

- ユーザー（パスワードは全員同じローカル専用の値。`seed.mjs` の `SEED_PASSWORD`）
  - `admin@seed.test`（管理者）
  - `client-a@seed.test`（Company A）
  - `client-b@seed.test`（Company B）
- 案件 6 件・ファイル 7 件

| 案件 | お客様 | status | amount | 支払い | ファイル（お客様から） |
|---|---|---|---|---|---|
| A-1 | A | in_progress | なし | - | 見える |
| A-2 | A | in_review | 50000 | unpaid | 見えない |
| A-3 | A | delivered | 30000 | paid | 見える（2 件・日本語名あり） |
| B-1 | B | in_progress | なし | - | 見える |
| B-2 | B | delivered | 20000 | unpaid | 見えない |
| B-3 | B | in_review | 50 | paid | 見える |

## 安全策（guard.mjs）

- 読むのは `.env.seed.local` だけ。`.env.local` と `process.env` は読まない。
- `API_URL` のホストが `127.0.0.1` か `localhost` でなければ、何もせず終了する。
- キーは、JWT 形式（`iss` が `supabase-demo` の service_role）か `sb_secret_` 形式のときだけ通す。
- ローカル Supabase が応答しなければ終了する。
- すべての通信の直前にも、ホストを確認する。
- 消すのは `@seed.test` のユーザーに紐づくものだけ。

## verify-rls.mjs（RLS の検証）

先に seed.mjs でテストデータを作ってから実行する。

```bash
node scripts/local-seed/verify-rls.mjs
```

- anon・会社A・会社B・管理者の立場で、読み取り・書き込み・Storage・RPC を試し、表で PASS / FAIL を出す。
- 攻撃役は anon キー＋パスワードログインだけ。service_role は、準備・書き込み後の読み直し・このスクリプトが作った Storage の残骸の掃除にだけ使う。
- FAIL が出ても、RLS や migrations は直さない。報告だけ。
- 結果は `scripts/local-seed/reports/verify-rls-latest.md` に保存される（git 無視。キー・パスワード・トークンは書かない）。
- 終了コードは、FAIL があれば 1。

### 列の読み取り（SELECT）の確認

期待値は `verify-rls.mjs` の先頭の `EXPECTED_READABLE_COLUMNS`（ロールごと・テーブルごとに読めてよい列）。列が多くても少なくても FAIL。

1. 権限：`.env.seed.local` の `DB_URL` で Postgres に直接つなぎ、`information_schema.columns` の全列に `has_column_privilege`（anon・authenticated、SELECT）を当てる。表全体の権限も数える。public のテーブル・ビューが期待値の 4 つ以外にあっても FAIL。
   - 接続先のホストは `127.0.0.1` だけ（`localhost` も不可）。クエリ文字列つきの URL も止める（`guard.mjs` の `loadLocalDbConfig()`）。
   - 接続後は `default_transaction_read_only = on` にして、SELECT だけを送る。
2. 実際の読み取り：client-a・client-b・admin でログインし、各テーブルを `select *` して、返ってきた列名を比べる。読めてよい列があるテーブルで 1 行も返らなければ FAIL（確認できていないため）。anon は既存の「エラーか 0 件」の確認で見る。

### 陽性対照（列の確認が FAIL を出せるかの確認）

```bash
node scripts/local-seed/verify-rls.mjs --positive-control                  # 既定：projects.stripe_session_id
node scripts/local-seed/verify-rls.mjs --positive-control=profiles.email   # 対象の列を指定
```

- 期待値の写しから指定の列を抜き、存在しない列 `__control_missing__` を足して、列の確認だけを走らせる。本物の期待値は変えない。
- 対象のテーブルでは「抜いた列が extra、足した列が missing として検出された」ときだけ PASS。検出できなければ FAIL（終了コード 1）。ほかのテーブルは通常どおりの判定。
- 結果は `reports/verify-rls-control.md` に保存する（`verify-rls-latest.md` は上書きしない）。

### テストでデータが変わってしまったとき

書き込みの検証が破れてデータが変わった場合は、seed.mjs で作り直せる。

```bash
node scripts/local-seed/seed.mjs
```
