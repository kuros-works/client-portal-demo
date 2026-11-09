import "server-only";

import { Resend } from "resend";

import { formatCents } from "@/lib/project-amount";
import { PROJECT_STATUS_LABELS, type ProjectStatus } from "@/lib/project-status";

// メール送信は「おまけ」の処理。失敗しても、呼び出し元（ステータス更新・Webhook）は
// 失敗させない。例外は投げず、ログにはエラーの名前だけ残す（宛先や本文は出さない）。
async function sendEmail(message: {
  to: string;
  subject: string;
  text: string;
}) {
  try {
    const apiKey = process.env.RESEND_API_KEY;
    const from = process.env.NOTIFY_FROM_EMAIL;

    if (!apiKey || !from) {
      console.error("send email skipped: RESEND_API_KEY or NOTIFY_FROM_EMAIL is not set");
      return;
    }

    const { error } = await new Resend(apiKey).emails.send({
      from,
      to: message.to,
      subject: message.subject,
      text: message.text,
    });

    if (error) {
      console.error("send email failed:", error.name);
    }
  } catch (err) {
    console.error("send email failed:", err instanceof Error ? err.name : "unknown");
  }
}

// 件名に改行が入らないようにする
function oneLine(value: string) {
  return value.replace(/[\r\n]+/g, " ").trim();
}

// 管理者がステータスを変えたとき、その案件のお客様に送る
export async function sendStatusChangedEmail(params: {
  to: string;
  projectName: string;
  status: ProjectStatus;
  projectUrl: string;
}) {
  const label = PROJECT_STATUS_LABELS[params.status];
  const name = oneLine(params.projectName);

  await sendEmail({
    to: params.to,
    subject: `Your project "${name}" is now ${label}`,
    text: [
      "Hello,",
      "",
      `The status of your project "${name}" has been updated to: ${label}.`,
      "",
      `View the project: ${params.projectUrl}`,
      "",
      "— Client Portal",
    ].join("\n"),
  });
}

// 支払いが完了したとき、管理者に送る
export async function sendPaymentReceivedEmail(params: {
  projectName: string;
  amountCents: number;
  clientEmail: string | null;
  projectUrl: string;
}) {
  const to = process.env.ADMIN_NOTIFY_EMAIL;
  if (!to) {
    console.error("send email skipped: ADMIN_NOTIFY_EMAIL is not set");
    return;
  }

  const name = oneLine(params.projectName);
  const amount = formatCents(params.amountCents);

  await sendEmail({
    to,
    subject: `Payment received: ${amount} for "${name}"`,
    text: [
      `A payment of ${amount} was received for the project "${name}".`,
      params.clientEmail ? `Client: ${params.clientEmail}` : "",
      "",
      `Open in the portal: ${params.projectUrl}`,
    ]
      .filter((line, i, all) => line !== "" || all[i - 1] !== "")
      .join("\n"),
  });
}
