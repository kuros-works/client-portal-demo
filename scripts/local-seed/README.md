# local-seed

RLS 検証用のテストデータを、**ローカルの Supabase だけ**に作るスクリプト。

## 使い方

```bash
pnpm supabase start -x realtime,imgproxy,mailpit,edge-runtime,logflare,vector,supavisor
pnpm supabase status -o env > .env.seed.local   # git に入らない（.gitignore の .env*）
node scripts/local-seed/seed.mjs
```

- 何度実行しても同じ結果になる。実行のたびに `@seed.test` のユーザーと、その人たちの会社・案件・ファイルを消して作り直す（後片付けは organization_id 経由）。
- `.env.seed.local` にはキーが入る。画面に表示したり、コミットしたりしない。

## 作られるデータ

- ユーザー（パスワードは全員同じローカル専用の値。`seed.mjs` の `SEED_PASSWORD`）
  - `admin@seed.test`（管理者・どの会社にも入らない）
  - `client-a@seed.test`（Company A の owner）
  - `client-a-staff@seed.test`（Company A の staff）
  - `client-b@seed.test`（Company B の owner）
- 会社 2 社（メンバー 3 行）・案件 6 件・ファイル 7 件・案件メモ（project_notes）6 行・chunk（project_chunks）13 行
- 案件は `organization_id` で会社に紐づける（`projects.client_id` は 0006 で削除済み）
- 0007（RAG 用の DB）が当たっていないと、project_notes の insert で止まる

| 案件 | 会社 | status | amount | 支払い | ファイル（お客様から） |
|---|---|---|---|---|---|
| A-1 | A | in_progress | なし | - | 見える |
| A-2 | A | in_review | 50000 | unpaid | 見えない |
| A-3 | A | delivered | 30000 | paid | 見える（2 件・日本語名あり） |
| B-1 | B | in_progress | なし | - | 見える |
| B-2 | B | delivered | 20000 | unpaid | 見えない |
| B-3 | B | in_review | 50 | paid | 見える |

### メモと chunk（RAG）

- 案件ごとにメモ 1 行。本文に目印（`CANARY-A1-NOTE` など）を入れる
- chunk は 13 行。メモ由来 7 行（A-1 だけ 2 行）と、ファイル由来 6 行（A-3 の日本語名のファイルには作らない）
- ファイル由来の chunk は、seed で作った project_files の行を指す（`(file_id, project_id)` の複合外部キー）
- 埋め込みは偽物：1024 次元で `slot` 番目だけ 1（乱数なし・毎回同じ）。`embedding_model` は `dummy-1024`
  - slot が違えばコサイン類似度は 0、同じなら 1。verify-rls はベクトルを DB から読んで検索に使う

| slot | 案件 | 出所 | 目印 | お客様から |
|---|---|---|---|---|
| 0・1 | A-1 | メモ | CANARY-A1-NOTE・CANARY-A1-NOTE-2 | 見える |
| 2 | A-1 | brief.txt | CANARY-A1-FILE-NOINVOICE | 見える |
| 3 | A-2 | メモ | CANARY-A2-NOTE | 見える（メモは未払いでも見える） |
| 4 | A-2 | draft.txt | CANARY-A2-FILE-UNPAID | 見えない |
| 5 | A-3 | メモ | CANARY-A3-NOTE | 見える |
| 6 | A-3 | report.txt | CANARY-A3-FILE-PAID | 見える |
| 7 | B-1 | メモ | CANARY-B1-NOTE | 見える |
| 8 | B-1 | brief.txt | CANARY-B1-FILE-NOINVOICE | 見える |
| 9 | B-2 | メモ | CANARY-B2-NOTE | 見える |
| 10 | B-2 | draft.txt | CANARY-B2-FILE-UNPAID | 見えない |
| 11 | B-3 | メモ | CANARY-B3-NOTE | 見える |
| 12 | B-3 | notes.txt | CANARY-B3-FILE-PAID | 見える |

見える行数：A社オーナー・A社スタッフはメモ 3・chunk 6、B社オーナーはメモ 3・chunk 5、管理者はメモ 6・chunk 13。

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

