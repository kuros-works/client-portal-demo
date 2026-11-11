import { connection } from "next/server";
import { Suspense } from "react";

import { AppSidebar } from "@/components/app-sidebar";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

async function AppShell({ children }: { children: React.ReactNode }) {
  // ログイン状態を毎回確認するので、リクエスト時に描画する
  await connection();
  const { role } = await requireUser();

  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  const email =
    typeof data?.claims.email === "string" ? data.claims.email : "";

  return (
    <TooltipProvider>
      <SidebarProvider>
        <AppSidebar role={role} email={email} />
        <SidebarInset>
          <header className="flex h-12 shrink-0 items-center border-b px-4">
            <SidebarTrigger />
          </header>
          {children}
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <Suspense>
      <AppShell>{children}</AppShell>
    </Suspense>
  );
}
