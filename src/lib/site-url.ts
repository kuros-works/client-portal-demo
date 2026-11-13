import "server-only";

// サイトの origin（例 https://example.com）を、固定の環境変数 SITE_URL から返す。
// 戻り先 URL（ログインのリンク・Checkout の success / cancel・メール内のリンク）に使う。
// リクエストヘッダーは偽装できるので使わない。未設定ならエラーにする。
export function getSiteUrl() {
  const siteUrl = process.env.SITE_URL?.trim().replace(/\/+$/, "");
  if (!siteUrl) {
    throw new Error(
      "SITE_URL is not set. Set it to the site's origin (e.g. https://example.com) in the server environment.",
    );
  }
  return siteUrl;
}