- anon・A社 owner（client-a）・A社 staff（client-a-staff）・B社 owner（client-b）・管理者の立場で、読み取り・書き込み・Storage・RPC を試し、表で PASS / FAIL を出す。
- 攻撃役は anon キー＋パスワードログインだけ。service_role は、準備・書き込み後の読み直し・このスクリプトが作った Storage の残骸の掃除にだけ使う。
- FAIL が出ても、RLS や migrations は直さない。報告だけ。
- 結果は `scripts/local-seed/reports/verify-rls-latest.md` に保存される（git 無視。キー・パスワード・トークンは書かない）。
- 終了コードは、FAIL があれば 1。
- 全部で 384 checks（0007 の前は 279）。

### RAG（0007）の確認

- メモ・chunk：自社の分だけ見えるか。未払い案件のファイル由来の chunk・他社の行が、id を指定しても 0 行か。書き込みはすべて拒否されるか。
- `match_project_chunks`：
  - 他社の支払い済みファイル由来の chunk と同じベクトルで探しても、他社の行は 0 件（自社の見える行だけが返る）。対照として、自社のベクトルなら 1 件目がその行（類似度 1）
  - `filter_project_id` に他社の案件なら 0 件、自社の未払い案件ならメモ由来の行だけ
  - 件数は 1〜10：管理者に 1000 を渡すと 10 件、0 を渡すと 1 件
  - anon は呼べない。EXECUTE は authenticated だけ（service_role は false。`has_function_privilege` で確認）
- 支払い後に見える・ファイルを消すと chunk も消える：A社にテスト用の案件（amount あり・unpaid）・ファイル 1 行・chunk 1 行を service_role で作り、未払いでは見えない → paid にすると見える → 管理者がファイルの行を消すと chunk も消える → 案件を消す。途中で失敗しても finally で消す。seed の既存データは触らない。

### 列の読み取り（SELECT）の確認

期待値は `verify-rls.mjs` の先頭の `EXPECTED_READABLE_COLUMNS`（ロールごと・テーブルごとに読めてよい列）。列が多くても少なくても FAIL。

1. 権限：`.env.seed.local` の `DB_URL` で Postgres に直接つなぎ、`information_schema.columns` の全列に `has_column_privilege`（anon・authenticated、SELECT）を当てる。表全体の権限も数える。public のテーブル・ビューが期待値の 8 つ以外にあっても FAIL。
   - 接続先のホストは `127.0.0.1` だけ（`localhost` も不可）。クエリ文字列つきの URL も止める（`guard.mjs` の `loadLocalDbConfig()`）。
   - 接続後は `default_transaction_read_only = on` にして、SELECT だけを送る。
2. 実際の読み取り：client-a・client-b・admin でログインし、各テーブルを `select *` して、返ってきた列名を比べる。読めてよい列があるテーブルで 1 行も返らなければ FAIL（確認できていないため）。anon は既存の「エラーか 0 件」の確認で見る。

### service_role の表の権限の確認

期待値は `verify-rls.mjs` の `EXPECTED_SERVICE_ROLE_PRIVILEGES`（0007 の後の形）。

- 列の確認と同じく `DB_URL` で Postgres に読み取り専用でつなぎ、public の 8 つの表それぞれに `has_table_privilege('service_role', …)` で 8 種類（SELECT・INSERT・UPDATE・DELETE・TRUNCATE・REFERENCES・TRIGGER・MAINTAIN）を当てる。MAINTAIN は `information_schema` に出ないので、この関数で見る。
- 期待値と完全に一致すれば PASS（7 つの表は SELECT・INSERT・UPDATE・DELETE、stripe_events は SELECT・INSERT だけ）。1 表で 1 件、合計 8 件。
- FAIL のときの表示：
  - `extra (should be revoked)`：外したはずの権限が残っている（0006 が当たっていない、新しい表で revoke を忘れた、など）
  - `missing (app needs it)`：アプリが使う権限が無い（Server Action・Webhook が失敗する）
- 新しい表を作ったら、期待値にその表を足す（足さないと、その表は見張られない）。
- 0006_rollback.sql で 0006 の前に戻すと、6 件とも `extra` で FAIL になることを確かめてある。

### 陽性対照（列の確認が FAIL を出せるかの確認）

