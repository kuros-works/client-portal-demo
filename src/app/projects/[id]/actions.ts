"use server";

import { redirect } from "next/navigation";

import { requireUser } from "@/lib/auth";
import { getRequestOrigin } from "@/lib/request-origin";
import { getStripe } from "@/lib/stripe";
import { createClient } from "@/lib/supabase/server";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 別タブで 2 回払われるのを減らすため、Checkout は 30 分で期限切れにする
const CHECKOUT_EXPIRES_IN = 30 * 60;

export type CheckoutFormState = {
  status: "idle" | "invalid" | "not_found" | "unavailable" | "error";
};

export async function createCheckoutSession(
  _prevState: CheckoutFormState,
  formData: FormData,
): Promise<CheckoutFormState> {
  const { userId, role } = await requireUser();
  if (role === "admin") {
    redirect("/admin");
  }

  // ブラウザから受け取るのは project_id だけ。金額は DB から読む
  const projectId = String(formData.get("project_id") ?? "").toLowerCase();
  if (!UUID_PATTERN.test(projectId)) {
    return { status: "invalid" };
  }

  // RLS でも絞られるが、コードでも自分の案件だけに絞る
  const supabase = await createClient();
  const { data: project, error } = await supabase
    .from("projects")
    .select("id, name, amount, payment_status")
    .eq("id", projectId)
    .eq("client_id", userId)
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

  const origin = await getRequestOrigin();
  const returnUrl = `${origin}/projects/${project.id}`;

  let checkoutUrl: string | null;
  try {
    const session = await getStripe().checkout.sessions.create({
      mode: "payment",
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
