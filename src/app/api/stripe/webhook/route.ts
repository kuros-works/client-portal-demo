import { after, type NextRequest } from "next/server";
import type Stripe from "stripe";

import { sendPaymentReceivedEmail } from "@/lib/email";
import { getSiteUrl } from "@/lib/site-url";
import { getStripe, getStripeWebhookSecret } from "@/lib/stripe";
import { getWebhookAdminClient } from "@/lib/supabase/admin";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 200：処理した、または送り直しても結果が変わらない（Stripe は送り直さない）
// 400：署名を確かめられない（何もしない）
// 500：一時的な失敗（Stripe が送り直す）
function respond(status: 200 | 400 | 500) {
  return new Response(null, { status });
}

// checkout.session.completed を処理して、返す HTTP ステータスを決める。
// stripe_events への記録は最後に行う。記録があれば「処理済み」とみなすので、
// 更新に失敗したまま記録してしまうと、送り直しでも直らなくなる。
async function handleCheckoutCompleted(event: Stripe.Event) {
  const session = event.data.object as Stripe.Checkout.Session;
  // 署名の確認が通ったイベントだけがここに来る（POST で constructEvent のあとに呼ぶ）
  const supabase = getWebhookAdminClient();

  // 処理済みのイベントは何もしない
  const { data: recorded, error: recordedError } = await supabase
    .from("stripe_events")
    .select("event_id")
    .eq("event_id", event.id)
    .maybeSingle();

  if (recordedError) {
    console.error("load stripe event failed:", recordedError.code);
    return respond(500);
  }
  if (recorded) {
    return respond(200);
  }

  // 支払いが終わっていないもの（非同期の支払い方法など）は扱わない
  if (session.payment_status !== "paid") {
    return respond(200);
  }

  // 金額・通貨・案件を確かめ、paid にしてよいときだけ更新する。
  // それ以外は paid にせず、記録だけ残す。
  const projectId = (session.metadata?.project_id ?? "").toLowerCase();

  if (!UUID_PATTERN.test(projectId)) {
    console.error("stripe webhook: invalid project_id in metadata:", event.id);
  } else {
    const { data: project, error: projectError } = await supabase
      .from("projects")
      .select("id, name, client_id, amount, payment_status, stripe_session_id")
      .eq("id", projectId)
      .maybeSingle();

    if (projectError) {
      console.error("load project failed:", projectError.code);
      return respond(500);
    }

    if (!project) {
      console.error("stripe webhook: project not found:", event.id, projectId);
    } else if (project.payment_status === "paid") {
      // 同じ session なら、前回は更新できて記録だけ失敗した場合。別の session なら 2 件目の支払い
      if (project.stripe_session_id !== session.id) {
        console.error(
          "stripe webhook: project already paid, recording only (refund manually):",
          event.id,
          projectId,
        );
      }
    } else if (
      session.currency?.toLowerCase() !== "usd" ||
      session.amount_total !== project.amount
    ) {
      console.error(
        "stripe webhook: amount or currency mismatch, recording only:",
        event.id,
        projectId,
      );
    } else {
      // 条件付きで更新する。確認から更新までの間に、金額や支払い状態が変わっていても上書きしない
      const { data: updated, error: updateError } = await supabase
        .from("projects")
        .update({
          payment_status: "paid",
          paid_at: new Date(event.created * 1000).toISOString(),
          stripe_session_id: session.id,
        })
        .eq("id", projectId)
        .eq("payment_status", "unpaid")
        .eq("amount", session.amount_total)
        .select("id");

      if (updateError) {
        console.error("update project payment failed:", updateError.code);
        return respond(500);
      }

      // 管理者へのメール。このリクエストで paid にできたときだけ送る。
      // 失敗しても Webhook の結果は変えない（sendPaymentReceivedEmail は例外を投げない）
      if (updated && updated.length > 0) {
        const paidProject = {
          name: project.name,
          amount: session.amount_total,
          clientId: project.client_id,
        };
        after(async () => {
          try {
            // SITE_URL が未設定でも支払いの記録は成功のまま。メールだけ送らず、ログを残す
            let siteUrl: string;
            try {
              siteUrl = getSiteUrl();
            } catch {
              console.error("payment email skipped: SITE_URL is not set");
              return;
            }

            const { data: client } = await supabase
              .from("profiles")
              .select("email")
              .eq("id", paidProject.clientId)
              .maybeSingle();

            await sendPaymentReceivedEmail({
              projectName: paidProject.name,
              amountCents: paidProject.amount ?? 0,
              clientEmail: client?.email ?? null,
              projectUrl: `${siteUrl}/admin`,
            });
          } catch (err) {
            console.error(
              "payment email failed:",
              err instanceof Error ? err.name : "unknown",
            );
          }
        });
      }

      if (!updated || updated.length === 0) {
        // 同時に別の Webhook が先に paid にした、または金額が変わった場合。もう一度読んで確かめる
        const { data: current, error: currentError } = await supabase
          .from("projects")
          .select("amount, payment_status")
          .eq("id", projectId)
          .maybeSingle();

        if (currentError) {
          console.error("reload project failed:", currentError.code);
          return respond(500);
        }
        // 条件が揃っているのに更新されなかったなら、一時的な失敗。送り直してもらう
        if (
          current?.payment_status === "unpaid" &&
          current.amount === session.amount_total
        ) {
          console.error("stripe webhook: update affected 0 rows:", event.id);
          return respond(500);
        }
        console.error(
          "stripe webhook: project changed during update, recording only:",
          event.id,
          projectId,
        );
      }
    }
  }

  // 最後に記録する。同じイベントが同時に届いた場合は、一意制約違反（23505）を処理済みとして扱う
  const { error: insertError } = await supabase.from("stripe_events").insert({
    event_id: event.id,
    event_type: event.type,
    session_id: session.id,
    amount_total: session.amount_total,
    currency: session.currency,
    payment_status: session.payment_status,
    customer_email: session.customer_details?.email ?? null,
  });

  if (insertError && insertError.code !== "23505") {
    console.error("record stripe event failed:", insertError.code);
    return respond(500);
  }

  return respond(200);
}

export async function POST(request: NextRequest) {
  let stripe: Stripe;
  let webhookSecret: string;
  try {
    stripe = getStripe();
    webhookSecret = getStripeWebhookSecret();
  } catch (err) {
    // 環境変数が足りない。送り直しで直る可能性があるので 500
    console.error(
      "stripe webhook setup failed:",
      err instanceof Error ? err.message : "unknown",
    );
    return respond(500);
  }

  // 署名は生の body で確かめる。json() にすると形が変わって合わなくなる
  const signature = request.headers.get("stripe-signature");
  if (!signature) {
    return respond(400);
  }
  const body = await request.text();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, signature, webhookSecret);
  } catch {
    console.error("stripe webhook signature verification failed");
    return respond(400);
  }

  if (event.type !== "checkout.session.completed") {
    return respond(200);
  }

  try {
    return await handleCheckoutCompleted(event);
  } catch (err) {
    // お客様の情報が入りうるので、エラーの名前だけ残す
    console.error(
      "stripe webhook failed:",
      err instanceof Error ? err.name : "unknown",
    );
    return respond(500);
  }
}
