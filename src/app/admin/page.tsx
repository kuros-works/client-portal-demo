import { Suspense } from "react";

import { Button } from "@/components/ui/button";
import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

import { signOut } from "../auth/actions";
import { InviteForm } from "./invite-form";
import { ProjectForm } from "./project-form";
import { StatusForm } from "./status-form";

const dateFormatter = new Intl.DateTimeFormat("ja-JP", {
  dateStyle: "medium",
  timeZone: "Asia/Tokyo",
});

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
      .select("id, name, status, created_at, profiles(email)")
      .order("created_at", { ascending: false }),
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
      <h1 className="text-2xl font-semibold">管理画面</h1>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">案件を作成</h2>
        <ProjectForm clients={clients} />
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">案件の一覧</h2>
        {projectsResult.error && (
          <p className="text-sm text-destructive">
            案件を読み込めませんでした。
          </p>
        )}
        {!projectsResult.error && projects.length === 0 && (
          <p className="text-sm text-muted-foreground">
            案件はまだありません。
          </p>
        )}
        <ul className="flex flex-col gap-3">
          {projects.map((project) => (
            <li
              key={project.id}
              className="flex flex-col gap-3 rounded-lg border p-4 md:flex-row md:items-center md:justify-between"
            >
              <div className="flex flex-col gap-1">
                <p className="font-medium">{project.name}</p>
                <p className="text-sm text-muted-foreground">
                  {clientEmail(project.profiles)}
                </p>
                <p className="text-sm text-muted-foreground">
                  作成日：{dateFormatter.format(new Date(project.created_at))}
                </p>
              </div>
              <StatusForm projectId={project.id} status={project.status} />
            </li>
          ))}
        </ul>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">お客様を招待</h2>
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
          ログアウト
        </Button>
      </form>
    </main>
  );
}
