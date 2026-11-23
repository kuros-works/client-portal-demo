"use server";

import { revalidatePath } from "next/cache";
import { after } from "next/server";

import { requireAdmin } from "@/lib/auth";
import { MAX_NOTE_LENGTH, splitIntoChunks } from "@/lib/chunk";
import { sendStatusChangedEmail } from "@/lib/email";
import { EmbeddingError, embedDocuments } from "@/lib/embeddings";
import { ingestProjectFile, type IngestResult } from "@/lib/ingest-file";
import { parseDollarsToCents } from "@/lib/project-amount";
import { MAX_FILE_SIZE, PROJECT_FILES_BUCKET } from "@/lib/project-files";
import { isProjectStatus } from "@/lib/project-status";
import { getSiteUrl } from "@/lib/site-url";
import { requireAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type InviteState = {
  status: "idle" | "invited" | "invalid" | "exists" | "not_found" | "error";
};

type AdminClient = Awaited<ReturnType<typeof requireAdminClient>>;

function readEmail(formData: FormData) {
  const email = String(formData.get("email") ?? "")
    .trim()
    .toLowerCase();
  return email && email.includes("@") ? email : null;
}

// ユーザーを作る。成功したらユーザー ID、失敗したら招待の結果を返す
async function createInvitedUser(
  supabase: AdminClient,
  email: string,
): Promise<{ userId: string } | InviteState> {
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    email_confirm: true,
  });

  if (error || !data.user) {
    // メールアドレスや鍵は出さず、エラーコードだけ残す
    console.error("createUser failed:", error?.code ?? error?.status);
    return { status: error?.code === "email_exists" ? "exists" : "error" };
  }
  return { userId: data.user.id };
}

// 途中で失敗したときの後始末。会社に入っていないユーザーを残さない
async function rollbackInvite(
  supabase: AdminClient,
  userId: string,
  organizationId?: string,
) {
  if (organizationId) {
    const { error } = await supabase
      .from("organizations")
      .delete()
      .eq("id", organizationId);
    if (error) console.error("rollback organization failed:", error.code);
  }
  // profiles と organization_members も連動して消える
  const { error } = await supabase.auth.admin.deleteUser(userId);
  if (error) console.error("rollback user failed:", error.code ?? error.status);
}

// 新しい会社を作り、その会社のオーナーとして招待する
export async function inviteOwner(
  _prevState: InviteState,
  formData: FormData,
): Promise<InviteState> {
  await requireAdmin();

  const email = readEmail(formData);
  const organizationName = String(formData.get("organization_name") ?? "").trim();
  if (!email || !organizationName) {
    return { status: "invalid" };
  }

  // 会社・メンバーの書き込みは service_role だけ（authenticated は select のみ）
  const supabase = await requireAdminClient();
  const created = await createInvitedUser(supabase, email);
  if (!("userId" in created)) {
    return created;
  }

  const { data: organization, error: orgError } = await supabase
    .from("organizations")
    .insert({ name: organizationName })
    .select("id")
    .single();
  if (orgError || !organization) {
    console.error("create organization failed:", orgError?.code);
    await rollbackInvite(supabase, created.userId);
    return { status: "error" };
  }

  const { error: memberError } = await supabase
    .from("organization_members")
    .insert({
      organization_id: organization.id,
      user_id: created.userId,
      role: "owner",
    });
  if (memberError) {
    console.error("add owner failed:", memberError.code);
    await rollbackInvite(supabase, created.userId, organization.id);
    return { status: "error" };
  }

  revalidatePath("/admin");
  return { status: "invited" };
}

