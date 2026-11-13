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
