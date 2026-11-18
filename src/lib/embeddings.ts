import "server-only";

// Voyage AI で文章を埋め込み（ベクトル）にする。
// 鍵（VOYAGE_API_KEY）とモデル名（EMBEDDING_MODEL）は環境変数から読む。
// ログに出すのはエラーの種類だけ（メモの本文・鍵は出さない）。

const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";
// project_chunks.embedding の次元（vector(1024)）と合わせる
const EMBEDDING_DIMENSIONS = 1024;
const REQUEST_TIMEOUT_MS = 20_000;

export type EmbeddingErrorKind = "rate_limited" | "failed";

export class EmbeddingError extends Error {
  readonly kind: EmbeddingErrorKind;

  constructor(kind: EmbeddingErrorKind) {
    super(kind);
    this.name = "EmbeddingError";
    this.kind = kind;
  }
}

function fail(kind: EmbeddingErrorKind): never {
  console.error("embedding failed:", kind);
  throw new EmbeddingError(kind);
}

// すべての文章を 1 回のリクエストでまとめて送る（無料枠は 3 回/分）。
// 失敗したら EmbeddingError を投げる。429 は "rate_limited"、それ以外は "failed"。
export async function embedDocuments(
  texts: string[],
): Promise<{ embeddings: number[][]; model: string }> {
  const apiKey = process.env.VOYAGE_API_KEY;
  const model = process.env.EMBEDDING_MODEL;

  if (!apiKey || !model || texts.length === 0) {
    return fail("failed");
  }

  let response: Response;
  try {
    response = await fetch(VOYAGE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        input: texts,
        model,
        input_type: "document",
        output_dimension: EMBEDDING_DIMENSIONS,
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    // ネットワークエラー・タイムアウト
    return fail("failed");
  }

  if (response.status === 429) {
    return fail("rate_limited");
  }
  if (!response.ok) {
    return fail("failed");
  }

  let json: unknown;
  try {
    json = await response.json();
  } catch {
    return fail("failed");
  }

  const data = (json as { data?: { index?: number; embedding?: unknown }[] })
    ?.data;

  if (!Array.isArray(data) || data.length !== texts.length) {
    return fail("failed");
  }

  // index の順に並べ直し、件数と次元（1024）を確かめる
  const embeddings: number[][] = new Array(texts.length);
  for (const item of data) {
    const { index, embedding } = item;
    if (
      typeof index !== "number" ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= texts.length ||
      embeddings[index] !== undefined ||
      !Array.isArray(embedding) ||
      embedding.length !== EMBEDDING_DIMENSIONS ||
      !embedding.every((value) => typeof value === "number")
    ) {
      return fail("failed");
    }
    embeddings[index] = embedding as number[];
  }

  return { embeddings, model };
}