// 既存の会社に、スタッフとして招待する
export async function inviteStaff(
  _prevState: InviteState,
  formData: FormData,
): Promise<InviteState> {
  await requireAdmin();

  const email = readEmail(formData);
  const organizationId = String(formData.get("organization_id") ?? "");
  if (!email || !UUID_PATTERN.test(organizationId)) {
    return { status: "invalid" };
  }

  const supabase = await requireAdminClient();

  // 先に会社があるか確かめる（ないならユーザーを作らない）
  const { data: organization, error: orgError } = await supabase
    .from("organizations")
    .select("id")
    .eq("id", organizationId)
    .maybeSingle();
  if (orgError) {
    console.error("load organization failed:", orgError.code);
    return { status: "error" };
  }
  if (!organization) {
    return { status: "not_found" };
  }

  const created = await createInvitedUser(supabase, email);
  if (!("userId" in created)) {
    return created;
  }

  const { error: memberError } = await supabase
    .from("organization_members")
    .insert({
      organization_id: organization.id,
      user_id: created.userId,
      role: "staff",
    });
  if (memberError) {
    console.error("add staff failed:", memberError.code);
    await rollbackInvite(supabase, created.userId);
    return { status: "error" };
  }

  revalidatePath("/admin");
  return { status: "invited" };
}

export type ProjectFormState = {
  status: "idle" | "created" | "invalid" | "no_owner" | "error";
};

export async function createProject(
  _prevState: ProjectFormState,
  formData: FormData,
): Promise<ProjectFormState> {
  await requireAdmin();

  const name = String(formData.get("name") ?? "").trim();
  const organizationId = String(formData.get("organization_id") ?? "");
  const status = String(formData.get("status") ?? "");

  if (!name || !UUID_PATTERN.test(organizationId)) {
    return { status: "invalid" };
  }
  // 空なら status を送らず、列の初期値に任せる
  if (status && !isProjectStatus(status)) {
    return { status: "invalid" };
  }

  const supabase = await createClient();

  // オーナーのいない会社には案件を作らない（支払える人がいないため）
  const { data: owner, error: ownerError } = await supabase
    .from("organization_members")
    .select("user_id")
    .eq("organization_id", organizationId)
    .eq("role", "owner")
    .maybeSingle();

  if (ownerError) {
    console.error("load organization owner failed:", ownerError.code);
    return { status: "error" };
  }
  if (!owner) {
    return { status: "no_owner" };
  }

  const row: {
    name: string;
    organization_id: string;
    status?: string;
  } = {
    name,
    organization_id: organizationId,
  };
  if (status) {
    row.status = status;
  }
  const { error } = await supabase.from("projects").insert(row);

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

  // 通知は「ステータスが実際に変わったとき」だけ送るので、変更前の値を読んでおく。
  // 読めなくても更新は続ける（その場合は通知しない）
  const { data: before } = await supabase
    .from("projects")
    .select("status")
    .eq("id", projectId)
    .maybeSingle();

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

  // お客様の会社のメンバー全員へのメール。失敗しても更新の結果は変えない（sendEmail は例外を投げない）
  if (before && before.status !== status) {
    // 管理者の確認は after() の外で済ませ、after() の中ではそのクライアントを使う
    const adminClient = await requireAdminClient();
    after(async () => {
      try {
        // SITE_URL が未設定でも更新は成功のまま。ここで失敗してもログだけ残す
        const siteUrl = getSiteUrl();
        const { data: project } = await adminClient
          .from("projects")
          .select("name, organization_id")
          .eq("id", projectId)
          .maybeSingle();

        if (!project) {
          console.error("status email skipped: project not found");
          return;
        }

        const { data: members, error: membersError } = await adminClient
          .from("organization_members")
          .select("profiles(email)")
          .eq("organization_id", project.organization_id);
        if (membersError) {
          console.error("status email skipped: load members failed:", membersError.code);
          return;
        }

        // 多対一の結合結果。型の上では配列にもなりうるので、どちらでもメールを取り出す
        const recipients = [
          ...new Set(
            (members ?? [])
              .map((m) => {
                const profile = Array.isArray(m.profiles)
                  ? m.profiles[0]
                  : m.profiles;
                return profile?.email;
              })
              .filter((email): email is string => Boolean(email)),
          ),
        ];
        if (recipients.length === 0) {
          console.error("status email skipped: no member emails found");
          return;
        }

        // 1 人ずつ送る（宛先どうしにメールアドレスを見せない）
        for (const to of recipients) {
          await sendStatusChangedEmail({
            to,
            projectName: project.name,
            status,
            projectUrl: `${siteUrl}/projects/${projectId}`,
          });
        }
      } catch (err) {
        console.error(
          "status email failed:",
          err instanceof Error ? err.name : "unknown",
        );
      }
    });
  }

  revalidatePath("/admin");
  return { status: "updated" };
}

