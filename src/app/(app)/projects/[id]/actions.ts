"use server";

import { redirect } from "next/navigation";

import { AnswerError, generateAnswer } from "@/lib/answer";
import { MATCH_COUNT, MAX_QUESTION_LENGTH } from "@/lib/ask";
import { requireUser } from "@/lib/auth";
import { EmbeddingError, embedQuery } from "@/lib/embeddings";
import { getSiteUrl } from "@/lib/site-url";
import { getStripe } from "@/lib/stripe";
import { createClient } from "@/lib/supabase/server";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 別タブで 2 回払われるのを減らすため、Checkout は 30 分で期限切れにする
const CHECKOUT_EXPIRES_IN = 30 * 60;

export type CheckoutFormState = {
  status:
    | "idle"
    | "invalid"
    | "not_found"
    | "not_owner"
    | "unavailable"
    | "error";
};

export async function createCheckoutSession(
  _prevState: CheckoutFormState,
  formData: FormData,
): Promise<CheckoutFormState> {
  const { role, organizationId, orgRole } = await requireUser();
  if (role === "admin") {
    redirect("/admin");
  }

  // ブラウザから受け取るのは project_id だけ。金額は DB から読む
  const projectId = String(formData.get("project_id") ?? "").toLowerCase();
  if (!UUID_PATTERN.test(projectId)) {
    return { status: "invalid" };
  }
  // どの会社にも入っていない人は、見つからない扱い
  if (!organizationId) {
    return { status: "not_found" };
  }
  // 支払えるのは会社のオーナーだけ（画面でボタンを隠すだけでなく、ここで必ず止める）
  if (orgRole !== "owner") {
    return { status: "not_owner" };
  }

  // RLS でも絞られるが、コードでも自分の会社の案件だけに絞る
  const supabase = await createClient();
  const { data: project, error } = await supabase
    .from("projects")
    .select("id, name, amount, payment_status")
    .eq("id", projectId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (error) {
    console.error("load project for checkout failed:", error.code);
    return { status: "error" };
  }
  // 見つからない場合と他人の案件は区別しない
  if (!project) {
    return { status: "not_found" };
  }
  // 請求なし、または支払い済みなら Checkout を作らない
  if (project.amount === null || project.payment_status !== "unpaid") {
    return { status: "unavailable" };
  }

  const returnUrl = `${getSiteUrl()}/projects/${project.id}`;

  let checkoutUrl: string | null;
  try {
    const session = await getStripe().checkout.sessions.create({
      mode: "payment",
      locale: "en",
      // 非同期の支払い方法（銀行振込など）は Webhook が拾えないので、カードだけにする
      allowed_payment_method_types: ["card"],
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: project.amount,
            product_data: { name: project.name },
          },
        },
      ],
      // 段階 5 の Webhook が案件を特定するのに使う
      metadata: { project_id: project.id },
      expires_at: Math.floor(Date.now() / 1000) + CHECKOUT_EXPIRES_IN,
      success_url: `${returnUrl}?payment=success`,
      cancel_url: `${returnUrl}?payment=cancelled`,
    });
    checkoutUrl = session.url;
  } catch (err) {
    // 鍵や案件名は出さず、Stripe のエラー種別だけ残す
    console.error(
      "create checkout session failed:",
      err instanceof Error ? err.name : "unknown",
    );
    return { status: "error" };
  }

  if (!checkoutUrl) {
    console.error("create checkout session returned no url");
    return { status: "error" };
  }

  // redirect は例外で動くので、try / catch の外で呼ぶ
  redirect(checkoutUrl);
}

export type AskFormState = {
  status:
    | "idle"
    | "answered"
    | "invalid"
    | "too_long"
    | "not_found"
    | "no_sources"
    | "daily_limit"
    | "rate_limited"
    | "unavailable"
    | "error";
  // 画面に返すのは回答と出典（source_label）だけ。chunk の本文は返さない
  answer?: string;
  sources?: string[];
};

