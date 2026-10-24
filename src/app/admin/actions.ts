"use server";

import { requireAdmin } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";

export type InviteState = {
  status: "idle" | "invited" | "invalid" | "exists" | "error";
};

export async function inviteClient(
  _prevState: InviteState,
  formData: FormData,
): Promise<InviteState> {
  await requireAdmin();

  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();
  if (!email || !email.includes("@")) {
    return { status: "invalid" };
  }

  const supabase = createAdminClient();
  const { error } = await supabase.auth.admin.createUser({
    email,
    email_confirm: true,
  });

  if (error) {
    // メールアドレスや鍵は出さず、エラーコードだけ残す
    console.error("createUser failed:", error.code ?? error.status);
    return { status: error.code === "email_exists" ? "exists" : "error" };
  }

  return { status: "invited" };
}
