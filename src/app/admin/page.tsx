import { Suspense } from "react";

import { Button } from "@/components/ui/button";
import { requireAdmin } from "@/lib/auth";

import { signOut } from "../auth/actions";

async function AdminContent() {
  await requireAdmin();

  return (
    <>
      <h1 className="text-2xl font-semibold">管理画面</h1>
      <p className="text-sm text-muted-foreground">
        ここに案件の一覧と招待を追加していきます。
      </p>
    </>
  );
}

export default function AdminPage() {
  return (
    <main className="flex flex-1 flex-col gap-4 px-4 py-12">
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
