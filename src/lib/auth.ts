import { redirect } from "next/navigation";
import { cache } from "react";

import { createClient } from "@/lib/supabase/server";

// ログインしていなければ追い返し、自分の ID と役割を返す。
// 役割が読めない場合は、権限の少ない client として扱う。
export const requireUser = cache(async () => {
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

  const role: "admin" | "client" =
    profile?.role === "admin" ? "admin" : "client";

  return { userId, role };
});

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
