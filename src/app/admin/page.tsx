import { Suspense } from "react";

import { Button, buttonVariants } from "@/components/ui/button";
import { requireAdmin } from "@/lib/auth";
import { dateFormatter, dateTimeFormatter } from "@/lib/format";
import { formatFileSize } from "@/lib/project-files";
import { createClient } from "@/lib/supabase/server";

import { signOut } from "../auth/actions";
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
        "id, name, status, created_at, profiles(email), project_files(id, file_name, size, uploaded_at)",
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
      <h1 className="text-2xl font-semibold">Admin</h1>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">Create a project</h2>
        <ProjectForm clients={clients} />
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">Projects</h2>
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
        <ul className="flex flex-col gap-3">
          {projects.map((project) => (
            <li
              key={project.id}
              className="flex flex-col gap-4 rounded-lg border p-4"
            >
              <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div className="flex flex-col gap-1">
                  <p className="font-medium">{project.name}</p>
                  <p className="text-sm text-muted-foreground">
                    {clientEmail(project.profiles)}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    Created: {dateFormatter.format(new Date(project.created_at))}
                  </p>
                </div>
                <div className="flex flex-col gap-3">
                  <StatusForm projectId={project.id} status={project.status} />
                  <FileUploadForm projectId={project.id} />
                </div>
              </div>
              {project.project_files.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No files yet.
                </p>
              ) : (
                <ul className="flex flex-col divide-y border-t">
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
                      <div className="flex items-start gap-2">
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

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">Invite a client</h2>
        <InviteForm />
      </section>
    </>
  );
}

export default function AdminPage() {
  return (
    <main className="flex flex-1 flex-col gap-8 px-4 py-12">
      <Suspense fallback={<p className="text-sm text-muted-foreground">…</p>}>
        <AdminContent />
      </Suspense>
      <form action={signOut}>
        <Button type="submit" variant="outline">
          Sign out
        </Button>
      </form>
    </main>
  );
}
