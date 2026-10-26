import type { NextRequest } from "next/server";

import { PROJECT_FILES_BUCKET } from "@/lib/project-files";
import { createClient } from "@/lib/supabase/server";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// 署名付き URL は期限内なら誰でも使えるので、短くする
const SIGNED_URL_EXPIRES_IN = 60;

const NO_STORE = { "Cache-Control": "no-store" };

function redirectTo(location: string) {
  return new Response(null, {
    status: 302,
    headers: { ...NO_STORE, Location: location },
  });
}

// 見つからない場合と権限がない場合を区別させないよう、どちらもこれを返す
function notFound() {
  return new Response("Not Found", { status: 404, headers: NO_STORE });
}

export async function GET(
  request: NextRequest,
  ctx: RouteContext<"/files/[id]/download">,
) {
  const supabase = await createClient();
  const { data } = await supabase.auth.getClaims();
  if (!data?.claims.sub) {
    return redirectTo(new URL("/login", request.url).toString());
  }

  const { id } = await ctx.params;
  if (!UUID_PATTERN.test(id)) {
    return notFound();
  }

  // RLS により、管理者は全件、お客様は自分の案件のファイルだけが見える
  const { data: file, error } = await supabase
    .from("project_files")
    .select("file_name, storage_path")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    console.error("load project file failed:", error.code);
    return new Response("Internal Server Error", {
      status: 500,
      headers: NO_STORE,
    });
  }
  if (!file) {
    return notFound();
  }

  const { data: signed, error: signError } = await supabase.storage
    .from(PROJECT_FILES_BUCKET)
    .createSignedUrl(file.storage_path, SIGNED_URL_EXPIRES_IN);

  // Storage 側で見つからない・読めない場合も 404 にそろえる
  if (signError || !signed) {
    console.error("create signed url failed:", signError?.name);
    return notFound();
  }

  // SDK の download オプションは日本語名を2回エンコードしてしまうので、自分で1回だけ付ける
  const url = new URL(signed.signedUrl);
  url.searchParams.set("download", file.file_name);

  return redirectTo(url.toString());
}
