import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";

import { buttonVariants } from "@/components/ui/button";
import { requireUser } from "@/lib/auth";
import { dateTimeFormatter } from "@/lib/format";
import { formatFileSize } from "@/lib/project-files";
import { PROJECT_STATUS_LABELS, isProjectStatus } from "@/lib/project-status";
import { createClient } from "@/lib/supabase/server";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function ProjectDetail({ params }: { params: Promise<{ id: string }> }) {
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
      "id, name, status, project_files(id, file_name, size, uploaded_at)",
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

  return (
    <>
      <div className="flex flex-col gap-1">
        <h1 className="break-all text-2xl font-semibold">{project.name}</h1>
        <p className="text-sm text-muted-foreground">
          Status:{" "}
          {isProjectStatus(project.status)
            ? PROJECT_STATUS_LABELS[project.status]
            : "—"}
        </p>
      </div>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">Files</h2>
        {project.project_files.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No files yet.
          </p>
        ) : (
          <ul className="flex flex-col divide-y border-y">
            {project.project_files.map((file) => (
              <li
                key={file.id}
                className="flex flex-col gap-2 py-3 md:flex-row md:items-center md:justify-between"
              >
                <div className="flex min-w-0 flex-col gap-1">
                  <p className="break-all text-sm font-medium">
                    {file.file_name}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {formatFileSize(file.size)}
                    {" · "}
                    {dateTimeFormatter.format(new Date(file.uploaded_at))}
                  </p>
                </div>
                <div className="flex items-start">
                  {/* Link だと先読みで署名付き URL が作られうるので、普通の a にする */}
                  <a
                    href={`/files/${file.id}/download`}
                    className={buttonVariants({
                      variant: "outline",
                      size: "sm",
                    })}
                  >
                    Download
                  </a>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

export default function ProjectPage({ params }: PageProps<"/projects/[id]">) {
  return (
    <main className="flex flex-1 flex-col gap-8 px-4 py-12">
      <Link href="/" className="text-sm underline underline-offset-4">
        ← Back to projects
      </Link>
      <Suspense fallback={<p className="text-sm text-muted-foreground">…</p>}>
        <ProjectDetail params={params} />
      </Suspense>
    </main>
  );
}
