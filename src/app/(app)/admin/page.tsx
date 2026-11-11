import { FileText } from "lucide-react";
import { connection } from "next/server";
import { Suspense } from "react";

import { buttonVariants } from "@/components/ui/button";
import { PaymentBadge } from "@/components/payment-badge";
import { ProjectStatusBadge } from "@/components/project-status-badge";
import { requireAdmin } from "@/lib/auth";
import { dateFormatter, dateTimeFormatter } from "@/lib/format";
import { formatFileSize } from "@/lib/project-files";
import { createClient } from "@/lib/supabase/server";
import { cn } from "@/lib/utils";

import { AmountForm } from "./amount-form";
import { FileDeleteForm } from "./file-delete-form";
import { FileUploadForm } from "./file-upload-form";
import { InviteForm } from "./invite-form";
import { ProjectForm } from "./project-form";
import { StatusForm } from "./status-form";

// 多対一の結合結果。型の上では配列にもなりうるので、どちらでもメールを取り出す
function clientEmail(profiles: { email: string } | { email: string }[] | null) {
  return (Array.isArray(profiles) ? profiles[0]?.email : profiles?.email) ?? "—";
}

async function AdminContent() {
  // 管理画面は毎回リクエスト時に描画する。プリレンダー中に時刻（Date.now）を
  // 読む処理が走らないよう、最初にここで止める
  await connection();
  await requireAdmin();

  const supabase = await createClient();
  const [clientsResult, projectsResult] = await Promise.all([
    supabase
      .from("profiles")
      .select("id, email")
      .eq("role", "client")
      .order("email"),
    supabase
      .from("projects")
      .select(
        "id, name, status, amount, payment_status, created_at, profiles(email), project_files(id, file_name, size, uploaded_at)",
      )
      .order("created_at", { ascending: false })
      .order("uploaded_at", {
        referencedTable: "project_files",
        ascending: false,
      }),
  ]);

  if (clientsResult.error) {
    console.error("load clients failed:", clientsResult.error.code);
  }
  if (projectsResult.error) {
    console.error("load projects failed:", projectsResult.error.code);
  }

  const clients = clientsResult.data ?? [];
  const projects = projectsResult.data ?? [];

  return (
    <>
      <div className="flex flex-col gap-2">
        <h1 className="text-2xl font-medium">Admin</h1>
        <p className="text-sm text-muted-foreground">
          {projects.length} {projects.length === 1 ? "project" : "projects"}
        </p>
      </div>

      <div className="grid grid-cols-1 items-start gap-4 md:grid-cols-2">
        <section className="flex flex-col gap-4 rounded-lg border bg-card p-5">
          <h2 className="text-base font-medium">Create a project</h2>
          <ProjectForm clients={clients} />
        </section>
        <section className="flex flex-col gap-4 rounded-lg border bg-card p-5">
          <h2 className="text-base font-medium">Invite a client</h2>
          <InviteForm />
        </section>
      </div>

      <section className="flex flex-col gap-4">
        <h2 className="text-base font-medium">Projects</h2>
        {projectsResult.error && (
          <p className="text-sm text-destructive">
            We couldn&apos;t load the projects.
          </p>
        )}
        {!projectsResult.error && projects.length === 0 && (
          <p className="text-sm text-muted-foreground">
            No projects yet.
          </p>
        )}
        <ul className="flex flex-col gap-4">
          {projects.map((project) => (
            <li
              key={project.id}
              className="overflow-hidden rounded-lg border bg-card"
            >
              <div className="flex flex-col gap-3 p-5 md:flex-row md:items-start md:justify-between">
                <div className="flex min-w-0 flex-col gap-1">
                  <p className="break-all font-medium">{project.name}</p>
                  <p className="break-all text-sm text-muted-foreground">
                    {clientEmail(project.profiles)}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    Created: {dateFormatter.format(new Date(project.created_at))}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <ProjectStatusBadge status={project.status} />
                  <PaymentBadge
                    amount={project.amount}
                    paymentStatus={project.payment_status}
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 gap-4 border-t bg-muted/40 p-5 lg:grid-cols-3">
                <StatusForm projectId={project.id} status={project.status} />
                <AmountForm
                  projectId={project.id}
                  amount={project.amount}
                  paymentStatus={project.payment_status}
                />
                <FileUploadForm projectId={project.id} />
              </div>

              {project.project_files.length === 0 ? (
                <p className="border-t p-5 text-sm text-muted-foreground">
                  No files yet.
                </p>
              ) : (
                <ul className="flex flex-col divide-y border-t">
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
                      <div className="flex shrink-0 items-start gap-2">
                        {/* Link だと先読みで署名付き URL が作られうるので、普通の a にする */}
                        <a
                          href={`/files/${file.id}/download`}
                          className={cn(
                            buttonVariants({ variant: "outline", size: "sm" }),
                          )}
                        >
                          Download
                        </a>
                        <FileDeleteForm
                          fileId={file.id}
                          fileName={file.file_name}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

export default function AdminPage() {
  return (
    <div className="flex flex-1 flex-col gap-8 px-4 py-12">
      <Suspense fallback={<p className="text-sm text-muted-foreground">…</p>}>
        <AdminContent />
      </Suspense>
    </div>
  );
}
