@AGENTS.md

# client-portal-demo

顧客ポータルの練習用デモ。完成後は Upwork のポートフォリオに載せる。

- GitHub：kuros-works/client-portal-demo（Private）
- 本番：https://client-portal-demo-chi.vercel.app

## 機能

- マジックリンクでログイン
- 管理者（admin）とお客様（client）の役割分け
- 案件の状態：`in_progress` / `in_review` / `delivered`
- ファイル受け渡し（非公開 Storage・期限付きダウンロードリンク）
- 管理画面
- スマホ対応

### やらないこと

大きなファイル、Stripe、通知メール、凝ったデザイン、Payload CMS

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

定義は `supabase/migrations/`（0001 が初期設定、0002 が Storage ポリシーの修正、0003 が案件ごとの請求の準備）。

- **profiles**：id、email、name、role、created_at
  - id は auth.users(id) への外部キー（削除時は連動して削除）
  - email は必須、name は任意
  - role は `admin` / `client` のどちらか（初期値 `client`）
  - auth.users に行が増えると、トリガー（`on_auth_user_created`）が role = `client` で自動作成する
- **projects**：id、name、status、client_id、created_at、updated_at、amount、payment_status、paid_at、stripe_session_id
  - status は `in_progress` / `in_review` / `delivered`（初期値 `in_progress`）
  - client_id は profiles(id) への外部キー・必須（`on delete restrict`：案件が残っている間はお客様のプロフィールを削除できない）
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
  - RLS は有効・ポリシーなし。service_role だけが select / insert できる（anon・authenticated には何も与えない）
- **Storage**：非公開バケット `project-files`（バケットの上限は 1 ファイル 10MB。アプリ側の上限は 4MB）
  - パスは `案件ID/<ファイルID>`（ファイルID は project_files.id と同じ）。元のファイル名は `file_name` 列に保存する
- **RLS**：3 テーブルと storage.objects で有効。作成・変更・削除・招待は管理者のみ
  - 各テーブルに「admin all」（管理者は全操作）と「client select own」（お客様は閲覧のみ）の 2 つを置く
  - お客様が見られる範囲：profiles は自分の行、projects は `client_id` が自分の案件、project_files は自分の案件のファイル（その案件の amount が null または `paid` のときだけ）
  - Storage は、パスの先頭フォルダが自分の案件ID のファイルだけ読める（0002 で `storage.objects.name` を明示する形に修正済み。0003 で project_files と同じ支払いの条件を追加）
  - 管理者の判定は `is_admin()`（security definer・`profiles.role` を参照・実行できるのは authenticated のみ）
  - 権限：authenticated と service_role に 3 テーブルの select / insert / update / delete を付与。anon には何も与えない。service_role は RLS を通らない
  - ただし projects の insert / update は、authenticated では列ごとの権限に絞っている（insert：name、status、client_id、amount / update：status、amount）。payment_status・paid_at・stripe_session_id を書けるのは service_role（Webhook）だけ

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
- コミットメッセージは英語の Conventional Commits 形式（例：`feat: add magic link login`）

## 決定事項

- ログインは招待した人だけ（SQL ではなく、Supabase の設定と段階3のコードで対応）
  - Supabase の Auth 設定で新規登録（sign up）をオフにする
  - `signInWithOtp` は `shouldCreateUser: false` で呼ぶ
  - お客様の招待はサーバー側で `service_role` を使って行う
- 最初の管理者は、Supabase の SQL Editor で手動で `profiles.role` を `admin` に変更する（本番なので実行前に確認を取る）
- Stripe の Webhook では、案件を `stripe_session_id` ではなく Checkout Session の `metadata.project_id` で特定する
- `createSignedUrl` の `download` オプションは日本語名を2回エンコードするので使わない。`download` は自分で URL に1回だけ付ける（`src/app/files/[id]/download/route.ts`）

## 進め方（7段階）

0 準備 → 1 土台 → 2 データ設計（テーブル3つと RLS） → 3 ログイン → 4 管理画面 → 5 ファイル → 6 お客様画面 → 7 確認と公開

## 現在の状態

- 段階0〜7 すべて完了
- 英語化も完了：画面の文言・メタデータ（title / description）・README・開発者向けエラー文。メールテンプレートは元から英語
- 開発モードで `Date.now()` の Blocking Route 警告が残っているが、`pnpm build` は成功する
