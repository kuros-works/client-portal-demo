"use server";

import { getSiteUrl } from "@/lib/site-url";
import { createClient } from "@/lib/supabase/server";

export type LoginState = {
  status: "idle" | "sent" | "invalid";
};

export async function sendMagicLink(
  _prevState: LoginState,
  formData: FormData,
): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim();
  if (!email || !email.includes("@")) {
    return { status: "invalid" };
  }

  // リダイレクト先はリクエストヘッダーではなく、固定の環境変数から作る
  const siteUrl = getSiteUrl();

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      shouldCreateUser: false,
      emailRedirectTo: `${siteUrl}/auth/callback`,
    },
  });

  // 未登録でもエラーでも同じ表示にして、登録の有無が外から分からないようにする
  if (error) {
    console.error("signInWithOtp failed:", error.code ?? error.status);
  }
  return { status: "sent" };
}
