import "server-only";

import { requireAdmin } from "@/lib/auth";
import { splitIntoChunks } from "@/lib/chunk";
import { EmbeddingError, embedDocuments } from "@/lib/embeddings";
import { extractPdfText } from "@/lib/pdf-text";
import { PROJECT_FILES_BUCKET } from "@/lib/project-files";
import { createClient } from "@/lib/supabase/server";

// アップロードしたファイル（PDF だけ）を検索用の chunk にして、取り込みの状態を記録する。
// - 書き込みは管理者本人のセッション（createClient）だけで行う（service_role は使わない）
// - 順番は saveProjectNote と同じ：埋め込み → このファイルの古い chunk を消す → 入れる。
//   埋め込みに失敗したら古い chunk は残る。消す・入れるは 1 つのトランザクションではないので、
//   入れるところで失敗すると chunk が 0 件になる（状態は failed。取り込み直すと直る）
// - 最後に project_file_ingests に upsert する（ready / skipped / failed と種類）
// - DB にもログにも、PDF の本文・例外の全文・鍵は出さない（ログは fileId と種類だけ）
//
// "use server" のファイルには置かない（export した関数がブラウザから呼べる Action になるため）。
// 呼ぶ側も requireAdmin() 済みのはずだが、ここでも確かめる（同じリクエスト内ではキャッシュされる）

export type IngestErrorKind =
  | "no_text"
  | "too_long"
  | "too_many_pages"
  | "not_pdf"
  | "rate_limited"
  | "failed";

export type IngestResult =
  | { status: "ready" }
  | { status: "skipped" | "failed"; reason: IngestErrorKind }
  | { status: "not_found" };

const SKIP_REASONS: readonly IngestErrorKind[] = [
  "no_text",
  "too_long",
  "too_many_pages",
  "not_pdf",
];

type ServerClient = Awaited<ReturnType<typeof createClient>>;

function logFailure(fileId: string, kind: string) {
  console.error("file ingest failed:", fileId, kind);
}

// 取り込みの状態を書く。書けなくても結果は変えない（行が無いファイルは pending とみなされる）
async function recordStatus(
  supabase: ServerClient,
  fileId: string,
  result: Exclude<IngestResult, { status: "not_found" }>,
) {
  const row: {
    file_id: string;
    ingest_status: "ready" | "skipped" | "failed";
    ingest_error: IngestErrorKind | null;
    ingested_at: string | null;
  } =
    result.status === "ready"
      ? {
          file_id: fileId,
          ingest_status: "ready",
          ingest_error: null,
          ingested_at: new Date().toISOString(),
        }
      : {
          file_id: fileId,
          ingest_status: result.status,
          ingest_error: result.reason,
          ingested_at: null,
        };

  const { error } = await supabase
    .from("project_file_ingests")
    .upsert(row, { onConflict: "file_id" });
  if (error) {
    console.error("record ingest status failed:", fileId, error.code);
  }
}

// 失敗・見送りの結果を作り、ログと状態を残す
async function finish(
  supabase: ServerClient,
  fileId: string,
  reason: IngestErrorKind,
): Promise<IngestResult> {
  const status = SKIP_REASONS.includes(reason) ? "skipped" : "failed";
  // 見送り（PDF ではない・上限超え）はふつうに起きるので、失敗のログは出さない
  if (status === "failed") {
    logFailure(fileId, reason);
  }
  const result = { status, reason } as const;
  await recordStatus(supabase, fileId, result);
  return result;
}

export async function ingestProjectFile(fileId: string): Promise<IngestResult> {
  await requireAdmin();
  const supabase = await createClient();

  const { data: file, error: selectError } = await supabase
    .from("project_files")
    .select("id, project_id, file_name, storage_path")
    .eq("id", fileId)
    .maybeSingle();

  if (selectError) {
    console.error("load project file for ingest failed:", fileId, selectError.code);
    return finish(supabase, fileId, "failed");
  }
  if (!file) {
    // 行が無いので、状態も書けない（外部キー）
    return { status: "not_found" };
  }

  const { data: blob, error: downloadError } = await supabase.storage
    .from(PROJECT_FILES_BUCKET)
    .download(file.storage_path);
  if (downloadError || !blob) {
    console.error("download file for ingest failed:", fileId, downloadError?.name);
    return finish(supabase, fileId, "failed");
  }

  let data: Uint8Array;
  try {
    data = new Uint8Array(await blob.arrayBuffer());
  } catch {
    return finish(supabase, fileId, "failed");
  }

  const extracted = await extractPdfText(data);
  if (!extracted.ok) {
    return finish(supabase, fileId, extracted.reason);
  }

  const chunks = splitIntoChunks(extracted.text);
  if (chunks.length === 0) {
    return finish(supabase, fileId, "no_text");
  }

  let embedded: Awaited<ReturnType<typeof embedDocuments>>;
  try {
    embedded = await embedDocuments(chunks);
  } catch (error) {
    const kind =
      error instanceof EmbeddingError && error.kind === "rate_limited"
        ? "rate_limited"
        : "failed";
    return finish(supabase, fileId, kind);
  }

  // 埋め込みが成功してから、このファイルの古い chunk を消して入れ直す
  const { error: deleteError } = await supabase
    .from("project_chunks")
    .delete()
    .eq("file_id", file.id)
    .eq("project_id", file.project_id)
    .eq("source_type", "file");
  if (deleteError) {
    console.error("delete file chunks failed:", fileId, deleteError.code);
    return finish(supabase, fileId, "failed");
  }

  const { error: insertError } = await supabase.from("project_chunks").insert(
    chunks.map((content, index) => ({
      project_id: file.project_id,
      file_id: file.id,
      source_type: "file",
      source_label: file.file_name,
      chunk_index: index,
      content,
      // pgvector は "[0.1,0.2,…]" の文字列で受け取れる
      embedding: JSON.stringify(embedded.embeddings[index]),
      embedding_model: embedded.model,
    })),
  );
  if (insertError) {
    console.error("insert file chunks failed:", fileId, insertError.code);
    return finish(supabase, fileId, "failed");
  }

  const result = { status: "ready" } as const;
  await recordStatus(supabase, fileId, result);
  return result;
}