export type AmountFormState = {
  status:
    | "idle"
    | "updated"
    | "cleared"
    | "invalid"
    | "too_small"
    | "paid"
    | "not_updated"
    | "error";
};

export async function updateProjectAmount(
  _prevState: AmountFormState,
  formData: FormData,
): Promise<AmountFormState> {
  await requireAdmin();

  const projectId = String(formData.get("project_id") ?? "");
  if (!UUID_PATTERN.test(projectId)) {
    return { status: "invalid" };
  }

  // 画面側の確認は信用せず、送られてきた金額をここで必ず検証し直す
  const amount = parseDollarsToCents(String(formData.get("amount") ?? ""));
  if (amount === "invalid" || amount === "too_small") {
    return { status: amount };
  }

  const supabase = await createClient();

  // 支払い済みの案件は金額を変えない（DB のトリガーでも止まるが、先に確かめる）
  const { data: project, error: selectError } = await supabase
    .from("projects")
    .select("payment_status")
    .eq("id", projectId)
    .maybeSingle();

  if (selectError) {
    console.error("load project payment status failed:", selectError.code);
    return { status: "error" };
  }
  if (!project) {
    return { status: "not_updated" };
  }
  if (project.payment_status === "paid") {
    return { status: "paid" };
  }

  const { data, error } = await supabase
    .from("projects")
    .update({ amount })
    .eq("id", projectId)
    .select("id");

  if (error) {
    console.error("update project amount failed:", error.code);
    return { status: "error" };
  }

  // RLS で弾かれた場合も、エラーにならず 0 件になる
  if (!data || data.length === 0) {
    console.error("update project amount affected 0 rows");
    return { status: "not_updated" };
  }

  revalidatePath("/admin");
  return { status: amount === null ? "cleared" : "updated" };
}

export type UploadFormState = {
  status: "idle" | "uploaded" | "invalid" | "empty" | "too_large" | "error";
  // アップロードの後の取り込みの結果（表示はステップ4）。取り込みが失敗してもアップロードは成功のまま
  ingest?: IngestResult;
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

  // 検索用に取り込む（PDF 以外は skipped・not_pdf になる）。
  // 失敗してもアップロードは取り消さない（状態は project_file_ingests に残り、あとで取り込み直せる）
  const ingest = await ingestProjectFile(fileId);

  revalidatePath("/admin");
  return { status: "uploaded", ingest };
}

export type ReingestFormState = {
  status: "idle" | "invalid" | "not_found" | "done";
  ingest?: IngestResult;
};

// 取り込み直す（失敗した・見送ったファイル、またはモデルを変えたときの作り直し）
export async function reingestProjectFile(
  _prevState: ReingestFormState,
  formData: FormData,
): Promise<ReingestFormState> {
  await requireAdmin();

  const fileId = String(formData.get("file_id") ?? "").toLowerCase();
  if (!UUID_PATTERN.test(fileId)) {
    return { status: "invalid" };
  }

  const ingest = await ingestProjectFile(fileId);
  if (ingest.status === "not_found") {
    return { status: "not_found" };
  }

  revalidatePath("/admin");
  return { status: "done", ingest };
}

export type DeleteFileFormState = {
  status:
    | "idle"
    | "deleted"
    | "invalid"
    | "not_found"
    | "not_deleted"
    // 行（と chunk・取り込みの状態）は消えたが、Storage の実体を消せなかった
    | "storage_failed"
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

  // ① 行を先に消す。chunk（project_chunks）と取り込みの状態（project_file_ingests）は cascade で消える。
  //    先に行を消すのは、Storage だけ消えて chunk が検索に残る、ということを起こさないため
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

  // ② Storage の実体を消す。失敗しても行はもう無いので、その旨を返す。
  //    Storage のお客様向けポリシーは、同じ storage_path の project_files の行があるときだけ読める
  //    （0010）ので、実体が残ってもお客様からは読めない。ただし実体はバケットに残るので、
  //    storage_failed のときは、管理者が Storage の実体を手で消す
  const { data: removed, error: removeError } = await supabase.storage
    .from(PROJECT_FILES_BUCKET)
    .remove([file.storage_path]);

  if (removeError) {
    console.error("remove file failed:", fileId, removeError.name);
    // ここでは revalidatePath を呼ばない。呼ぶと一覧からこのファイルが消え、
    // 削除フォームごと外れて警告が見えなくなるため（一覧は再読み込みで新しくなる）
    return { status: "storage_failed" };
  }

  revalidatePath("/admin");

  // 0 件は、実体がもともと無かった場合など。行は消えたので削除済みとして扱う
  if (!removed || removed.length === 0) {
    console.error("remove file affected 0 objects:", fileId);
  }

  return { status: "deleted" };
}

