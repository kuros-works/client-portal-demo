import { ArrowLeft, FileText } from "lucide-react";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";

import { PaymentBadge } from "@/components/payment-badge";
import { ProjectStatusBadge } from "@/components/project-status-badge";
import { ProjectSteps } from "@/components/project-steps";
import { buttonVariants } from "@/components/ui/button";
import { requireUser } from "@/lib/auth";
import { dateTimeFormatter } from "@/lib/format";
import { formatCents } from "@/lib/project-amount";
import { formatFileSize } from "@/lib/project-files";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";

import { PayButton } from "./pay-button";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function ProjectDetail({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  // 毎回リクエスト時に描画する。プリレンダー中に Date.now を読む処理が走らないよう、最初に止める
  await connection();
  const { userId, role } = await requireUser();
  if (role === "admin") {
    redirect("/admin");
  }

  // UUID でない値を DB に渡すとエラーになるので、先に 404 にする
  const { id } = await params;
  if (!UUID_PATTERN.test(id)) {
    notFound();
  }

  // RLS でも絞られるが、コードでも自分の案件だけに絞る
  const supabase = await createClient();
  const { data: project, error } = await supabase
    .from("projects")
    .select(
      "id, name, status, amount, payment_status, project_files(id, file_name, size, uploaded_at)",
    )
    .eq("id", id)
    .eq("client_id", userId)
    .order("uploaded_at", {
      referencedTable: "project_files",
      ascending: false,
    })
    .maybeSingle();

  if (error) {
    console.error("load project failed:", error.code);
    return (
      <p className="text-sm text-destructive">
        We couldn&apos;t load this project.
      </p>
    );
  }
  // 見つからない場合と他人の案件を区別させないよう、どちらも 404 にする
  if (!project) {
    notFound();
  }

  // 戻り先の query は表示の出し分けにだけ使う。支払い済みかどうかは DB の値で決める
  const { payment } = await searchParams;
  const payable =
    project.amount !== null && project.payment_status === "unpaid";
  // 未払いのファイルは RLS で見えない（件数も分からない）。想定外の値でも出さない側に倒す
  const filesLocked =
    project.amount !== null && project.payment_status !== "paid";

  return (
    <>
      <div className="flex flex-col gap-4">
        <div className="flex items-start justify-between gap-3">
          <h1 className="min-w-0 break-all text-2xl font-medium">
            {project.name}
          </h1>
          <ProjectStatusBadge status={project.status} />
        </div>
        <div className="max-w-md">
          <ProjectSteps status={project.status} />
        </div>
      </div>

      {payable && payment === "success" && (
        <p className="rounded-lg border bg-card p-5 text-sm">
          Thank you! We&apos;re confirming your payment. This can take a few
          moments. Refresh this page if the Pay button is still showing.
        </p>
      )}
      {payable && payment === "cancelled" && (
        <p className="rounded-lg border bg-card p-5 text-sm">
          Payment was cancelled. You can try again anytime.
        </p>
      )}

      {project.amount !== null && (
        <section className="flex flex-col gap-4 rounded-lg border bg-card p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="flex flex-col gap-1">
              <p className="text-sm text-muted-foreground">Payment</p>
              <p className="text-lg font-medium">
                {formatCents(project.amount)}
              </p>
            </div>
            <PaymentBadge
              amount={project.amount}
              paymentStatus={project.payment_status}
            />
          </div>
          {payable && (
            <PayButton projectId={project.id} amount={project.amount} />
          )}
        </section>
      )}

      <section className="flex flex-col gap-3">
        <h2 className="text-base font-medium">Files</h2>
        <div className="rounded-lg border bg-card">
          {filesLocked ? (
            <p className="p-4 text-sm text-muted-foreground">
              Files will be available after payment.
            </p>
          ) : project.project_files.length === 0 ? (
            <p className="p-4 text-sm text-muted-foreground">No files yet.</p>
          ) : (
            <ul className="flex flex-col divide-y">
              {project.project_files.map((file) => (
                <li
                  key={file.id}
                  className="flex items-center gap-3 p-4"
                >
                  <FileText
                    className="size-5 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <p className="break-all text-sm font-medium">
                      {file.file_name}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {formatFileSize(file.size)}
                      {" · "}
                      {dateTimeFormatter.format(new Date(file.uploaded_at))}
                    </p>
                  </div>
                  {/* Link だと先読みで署名付き URL が作られうるので、普通の a にする */}
                  <a
                    href={`/files/${file.id}/download`}
                    className={cn(
                      buttonVariants({ variant: "outline", size: "sm" }),
                    )}
                  >
                    Download
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </>
  );
}

export default function ProjectPage({
  params,
  searchParams,
}: PageProps<"/projects/[id]">) {
  return (
    <div className="flex flex-1 flex-col gap-8 px-4 py-12">
      <Link
        href="/"
        className="flex w-fit items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-4" aria-hidden="true" />
        Back to projects
      </Link>
      <Suspense fallback={<p className="text-sm text-muted-foreground">…</p>}>
        <ProjectDetail params={params} searchParams={searchParams} />
      </Suspense>
    </div>
  );
}