```bash
node scripts/local-seed/verify-rls.mjs --positive-control                  # 既定：projects.stripe_session_id
node scripts/local-seed/verify-rls.mjs --positive-control=profiles.email   # 対象の列を指定
```

- 期待値の写しから指定の列を抜き、存在しない列 `__control_missing__` を足して、列の確認だけを走らせる。本物の期待値は変えない。
- 対象のテーブルでは「抜いた列が extra、足した列が missing として検出された」ときだけ PASS。検出できなければ FAIL（終了コード 1）。ほかのテーブルは通常どおりの判定。
- 結果は `reports/verify-rls-control.md` に保存する（`verify-rls-latest.md` は上書きしない）。
- 全部で 49 checks（0007 の前は 37。表が 8 つになり、列の権限で +4、4 人の読み取りで +8）。

### RAG の陽性対照（ポリシーをわざと緩めて、FAIL が出るかの確認）

`positive-control/` の SQL で、ローカルの DB の project_chunks「client select own」ポリシーを一時的に壊し、verify-rls が FAIL を出せることを確かめる。**ローカル専用**。

- `run-sql.mjs`：SQL ファイルを `.env.seed.local` の `DB_URL` に流す。接続先は 127.0.0.1:54322 だけで、流す前に表示する。`pnpm supabase db ...`（リンク先に向くもの）は使わない
- どの SQL も先頭で、seed のユーザー（`admin@seed.test`）がいない DB では止まる

| ファイル | すること |
|---|---|
| `qual.sql` | 今のポリシーの式（qual）を表示する（select だけ） |
| `break-a.sql` | A：`using (true)`（全社・全部見える） |
| `break-b.sql` | B：会社の条件だけ残し、支払いの条件を外す |
| `restore.sql` | 0007_rag.sql と同じ式に戻す |

```bash
R=scripts/local-seed/positive-control
node $R/run-sql.mjs $R/qual.sql          # 1. 式を控える
node $R/run-sql.mjs $R/break-a.sql       # 2. A を流す
node scripts/local-seed/verify-rls.mjs   #    → 32 FAIL / 352 PASS（終了コード 1）
node $R/run-sql.mjs $R/restore.sql       # 3. 戻す
node $R/run-sql.mjs $R/qual.sql          #    → 1. と文字まで同じ
node $R/run-sql.mjs $R/break-b.sql       # 4. B を流す
node scripts/local-seed/verify-rls.mjs   #    → 25 FAIL / 359 PASS（終了コード 1）
node $R/run-sql.mjs $R/restore.sql       # 5. 戻す
node $R/run-sql.mjs $R/qual.sql          #    → 1. と文字まで同じ
node scripts/local-seed/verify-rls.mjs   #    → 384 PASS / FAIL 0 に戻る
```

- A（32 FAIL）：テナント 3 人 × 9 件（chunk の select・id 指定・埋め込み・他社のベクトルでの検索・未払いのベクトル・filter 2 種・match_count 1000）と、テスト用の案件での 5 件（未払いの select・rpc × A社 2 人、他社からの select）。書き込み拒否・管理者・anon・列の確認は PASS のまま
- B（25 FAIL）：テナント 3 人 × 6 件（chunk の select・未払いの id 指定・埋め込み・未払いのベクトル・filter 自社の未払い・match_count 1000）と、テスト用の案件の未払いの select・rpc × A社 2 人の 4 件、他社のベクトルでの検索（#4）の 3 件。他社に関わるテストは PASS のまま
  - #4 は B では「他社の行 0 件」は守られ、自社の見えない行が混ざって FAIL する。A社の 2 人は自社の行が 7 行あって 6 件しか返らず、類似度 0 の同点の並び順しだいで PASS もありうる（そのときは 23〜24 FAIL）。B社は必ず FAIL
- 壊すのは SELECT のポリシーだけなので、verify-rls の書き込みのテストは壊している間も拒否される。テスト用の案件も finally で消すので、最後の data unchanged は identical のまま
- 途中で止まったら、必ず `restore.sql` を流してから `qual.sql` と verify-rls で元どおりかを確かめる

### テストでデータが変わってしまったとき

書き込みの検証が破れてデータが変わった場合は、seed.mjs で作り直せる。

```bash
node scripts/local-seed/seed.mjs
```
