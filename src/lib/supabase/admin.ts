import "server-only";

import { createClient } from "@supabase/supabase-js";

import { requireAdmin } from "@/lib/auth";

import { getSupabaseEnv } from "./env";

// service_role のクライアントを作る。RLS を通らないので、export しない。
// 外からは、下の 2 つの関数のどちらかを通してだけ受け取れる。
function createServiceRoleClient() {
  const { url } = getSupabaseEnv();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!serviceRoleKey) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY is not set. Add it to .env.local (in production, to Vercel's Environment Variables).",
    );
  }

  return createClient(url, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}

// 管理者用の Server Action 向け。requireAdmin() で管理者を確認してから、
// service_role のクライアントを返す（管理者でなければ追い返す）。
export async function requireAdminClient() {
  await requireAdmin();
  return createServiceRoleClient();
}

// Stripe の Webhook 専用。ログインなしで届くので requireAdmin() は使えず、
// 代わりに署名の確認（src/app/api/stripe/webhook/route.ts）が通ったあとでだけ呼ぶこと。
// それ以外の場所から呼んではいけない。
export function getWebhookAdminClient() {
  return createServiceRoleClient();
}
