"use server";

import { revalidatePath } from "next/cache";

import { requireAdmin } from "@/lib/auth";
import { MAX_FILE_SIZE, PROJECT_FILES_BUCKET } from "@/lib/project-files";
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

  revalidatePath("/admin");
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

export type UploadFormState = {
  status: "idle" | "uploaded" | "invalid" | "empty" | "too_large" | "error";
};

export async function uploadProjectFile(
  _prevState: UploadFormState,
  formData: FormData,
): Promise<UploadFormState> {
  await requireAdmin();

  // Storage のポリシーは projects.id::text（小文字）とパスを比べるので、小文字にそろえる
  const projectId = String(formData.get("project_id") ?? "").toLowerCase();
  const file = formData.get("file");

  if (!UUID_PATTERN.test(projectId) || !(file instanceof File) || !file.name) {
    return { status: "invalid" };
  }
  if (file.size === 0) {
    return { status: "empty" };
  }
  if (file.size > MAX_FILE_SIZE) {
    return { status: "too_large" };
  }

  // パスは「案件ID/ファイルID」。元のファイル名は file_name 列に残す
  const fileId = crypto.randomUUID();
  const storagePath = `${projectId}/${fileId}`;

  const supabase = await createClient();
  const { error: uploadError } = await supabase.storage
    .from(PROJECT_FILES_BUCKET)
    .upload(storagePath, file, {
      contentType: file.type || "application/octet-stream",
      upsert: false,
    });

  if (uploadError) {
    console.error("upload file failed:", uploadError.name);
    return { status: "error" };
  }

  const { error: insertError } = await supabase.from("project_files").insert({
    id: fileId,
    project_id: projectId,
    file_name: file.name,
    storage_path: storagePath,
    size: file.size,
  });

  if (insertError) {
    console.error("insert project file failed:", insertError.code);

    // 行がないファイルを残さないよう、上げたファイルを消して元に戻す
    const { data: removed, error: removeError } = await supabase.storage
      .from(PROJECT_FILES_BUCKET)
      .remove([storagePath]);
    if (removeError || !removed || removed.length === 0) {
      console.error("rollback upload failed:", storagePath);
    }

    return { status: "error" };
  }

  revalidatePath("/admin");
  return { status: "uploaded" };
}

export type DeleteFileFormState = {
  status:
    | "idle"
    | "deleted"
    | "invalid"
    | "not_found"
    | "not_deleted"
    | "error";
};

export async function deleteProjectFile(
  _prevState: DeleteFileFormState,
  formData: FormData,
): Promise<DeleteFileFormState> {
  await requireAdmin();

  const fileId = String(formData.get("file_id") ?? "");
  if (!UUID_PATTERN.test(fileId)) {
    return { status: "invalid" };
  }

  // パスはフォームから受け取らず、DB の行から読む
  const supabase = await createClient();
  const { data: file, error: selectError } = await supabase
    .from("project_files")
    .select("storage_path")
    .eq("id", fileId)
    .maybeSingle();

  if (selectError) {
    console.error("load project file failed:", selectError.code);
    return { status: "error" };
  }
  if (!file) {
    return { status: "not_found" };
  }

  // ① Storage を先に消す。失敗したら行は残し、もう一度押せばやり直せるようにする
  const { data: removed, error: removeError } = await supabase.storage
    .from(PROJECT_FILES_BUCKET)
    .remove([file.storage_path]);

  if (removeError) {
    console.error("remove file failed:", removeError.name);
    return { status: "error" };
  }
  // 0 件は、前回 ① だけ成功して ② が失敗した場合など。削除済みとして ② に進む
  if (!removed || removed.length === 0) {
    console.error("remove file affected 0 objects:", file.storage_path);
  }

  // ② 行を消す
  const { data: deleted, error: deleteError } = await supabase
    .from("project_files")
    .delete()
    .eq("id", fileId)
    .select("id");

  if (deleteError) {
    console.error("delete project file failed:", deleteError.code);
    return { status: "error" };
  }

  // RLS で弾かれた場合も、エラーにならず 0 件になる
  if (!deleted || deleted.length === 0) {
    console.error("delete project file affected 0 rows");
    return { status: "not_deleted" };
  }

  revalidatePath("/admin");
  return { status: "deleted" };
}
