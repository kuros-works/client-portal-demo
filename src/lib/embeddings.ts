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

type InputType = "document" | "query";

// 渡された文章を 1 回のリクエストで送る（無料枠は 3 回/分）。分けて送るのは embedDocuments の役目。
// 失敗したら EmbeddingError を投げる。429 は "rate_limited"、それ以外は "failed"。
async function requestEmbeddings(
  texts: string[],
  inputType: InputType,
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
        input_type: inputType,
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

// 1 回のリクエストで送る chunk の数（PDF は 50,000 文字まで＝chunk は 70 前後なので、2 回ほどになる）
export const EMBEDDING_BATCH_SIZE = 64;

// メモ・ファイルの chunk 用（保存時）。
// EMBEDDING_BATCH_SIZE 件ずつ、順番に送る（同時には送らない。無料枠の回数の上限があるため）。
// どこかで失敗したら、そこで EmbeddingError を投げる（途中までの結果は返さない）。
export async function embedDocuments(
  texts: string[],
): Promise<{ embeddings: number[][]; model: string }> {
  if (texts.length === 0) {
    return fail("failed");
  }

  const embeddings: number[][] = [];
  let model: string | undefined;
  for (let start = 0; start < texts.length; start += EMBEDDING_BATCH_SIZE) {
    const batch = await requestEmbeddings(
      texts.slice(start, start + EMBEDDING_BATCH_SIZE),
      "document",
    );
    // 途中で環境変数が変わることは無いはずだが、モデルが混ざった結果は返さない
    if (model !== undefined && batch.model !== model) {
      return fail("failed");
    }
    model = batch.model;
    embeddings.push(...batch.embeddings);
  }

  return { embeddings, model: model as string };
}

// 質問用（検索時）。1 件だけ送る。保存時と同じ EMBEDDING_MODEL・同じ 1024 次元で作る。
export async function embedQuery(
  text: string,
): Promise<{ embedding: number[]; model: string }> {
  const { embeddings, model } = await requestEmbeddings([text], "query");
  return { embedding: embeddings[0], model };
}
