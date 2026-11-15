import { NextResponse, type NextRequest } from "next/server";

import { getSiteUrl } from "@/lib/site-url";
import { createClient } from "@/lib/supabase/server";

// 戻り先は request.nextUrl.origin ではなく SITE_URL から作る
// （ヘッダーは偽装でき、開発中の Next は 127.0.0.1 を localhost に書き換えるため）
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const siteUrl = getSiteUrl();
  const code = searchParams.get("code");

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(new URL("/", siteUrl));
    }
  }

  return NextResponse.redirect(new URL("/login?error=1", siteUrl));
}
