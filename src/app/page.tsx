import { Suspense } from "react";

import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/server";

import { signOut } from "./auth/actions";

async function UserEmail() {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const email = typeof data?.claims.email === "string" ? data.claims.email : "";

  return <p className="break-all text-lg font-medium">{email}</p>;
}

export default function Home() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-2 px-4 py-12 text-center">
      <p className="text-sm text-muted-foreground">ログイン中</p>
      <Suspense fallback={<p className="text-lg font-medium">…</p>}>
        <UserEmail />
      </Suspense>
      <form action={signOut} className="mt-4">
        <Button type="submit" variant="outline">
          ログアウト
        </Button>
      </form>
    </main>
  );
}