type MatchedChunk = {
  project_id: string;
  source_label: string;
  content: string;
};

// 案件についての質問に、案件メモなどの資料をもとに答える。
// 検索は本人のセッション（createClient）で行うので、RLS がそのまま効く
// （この action では admin クライアント・service_role は使わない）。
export async function askQuestion(
  _prevState: AskFormState,
  formData: FormData,
): Promise<AskFormState> {
  const { role, organizationId } = await requireUser();
  if (role === "admin") {
    redirect("/admin");
  }

  const projectId = String(formData.get("project_id") ?? "").toLowerCase();
  const question = String(formData.get("question") ?? "").trim();
  if (!UUID_PATTERN.test(projectId) || !question) {
    return { status: "invalid" };
  }
  if (question.length > MAX_QUESTION_LENGTH) {
    return { status: "too_long" };
  }
  // どの会社にも入っていない人は、見つからない扱い
  if (!organizationId) {
    return { status: "not_found" };
  }

  // フォームの project_id は信用せず、自分の会社の案件かを DB で確かめる
  const supabase = await createClient();
  const { data: project, error: projectError } = await supabase
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (projectError) {
    console.error("load project for question failed:", projectError.code);
    return { status: "error" };
  }
  // 見つからない場合と他人の案件は区別しない
  if (!project) {
    return { status: "not_found" };
  }

  // 1 日の回数を 1 回分使う（本人のセッションで呼ぶ。だれの回数かは DB 側が auth.uid() で決める）。
  // ここから先は外部 API を呼ぶので、失敗した質問・資料が見つからない質問も 1 回と数える。
  // 回数を確かめられなければ、Voyage・Claude は呼ばずに止める
  const { data: quota, error: quotaError } = await supabase
    .rpc("consume_question_quota")
    .single<{ allowed: boolean; remaining: number }>();

  if (quotaError) {
    console.error("consume question quota failed:", quotaError.code);
    return { status: "error" };
  }
  if (!quota.allowed) {
    return { status: "daily_limit" };
  }

  // 質問をベクトルにする（ログは embeddings.ts 側で出している）
  let queryEmbedding: number[];
  try {
    queryEmbedding = (await embedQuery(question)).embedding;
  } catch (error) {
    if (error instanceof EmbeddingError) {
      return {
        status: error.kind === "rate_limited" ? "rate_limited" : "unavailable",
      };
    }
    console.error(
      "embed question failed: unexpected",
      error instanceof Error ? error.name : "unknown",
    );
    return { status: "unavailable" };
  }

  const { data, error: matchError } = await supabase.rpc(
    "match_project_chunks",
    {
      // pgvector は "[0.1,0.2,…]" の文字列で受け取れる
      query_embedding: JSON.stringify(queryEmbedding),
      match_count: MATCH_COUNT,
      filter_project_id: project.id,
    },
  );

  if (matchError) {
    console.error("match project chunks failed:", matchError.code);
    return { status: "error" };
  }

  // RLS と filter_project_id に加えて、コードでも「この案件の chunk だけ」に絞る
  const rows = (data ?? []) as MatchedChunk[];
  const chunks = rows.filter((row) => row.project_id === project.id);
  if (chunks.length !== rows.length) {
    console.error(
      "match project chunks returned rows of another project:",
      rows.length - chunks.length,
    );
  }

  // 資料がなければ、Claude は呼ばない
  if (chunks.length === 0) {
    return { status: "no_sources" };
  }

  let answer: string;
  try {
    answer = await generateAnswer(question, chunks);
  } catch (error) {
    if (error instanceof AnswerError) {
      // ログは answer.ts 側で出している
      return {
        status: error.kind === "rate_limited" ? "rate_limited" : "unavailable",
      };
    }
    console.error(
      "generate answer failed: unexpected",
      error instanceof Error ? error.name : "unknown",
    );
    return { status: "unavailable" };
  }

  return {
    status: "answered",
    answer,
    sources: [...new Set(chunks.map((chunk) => chunk.source_label))],
  };
}
