@AGENTS.md

# client-portal-demo

顧客ポータルの練習用デモ。完成後は Upwork のポートフォリオに載せる。

- GitHub：kuros-works/client-portal-demo（Public）
- 本番：https://client-portal-demo-chi.vercel.app

## 機能

- マジックリンクでログイン
- 管理者（admin）とお客様（client）の役割分け
- お客様は会社（organization）単位。会社での役割は `owner`（1社に1人・支払いができる）と `staff`（閲覧だけ）。1人が入れる会社は1社だけ
  - 案件は会社のもの。同じ会社のメンバーは、その会社の案件・ファイルを見られる
  - 支払い（Checkout）はオーナーだけ。スタッフには支払いボタンを出さず、サーバー側でも拒否する
  - どの会社にも入っていないお客様は何も見えない（一覧は空、詳細は 404）
- 案件の状態：`in_progress` / `in_review` / `delivered`
- ファイル受け渡し（非公開 Storage・期限付きダウンロードリンク）
- 管理画面
- スマホ対応

### やらないこと

大きなファイル、上記以外の通知メール、凝ったデザイン、Payload CMS

Stripe は案件ごとの請求（1案件1請求・usd）だけ。月額・分割払い・返金は扱わない

- メール通知（Resend・英語・テキスト）は 2 つだけ：管理者がステータスを変えたらその会社のメンバー全員へ（1人ずつ送る）、Stripe の支払い完了で管理者へ（本文に会社名とオーナーのメール）
  - 送信は `src/lib/email.ts`。`after()` の中で呼び、失敗しても本体（ステータス更新・Webhook）は失敗させない（例外を投げず、ログはエラー名だけ）
  - 環境変数：`RESEND_API_KEY`、`NOTIFY_FROM_EMAIL`、`ADMIN_NOTIFY_EMAIL`（管理者の通知先は固定）
  - ステータスが実際に変わったときだけ送る。支払いメールは、その Webhook で `paid` にできたときだけ送る

## 技術

- Next.js 16（App Router・`src/` ディレクトリ）、React 19、TypeScript
- Tailwind CSS v4、shadcn/ui（UI 部品は `src/components/ui/`）
- Supabase（Auth・Postgres・Storage）
- Vercel

## コマンド

- `pnpm dev`：開発サーバー
- `pnpm build`：本番ビルド
- `pnpm lint`：ESLint

## テーブル設計

定義は `supabase/migrations/`（0001 が初期設定、0002 が Storage ポリシーの修正、0003 が案件ごとの請求の準備、0004 が権限の締め直し、0005 が会社単位への切り替え、0006 が projects.client_id の削除と service_role の権限の締め直し）。本番に当てる前と後の確認・戻し方は `supabase/sql/`（`0005_verify.sql`・`0005_rollback.sql`・`0006_verify.sql`・`0006_rollback.sql`）。

- **profiles**：id、email、name、role、created_at
  - id は auth.users(id) への外部キー（削除時は連動して削除）
  - email は必須、name は任意
  - role は `admin` / `client` のどちらか（初期値 `client`）
  - auth.users に行が増えると、トリガー（`on_auth_user_created`）が role = `client` で自動作成する
  - role は anon・authenticated からは変えられない（トリガー `profiles_prevent_role_change`。client 以外での作成も止める）。管理者への昇格は SQL Editor（postgres）で行う
- **organizations**：id、name、created_at（お客様の会社）
- **organization_members**：organization_id、user_id、role、created_at
  - 主キーは (organization_id, user_id)。organization_id は organizations(id)、user_id は profiles(id) への外部キー（どちらも `on delete cascade`）
  - role は `owner` / `staff`。オーナーは1社に1人（部分ユニークインデックス `organization_members_one_owner_idx`）。user_id も一意（1人1社）
  - 作成・変更・削除は service_role だけ（管理者の招待の Server Action が `requireAdmin()` の後に行う）
- **projects**：id、name、status、organization_id、created_at、updated_at、amount、payment_status、paid_at、stripe_session_id
  - status は `in_progress` / `in_review` / `delivered`（初期値 `in_progress`）
  - organization_id は organizations(id) への外部キー・必須（`on delete restrict`：案件が残っている間は会社を削除できない）。案件の持ち主はこの列で判定する
  - updated_at は更新時にトリガーで自動更新する
  - amount は usd のセント単位で 50 以上。null は「請求なし」
  - payment_status は `unpaid` / `paid`（初期値 `unpaid`）。`paid` なら paid_at は必須（制約）
  - stripe_session_id は一意・null 可
  - 支払い済み（`paid`）の行は、トリガー（`projects_prevent_paid_amount_change`）で amount を変えられない（service_role も同じ）
