import "server-only";

import { createClient } from "@supabase/supabase-js";

import { getSupabaseEnv } from "./env";

// service_role を使う管理用クライアント。RLS を通らないので、
// 呼ぶ前に必ず requireAdmin() で管理者を確認すること。
export function createAdminClient() {
  const { url } = getSupabaseEnv();
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!serviceRoleKey) {
    throw new Error(
      "SUPABASE_SERVICE_ROLE_KEY が未設定です。.env.local（本番は Vercel の Environment Variables）に設定してください。",
    );
  }

  return createClient(url, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  });
}
