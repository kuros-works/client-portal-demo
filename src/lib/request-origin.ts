import "server-only";

import { headers } from "next/headers";

// リクエストの origin（例 https://example.com）を返す。
// 戻り先 URL（ログインのリンク・Checkout の success / cancel）に使う。
export async function getRequestOrigin() {
  const headersList = await headers();
  const host = headersList.get("x-forwarded-host") ?? headersList.get("host");
  const proto =
    headersList.get("x-forwarded-proto") ??
    (host?.startsWith("localhost") ? "http" : "https");

  return `${proto}://${host}`;
}
