import Link from "next/link";
import { redirect } from "next/navigation";
import { Suspense } from "react";

import { Button } from "@/components/ui/button";
import { requireUser } from "@/lib/auth";
import { dateFormatter } from "@/lib/format";
import { PROJECT_STATUS_LABELS, isProjectStatus } from "@/lib/project-status";
import { createClient } from "@/lib/supabase/server";

import { signOut } from "./auth/actions";

async function ProjectList() {
  const { userId, role } = await requireUser();
  if (role === "admin") {
    redirect("/admin");
  }

  // RLS でも絞られるが、コードでも自分の案件だけに絞る
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("projects")
    .select("id, name, status, created_at")
    .eq("client_id", userId)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("load projects failed:", error.code);
    return (
      <p className="text-sm text-destructive">案件を読み込めませんでした。</p>
    );
  }

  if (data.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">案件はまだありません。</p>
    );
  }

  return (
    <ul className="flex flex-col gap-3">
      {data.map((project) => (
        <li key={project.id}>
          <Link
            href={`/projects/${project.id}`}
            className="flex flex-col gap-1 rounded-lg border p-4 hover:bg-muted"
          >
            <p className="break-all font-medium">{project.name}</p>
            <p className="text-sm text-muted-foreground">
              状態：
              {isProjectStatus(project.status)
                ? PROJECT_STATUS_LABELS[project.status]
                : "—"}
            </p>
            <p className="text-sm text-muted-foreground">
              作成日：{dateFormatter.format(new Date(project.created_at))}
            </p>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export default function Home() {
  return (
    <main className="flex flex-1 flex-col gap-8 px-4 py-12">
      <section className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold">案件の一覧</h1>
        <Suspense fallback={<p className="text-sm text-muted-foreground">…</p>}>
          <ProjectList />
        </Suspense>
      </section>
      <form action={signOut}>
        <Button type="submit" variant="outline">
          ログアウト
        </Button>
      </form>
    </main>
  );
}
