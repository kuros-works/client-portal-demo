"use server";

import { revalidatePath } from "next/cache";

import { requireAdmin } from "@/lib/auth";
import { isProjectStatus } from "@/lib/project-status";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

export type ProjectFormState = {
  status: "idle" | "created" | "invalid" | "error";
};

export async function createProject(
  _prevState: ProjectFormState,
  formData: FormData,
): Promise<ProjectFormState> {
  await requireAdmin();

  const name = String(formData.get("name") ?? "").trim();
  const clientId = String(formData.get("client_id") ?? "");
  const status = String(formData.get("status") ?? "");

  if (!name || !UUID_PATTERN.test(clientId)) {
    return { status: "invalid" };
  }
  // 空なら status を送らず、列の初期値に任せる
  if (status && !isProjectStatus(status)) {
    return { status: "invalid" };
  }

  const supabase = await createClient();
  const { error } = await supabase
    .from("projects")
    .insert(
      status
        ? { name, client_id: clientId, status }
        : { name, client_id: clientId },
    );

  if (error) {
    console.error("create project failed:", error.code);
    return { status: "error" };
  }

  revalidatePath("/admin");
  return { status: "created" };
}

export type StatusFormState = {
  status: "idle" | "updated" | "invalid" | "not_updated" | "error";
};

export async function updateProjectStatus(
  _prevState: StatusFormState,
  formData: FormData,
): Promise<StatusFormState> {
  await requireAdmin();

  const projectId = String(formData.get("project_id") ?? "");
  const status = String(formData.get("status") ?? "");

  if (!UUID_PATTERN.test(projectId) || !isProjectStatus(status)) {
    return { status: "invalid" };
  }

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("projects")
    .update({ status })
    .eq("id", projectId)
    .select("id");

  if (error) {
    console.error("update project status failed:", error.code);
    return { status: "error" };
  }

  // RLS で弾かれた場合も、エラーにならず 0 件になる
  if (!data || data.length === 0) {
    console.error("update project status affected 0 rows");
    return { status: "not_updated" };
  }

  revalidatePath("/admin");
  return { status: "updated" };
}
