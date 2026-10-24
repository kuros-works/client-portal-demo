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
- Supabase（Auth・Postgres・Storage）※未導入
- Vercel

## コマンド

- `pnpm dev`：開発サーバー
- `pnpm build`：本番ビルド
- `pnpm lint`：ESLint

## テーブル設計（予定）

- **profiles**：id（auth.users と同じ）、email、name、role（`admin` / `client`）
- **projects**：id、name、status、client_id → profiles、created_at
- **project_files**：id、project_id → projects、file_name、storage_path、size、uploaded_at
- **Storage**：非公開バケット。パスは `案件ID/ファイル名`
- **RLS**：管理者は全件。お客様は自分の案件とそのファイルだけ閲覧可。作成・変更・削除・招待は管理者のみ

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

## 進め方（7段階）

0 準備 → 1 土台 → 2 データ設計（テーブル3つと RLS） → 3 ログイン → 4 管理画面 → 5 ファイル → 6 お客様画面 → 7 確認と公開

## 現在の状態

- 段階1：Next.js 作成・shadcn/ui 初期設定・GitHub push・Vercel 公開まで完了
- 段階3：マジックリンクでのログインを実装。ローカルで動作確認済み。Vercel 本番は未確認
- 開発モードで `Date.now()` の Blocking Route 警告が残っているが、`pnpm build` は成功する
