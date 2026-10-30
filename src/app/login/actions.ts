"use server";

import { getRequestOrigin } from "@/lib/request-origin";
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

  const origin = await getRequestOrigin();

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: {
      shouldCreateUser: false,
      emailRedirectTo: `${origin}/auth/callback`,
    },
  });

  // 未登録でもエラーでも同じ表示にして、登録の有無が外から分からないようにする
  if (error) {
    console.error("signInWithOtp failed:", error.code ?? error.status);
  }
  return { status: "sent" };
}