export type NoteFormState = {
  status:
    | "idle"
    | "saved"
    | "invalid"
    | "too_long"
    | "not_found"
    | "rate_limited"
    | "embedding_failed"
    | "error";
};

// 案件メモを保存し、検索用の chunk を入れ直す。
// 書き込みは管理者本人のセッション（createClient）だけで行う（service_role は使わない）。
// 順番：埋め込み → chunk を消す → chunk を入れる → メモを upsert。
// 埋め込みに失敗したら、何も書かない。
// 既知の制限：消す・入れる・upsert は 1 つのトランザクションではないので、
// 途中で失敗するとメモと chunk がずれることがある（次に保存し直すと直る）。
export async function saveProjectNote(
  _prevState: NoteFormState,
  formData: FormData,
): Promise<NoteFormState> {
  await requireAdmin();

  const projectId = String(formData.get("project_id") ?? "");
  if (!UUID_PATTERN.test(projectId)) {
    return { status: "invalid" };
  }

  const body = String(formData.get("body") ?? "").trim();
  if (!body) {
    return { status: "invalid" };
  }
  if (body.length > MAX_NOTE_LENGTH) {
    return { status: "too_long" };
  }

  const supabase = await createClient();

  const { data: project, error: selectError } = await supabase
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .maybeSingle();

  if (selectError) {
    console.error("load project for note failed:", selectError.code);
    return { status: "error" };
  }
  if (!project) {
    return { status: "not_found" };
  }

  const chunks = splitIntoChunks(body);
  if (chunks.length === 0) {
    return { status: "invalid" };
  }

  // Voyage へのリクエストは 1 回だけ（全 chunk をまとめて送る）
  let embedded: Awaited<ReturnType<typeof embedDocuments>>;
  try {
    embedded = await embedDocuments(chunks);
  } catch (error) {
    if (error instanceof EmbeddingError) {
      // ログは embeddings.ts 側で出している
      return {
        status: error.kind === "rate_limited" ? "rate_limited" : "embedding_failed",
      };
    }
    // 想定外の例外。種類（名前）だけ残す
    console.error(
      "embedding failed: unexpected",
      error instanceof Error ? error.name : "unknown",
    );
    return { status: "embedding_failed" };
  }

  const { error: deleteError } = await supabase
    .from("project_chunks")
    .delete()
    .eq("project_id", projectId)
    .eq("source_type", "note");

  if (deleteError) {
    console.error("delete note chunks failed:", deleteError.code);
    return { status: "error" };
  }

  const { error: insertError } = await supabase.from("project_chunks").insert(
    chunks.map((content, index) => ({
      project_id: projectId,
      source_type: "note",
      source_label: "Project note",
      chunk_index: index,
      content,
      // pgvector は "[0.1,0.2,…]" の文字列で受け取れる
      embedding: JSON.stringify(embedded.embeddings[index]),
      embedding_model: embedded.model,
    })),
  );

  if (insertError) {
    console.error("insert note chunks failed:", insertError.code);
    return { status: "error" };
  }

  const { error: upsertError } = await supabase
    .from("project_notes")
    .upsert({ project_id: projectId, body }, { onConflict: "project_id" });

  if (upsertError) {
    console.error("upsert project note failed:", upsertError.code);
    return { status: "error" };
  }

  revalidatePath("/admin");
  return { status: "saved" };
}
