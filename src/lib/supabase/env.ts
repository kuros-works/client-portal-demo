// NEXT_PUBLIC_ の値はビルド時に置換されるため、process.env[name] ではなく直接参照する
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

export function getSupabaseEnv() {
  const missing: string[] = [];
  if (!url) missing.push("NEXT_PUBLIC_SUPABASE_URL");
  if (!publishableKey) missing.push("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");

  if (!url || !publishableKey) {
    throw new Error(
      `Supabase の環境変数が未設定です: ${missing.join(", ")}。.env.local（本番は Vercel の Environment Variables）に設定してください。`,
    );
  }

  return { url, publishableKey };
}
