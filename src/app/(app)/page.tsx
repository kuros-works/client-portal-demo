import Link from "next/link";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";

import { PaymentBadge } from "@/components/payment-badge";
import { ProjectStatusBadge } from "@/components/project-status-badge";
import { ProjectSteps } from "@/components/project-steps";
import { requireUser } from "@/lib/auth";
import { dateFormatter } from "@/lib/format";
import { createClient } from "@/lib/supabase/server";

async function ProjectList() {
  // 毎回リクエスト時に描画する。プリレンダー中に Date.now を読む処理が走らないよう、最初に止める
  await connection();
  const { userId, role } = await requireUser();
  if (role === "admin") {
    redirect("/admin");
  }

  // RLS でも絞られるが、コードでも自分の案件だけに絞る
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("projects")
    .select("id, name, status, created_at, amount, payment_status")
    .eq("client_id", userId)
    .order("created_at", { ascending: false });

  if (error) {
    console.error("load projects failed:", error.code);
    return (
      <p className="text-sm text-destructive">
        We couldn&apos;t load your projects.
      </p>
    );
  }

  if (data.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No projects yet.</p>
    );
  }

  return (
    <>
      <p className="text-sm text-muted-foreground">
        {data.length} {data.length === 1 ? "project" : "projects"}
      </p>
      <ul className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {data.map((project) => (
          <li key={project.id}>
            <Link
              href={`/projects/${project.id}`}
              className="flex h-full flex-col gap-4 rounded-lg border bg-card p-4 transition-colors hover:bg-muted"
            >
              <div className="flex items-start justify-between gap-2">
                <p className="min-w-0 break-all font-medium">{project.name}</p>
                <ProjectStatusBadge status={project.status} />
              </div>
              <ProjectSteps status={project.status} />
              <div className="mt-auto flex items-center justify-between gap-2">
                <p className="text-sm text-muted-foreground">
                  {dateFormatter.format(new Date(project.created_at))}
                </p>
                <PaymentBadge
                  amount={project.amount}
                  paymentStatus={project.payment_status}
                />
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}

export default function Home() {
  return (
    <div className="flex flex-1 flex-col gap-8 px-4 py-12">
      <section className="flex flex-col gap-2">
        <h1 className="text-2xl font-medium">Projects</h1>
        <Suspense fallback={<p className="text-sm text-muted-foreground">…</p>}>
          <ProjectList />
        </Suspense>
      </section>
    </div>
  );
}