- **project_files**：id、project_id、file_name、storage_path、size、uploaded_at
  - project_id は projects(id) への外部キー（`on delete cascade`：案件を消すと行も消える。Storage の実体は消えない）
  - storage_path は一意。size は 0 以上
- **stripe_events**：event_id（主キー）、event_type、session_id、amount_total、currency、payment_status、customer_email、received_at
  - Webhook の二重処理を防ぐため、受け取ったイベントを event_id で記録する
  - RLS は有効・ポリシーなし。service_role は select / insert だけ（update・delete もできない、書き足すだけの台帳。0006 で外した）。anon・authenticated には何も与えない
- **Storage**：非公開バケット `project-files`（バケットの上限は 1 ファイル 10MB。アプリ側の上限は 4MB）
  - パスは `案件ID/<ファイルID>`（ファイルID は project_files.id と同じ）。元のファイル名は `file_name` 列に保存する
- **RLS**：6 テーブルと storage.objects で有効。作成・変更・削除・招待は管理者のみ
  - 各テーブルに「admin all」（管理者は全操作）と、お客様の閲覧用のポリシー（「client select own」など）を置く
  - お客様が見られる範囲：profiles は自分の行、organizations は自分の会社、organization_members は自分の会社のメンバーの行、projects は自分の会社の案件、project_files は自分の会社の案件のファイル（その案件の amount が null または `paid` のときだけ）。owner と staff で見られる範囲は同じ
  - Storage は、パスの先頭フォルダが自分の会社の案件ID のファイルだけ読める（0002 で `storage.objects.name` を明示する形に修正済み。0003 で project_files と同じ支払いの条件を追加）
  - 管理者の判定は `is_admin()`、会社の判定は `is_org_member(org)`・`is_org_owner(org)`（どれも security definer・`search_path = ''`・実行できるのは authenticated のみ）。organization_members のポリシーが自分自身を参照して無限ループにならないよう、判定は必ずこの関数を通す
  - 権限（0004 で「いったん revoke してから、アプリが使う分だけ grant」に整理。0005 の新しい表も同じ）：authenticated は profiles・organizations・organization_members が select だけ、projects が select と列ごとの insert / update（delete なし）、project_files が select / insert / delete。anon には何も与えない
  - service_role は profiles・projects・project_files・organizations・organization_members の select / insert / update / delete（表全体）、stripe_events は select / insert だけ。TRUNCATE・REFERENCES・TRIGGER・MAINTAIN はどの表にも無い（0006 で外した）。RLS を通らない
  - projects の列ごとの権限（authenticated）：insert は name、status、organization_id、amount / update は status、amount。payment_status・paid_at・stripe_session_id を書けるのは service_role（Webhook）だけ
  - Supabase の初期設定（default privileges）で、新しいテーブルには anon・authenticated・service_role の 3 つに全部の権限（arwdDxtm）が付く。テーブルを足すときは、0004・0006 と同じく revoke してから必要な分だけ grant する（「守るルール」参照）
  - MAINTAIN は Postgres 17 からの権限で、`information_schema` には出ない。確かめるときは `has_table_privilege` か `pg_class.relacl` を見る
  - ダッシュボードの「新規テーブルに自動で RLS」が作る `rls_auto_enable()`（event trigger 用・security definer）は migrations に書き起こさない。0004 で PUBLIC・anon・authenticated の実行権限だけ外している

## 守るルール

- パッケージ管理は pnpm のみ。npm・npx・yarn は使わない（一度だけ実行するものは `pnpm dlx`）
- `SUPABASE_SERVICE_ROLE_KEY` はサーバー側のコードだけで使う
  - `NEXT_PUBLIC_` を付けない
  - クライアントコンポーネントで読まない
  - ログに出さない
