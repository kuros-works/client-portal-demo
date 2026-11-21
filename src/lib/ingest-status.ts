// 取り込みの状態の表示（管理画面用・英語）。画面（クライアント）からも読むので server-only は付けない。
// 型だけを ingest-file.ts から読む（import type は実行時には消える）
import type { IngestErrorKind, IngestResult } from "@/lib/ingest-file";

export const INGEST_REASON_LABELS: Record<IngestErrorKind, string> = {
  no_text: "No text found (scanned PDF?)",
  too_long: "Over 50,000 characters",
  too_many_pages: "Over 20 pages",
  not_pdf: "Not a PDF (stored only)",
  rate_limited: "Rate limited, try again",
  failed: "Failed, try again",
};

function reasonLabel(reason: string | null | undefined) {
  return (
    INGEST_REASON_LABELS[reason as IngestErrorKind] ?? INGEST_REASON_LABELS.failed
  );
}

// project_file_ingests の行から、一覧に出す文言を作る。行が無ければ Pending
export function ingestStatusLabel(
  row: { ingest_status: string; ingest_error: string | null } | undefined,
) {
  if (!row || row.ingest_status === "pending") return "Pending";
  if (row.ingest_status === "ready") return "Ready";
  if (row.ingest_status === "skipped") return `Skipped: ${reasonLabel(row.ingest_error)}`;
  return `Failed: ${reasonLabel(row.ingest_error)}`;
}

// 取り込みの結果（Action の戻り値）を 1 行にする
export function ingestResultLine(result: IngestResult) {
  if (result.status === "ready") return "Ingested for search.";
  if (result.status === "not_found") return "Not ingested: file not found.";
  return `Not ingested: ${reasonLabel(result.reason)}`;
}
