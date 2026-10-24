import { redirect } from "next/navigation";
import { cache } from "react";

import { createClient } from "@/lib/supabase/server";

// 管理者でなければ追い返す。ページと Server Action の両方で、最初に呼ぶ。
// 役割は画面の表示ではなく、毎回 DB の profiles.role で確認する。
export const requireAdmin = cache(async () => {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const userId = data?.claims.sub;

  if (!userId) {
    redirect("/login");
  }

  const { data: profile, error } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", userId)
    .maybeSingle();

  if (error) {
    console.error("profile lookup failed:", error.code);
  }

  if (profile?.role !== "admin") {
    redirect("/");
  }

  return { userId };
});
