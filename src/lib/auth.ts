import { redirect } from "next/navigation";
import { cache } from "react";

import { createClient } from "@/lib/supabase/server";

export type OrgRole = "owner" | "staff";

export type CurrentUser = {
  userId: string;
  role: "admin" | "client";
  // お客様のときだけ入る。どの会社にも入っていなければ null（何も見えない）
  organizationId: string | null;
  orgRole: OrgRole | null;
};

// ログインしていなければ追い返し、自分の ID と役割を返す。
// 役割が読めない場合は、権限の少ない client として扱う。
// お客様の場合は、所属する会社（1 人 1 社）と会社での役割も返す。
export const requireUser = cache(async (): Promise<CurrentUser> => {
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

  if (role === "admin") {
    return { userId, role, organizationId: null, orgRole: null };
  }

  // 読めない・入っていない場合は、会社なし（何も見えない）として扱う
  const { data: membership, error: membershipError } = await supabase
    .from("organization_members")
    .select("organization_id, role")
    .eq("user_id", userId)
    .maybeSingle();

  if (membershipError) {
    console.error("membership lookup failed:", membershipError.code);
  }

  if (
    !membership ||
    (membership.role !== "owner" && membership.role !== "staff")
  ) {
    return { userId, role, organizationId: null, orgRole: null };
  }

  return {
    userId,
    role,
    organizationId: membership.organization_id,
    orgRole: membership.role,
  };
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