- 管理者用の Server Action と管理者用ページは、データを読み書きする前に必ず `requireAdmin()`（`src/lib/auth.ts`）を呼ぶ
- `.env.local` などの秘密情報は GitHub に載せない
- 作業は1回に1つ。変更前に「何をどのファイルで変えるか」を短く説明してから行う
- 本番の Supabase に影響する操作（SQL の実行・データ削除）は、実行前に必ず確認を取る
- 新しいライブラリを足す前に、必要か確認を取る
- 新しい表を作るときは、anon・authenticated に加えて service_role の TRUNCATE・REFERENCES・TRIGGER・MAINTAIN も revoke する。Supabase の初期設定で、新しい表ごとに全部付くため。verify-rls の `EXPECTED_SERVICE_ROLE_PRIVILEGES`（`scripts/local-seed/verify-rls.mjs`）にもその表を足す
- コミットメッセージは英語の Conventional Commits 形式（例：`feat: add magic link login`）

## 決定事項

- ログインは招待した人だけ（SQL ではなく、Supabase の設定と段階3のコードで対応）
  - Supabase の Auth 設定で新規登録（sign up）をオフにする
  - `signInWithOtp` は `shouldCreateUser: false` で呼ぶ
  - お客様の招待はサーバー側で `service_role` を使って行う。招待は2種類：「新しい会社を作ってオーナーとして招待（会社名を入力）」と「既存の会社にスタッフとして招待」。途中で失敗したら、作った会社とユーザーを消して戻す（会社に入っていないユーザーを残さない）
- 案件の作成では、管理者はお客様ではなく会社を選ぶ。オーナーのいない会社には作らない
- 最初の管理者は、Supabase の SQL Editor で手動で `profiles.role` を `admin` に変更する（本番なので実行前に確認を取る）
- Stripe の Webhook では、案件を `stripe_session_id` ではなく Checkout Session の `metadata.project_id` で特定する
- Webhook の受け口は `src/app/api/stripe/webhook/route.ts`（ログインなしで届くので、`src/proxy.ts` の matcher から除外している）
  - 先に署名を確認する（生の body・`stripe-signature`・`STRIPE_WEBHOOK_SECRET`）。確認できなければ 400 で何もしない
  - `checkout.session.completed` で `payment_status` が `paid` のときだけ処理する
  - 順番は「処理済みか確認 → 案件・金額・通貨を確認 → projects を更新 → 最後に `stripe_events` へ記録」。記録を最後にするのは、更新に失敗したまま「処理済み」にならないようにするため
  - 金額（`amount_total` が `projects.amount` と同じ）と通貨（usd）が合うときだけ `paid` にする。合わない場合、すでに `paid` の案件への 2 件目の支払い、案件が見つからない場合は、`paid` を上書きせず記録だけ残す（返金は手動）
  - 一時的な失敗は 500（Stripe が送り直す）、送り直しても変わらないものは 200 で終える
  - `projects` の `payment_status` / `paid_at` / `stripe_session_id` を書くのはこの Webhook（`service_role`）だけ
- Checkout は `allowed_payment_method_types: ["card"]` だけにする（非同期の支払い方法は Webhook が拾えないため）。`stripe` v23 では `payment_method_types` が Checkout から削除されている
- `createSignedUrl` の `download` オプションは日本語名を2回エンコードするので使わない。`download` は自分で URL に1回だけ付ける（`src/app/files/[id]/download/route.ts`）

## 進め方（7段階）

0 準備 → 1 土台 → 2 データ設計（テーブル4つと RLS） → 3 ログイン → 4 管理画面 → 5 ファイル → 6 お客様画面 → 7 確認と公開

## 現在の状態

- 段階0〜7 すべて完了
- 英語化も完了：画面の文言・メタデータ（title / description）・README・開発者向けエラー文。メールテンプレートは元から英語
- 会社単位（organizations / organization_members、owner / staff）への切り替え：0005 は 2026-11-16 に本番に適用済み・PR #9 マージ済み
- projects.client_id の削除：
  - PR #10（client_id を書かないコード）は 2026-11-18 にマージ・本番で確認済み
  - 0006（client_id の削除・service_role の権限の締め直し）はローカルで確認済み（`0006_verify.sql` の PRE / POST・rollback → 再適用）。本番はこれから。当てる前と後に `supabase/sql/0006_verify.sql` を流す
- 次は RAG（0007）
- RLS の検証は `scripts/local-seed/`（ローカルの Supabase だけ）。seed は A社（owner・staff）と B社（owner）。`verify-rls.mjs` は 279 checks（うち列の確認 37・service_role の表の権限 6）。陽性対照（`--positive-control`）は 37 checks
- 開発モードで `Date.now()` の Blocking Route 警告が残っているが、`pnpm build` は成功する
