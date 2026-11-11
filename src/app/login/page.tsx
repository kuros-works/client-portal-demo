import { LayoutDashboard } from "lucide-react";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { createClient } from "@/lib/supabase/server";

import { LoginForm } from "./login-form";

async function LoginContent({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  // 毎回リクエスト時に描画する。プリレンダー中に Date.now を読む処理が走らないよう、最初に止める
  await connection();
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  if (data?.claims) {
    redirect("/");
  }

  const { error } = await searchParams;

  return (
    <>
      {error && (
        <p className="text-sm text-destructive">
          We couldn&apos;t sign you in. Please request a new link.
        </p>
      )}
      <LoginForm />
    </>
  );
}

export default function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-6 bg-muted px-4 py-12">
      <div className="flex items-center gap-3">
        <div className="flex size-8 items-center justify-center rounded-sm bg-primary text-white">
          <LayoutDashboard className="size-4" aria-hidden="true" />
        </div>
        <span className="text-base font-medium">Client Portal</span>
      </div>
      <Card className="w-full max-w-sm rounded-lg border shadow-sm ring-0 [--card-spacing:--spacing(8)]">
        <CardHeader>
          <CardTitle className="text-2xl font-medium">Sign in</CardTitle>
          <CardDescription className="text-sm text-muted-foreground">
            We&apos;ll email you a link to sign in.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <Suspense>
            <LoginContent searchParams={searchParams} />
          </Suspense>
        </CardContent>
      </Card>
    </main>
  );
}
