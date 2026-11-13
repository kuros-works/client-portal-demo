// ローカル専用ガード：接続先とキーを確認してから、クライアントを返す。
// .env.local や process.env は読まない。読むのは .env.seed.local だけ。
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ENV_FILE = resolve(ROOT, ".env.seed.local");
const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost"]);

function fail(message) {
  console.error(`[guard] ${message}`);
  process.exit(1);
}

// 本命のチェック：接続先がローカルのホストか
function assertLocalHost(hostname) {
  if (!LOCAL_HOSTS.has(hostname)) {
    fail(`refusing to connect to non-local host: ${hostname}`);
  }
}

function parseEnvFile(path) {
  const out = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if (/^(".*"|'.*')$/.test(value)) value = value.slice(1, -1);
    out[m[1]] = value;
  }
  return out;
}

// 旧形式（JWT）：iss が supabase-demo で、role が一致するものだけ通す
function isLocalJwt(key, role) {
  const parts = key.split(".");
  if (parts.length !== 3) return false;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return payload.iss === "supabase-demo" && payload.role === role;
  } catch {
    return false;
  }
}

// 新形式は接頭辞だけ確認する（中身は検証できないのでホストの確認が本命）
function isAcceptedServiceKey(key) {
  return key.startsWith("sb_secret_") || isLocalJwt(key, "service_role");
}
function isAcceptedAnonKey(key) {
  return key.startsWith("sb_publishable_") || isLocalJwt(key, "anon");
}

// 全リクエストの直前にもホストを確認する（万一 URL が差し替わっても止める）
export function localOnlyFetch(input, init) {
  const raw = typeof input === "string" ? input : (input.url ?? String(input));
  assertLocalHost(new URL(raw).hostname);
  return fetch(input, init);
}

// 接続先とキーを確認して、設定を返す。requireAnon: true なら anon キーも確認する
export async function loadLocalConfig({ requireAnon = false } = {}) {
  if (!existsSync(ENV_FILE)) {
    fail(".env.seed.local not found. Run: pnpm supabase status -o env > .env.seed.local");
  }
  const env = parseEnvFile(ENV_FILE);

  // 1. 接続先（必須）
  if (!env.API_URL) fail("API_URL is missing in .env.seed.local");
  let url;
  try {
    url = new URL(env.API_URL);
  } catch {
    return fail("API_URL is not a valid URL");
  }
  if (url.protocol !== "http:") fail("API_URL must be http (local Supabase)");
  assertLocalHost(url.hostname);

  // 2. キー形式：書かれているキーはすべて、ローカルの形式であること
  const keys = [env.SERVICE_ROLE_KEY, env.SECRET_KEY].filter(Boolean);
  if (keys.length === 0) fail("no service key found (SERVICE_ROLE_KEY / SECRET_KEY)");
  for (const key of keys) {
    if (!isAcceptedServiceKey(key)) fail("service key is not a local-Supabase key");
  }
  const serviceKey = env.SERVICE_ROLE_KEY ?? env.SECRET_KEY;

  let anonKey = null;
  if (requireAnon) {
    const anonKeys = [env.ANON_KEY, env.PUBLISHABLE_KEY].filter(Boolean);
    if (anonKeys.length === 0) fail("no anon key found (ANON_KEY / PUBLISHABLE_KEY)");
    for (const key of anonKeys) {
      if (!isAcceptedAnonKey(key)) fail("anon key is not a local-Supabase key");
    }
    anonKey = env.ANON_KEY ?? env.PUBLISHABLE_KEY;
  }

  // 3. ローカル Supabase が動いているか
  try {
    const res = await fetch(new URL("/auth/v1/health", url), {
      headers: { apikey: serviceKey },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) fail(`local Supabase auth is unhealthy (HTTP ${res.status})`);
  } catch {
    fail("cannot reach local Supabase. Is `pnpm supabase start` running?");
  }

  // どのキーのクライアントも、ホスト確認つきの fetch を通す
  const makeClient = (key) =>
    createClient(url.origin, key, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { fetch: localOnlyFetch },
    });
  return { url: url.origin, serviceKey, anonKey, makeClient, fetch: localOnlyFetch };
}

export async function createLocalAdminClient() {
  const { makeClient, serviceKey } = await loadLocalConfig();
  return makeClient(serviceKey);
}
