// デモ：「データはあるのに、Supabase の問い合わせが空を返す（エラーなし）」の代表的な原因 3 つ。
//   ① ポリシーがない  ② ポリシーの列が違う  ③ ログインしていない
// ローカルの Supabase だけで動く（guard.mjs が接続先を確認する。.env.local は読まない）。
// 準備と後片付けは postgres 直結（RLS を通らない）、アプリ役は supabase-js（anon キー＋ログイン）。
// 作るのは一時的な表 public.demo_empty_notes だけ。最後に必ず drop する。
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadLocalConfig, loadLocalDbConfig } from "./guard.mjs";

const TABLE = "public.demo_empty_notes";
const DOMAIN = "@seed.test";
const SEED_PASSWORD = "seed-local-only-pw"; // seed.mjs と同じ値
const REPORT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "reports");
const REPORT_FILE = resolve(REPORT_DIR, "demo-empty-result-latest.md");

const POLICY = "demo own rows";
const GOOD_USING = "owner_id = (select auth.uid())";
const WRONG_USING = "id = (select auth.uid())"; // 列の間違い（id は行の id で、ユーザー id ではない）

const cfg = await loadLocalConfig({ requireAnon: true });
const db = new pg.Client({
  ...loadLocalDbConfig(), // ホストが 127.0.0.1 以外ならここで終了する
  connectionTimeoutMillis: 5000,
  application_name: "demo-empty-result",
});

const rows = [];
function record(caseName, step, app, direct, note) {
  rows.push({ caseName, step, app, direct, note });
}

async function directCount() {
  const { rows: r } = await db.query(`select count(*)::int as n from ${TABLE}`);
  return r[0].n;
}

// アプリ役の select。「件数 / error」を返す
async function appSelect(client) {
  const { data, error } = await client.from("demo_empty_notes").select("id, body");
  return { count: data ? data.length : null, error: error ? `${error.code ?? ""} ${error.message}`.trim() : null };
}
const show = (r) => `${r.count} rows / error: ${r.error ?? "null"}`;

async function setPolicy(using) {
  await db.query(`drop policy if exists "${POLICY}" on ${TABLE}`);
  if (using) {
    await db.query(`create policy "${POLICY}" on ${TABLE} for select to authenticated using (${using})`);
  }
}

async function cleanup() {
  await db.query(`drop table if exists ${TABLE}`);
  await db.query(`notify pgrst, 'reload schema'`);
}

// notify の後、API が新しい表を見つけるまで少し待つ
async function waitForApi(client) {
  for (let i = 0; i < 20; i++) {
    const { error } = await client.from("demo_empty_notes").select("id").limit(1);
    // 表が見えない間は PGRST205（schema cache に無い）。見えたら error なし
    if (!error || error.code !== "PGRST205") return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("API did not pick up the new table (schema cache not reloaded)");
}

let failed = null;
try {
  await db.connect();

  const { rows: users } = await db.query(
    `select id, email from auth.users where email = any($1)`,
    [[`client-a${DOMAIN}`, `client-b${DOMAIN}`]],
  );
  const idOf = (email) => users.find((u) => u.email === email)?.id;
  const aId = idOf(`client-a${DOMAIN}`);
  const bId = idOf(`client-b${DOMAIN}`);
  if (!aId || !bId) throw new Error("seed users not found. Run the seed first (pnpm seed:local or seed.mjs).");

  // ---------- 準備 ----------
  await db.query(`drop table if exists ${TABLE}`);
  await db.query(`create table ${TABLE} (id uuid primary key default gen_random_uuid(), owner_id uuid, body text)`);
  await db.query(`alter table ${TABLE} enable row level security`);
  await db.query(`grant select on ${TABLE} to anon, authenticated`);
  for (let i = 1; i <= 3; i++) {
    await db.query(`insert into ${TABLE} (owner_id, body) values ($1, $2)`, [aId, `client-a note ${i}`]);
  }
  for (let i = 1; i <= 2; i++) {
    await db.query(`insert into ${TABLE} (owner_id, body) values ($1, $2)`, [bId, `client-b note ${i}`]);
  }
  await db.query(`notify pgrst, 'reload schema'`);

  const anon = cfg.makeClient(cfg.anonKey);
  const clientA = cfg.makeClient(cfg.anonKey);
  const { error: signInError } = await clientA.auth.signInWithPassword({
    email: `client-a${DOMAIN}`,
    password: SEED_PASSWORD,
  });
  if (signInError) throw new Error(`sign-in failed: ${signInError.message}`);
  await waitForApi(clientA);

  // ---------- ① ポリシーなし ----------
  let r = await appSelect(clientA);
  record("① No policy", "client-a, RLS on, no policy", show(r), `${await directCount()} rows`, "Empty, no error. The data is there; RLS hides it.");
  await setPolicy(GOOD_USING);
  r = await appSelect(clientA);
  record("① No policy", `fixed: create policy using (${GOOD_USING})`, show(r), `${await directCount()} rows`, "Only client-a's own 3 rows.");

  // ---------- ② 列の間違い ----------
  await setPolicy(WRONG_USING);
  r = await appSelect(clientA);
  record("② Wrong column", `client-a, policy using (${WRONG_USING})`, show(r), `${await directCount()} rows`, "A policy exists, but it compares the wrong column.");
  await setPolicy(GOOD_USING);
  r = await appSelect(clientA);
  record("② Wrong column", `fixed: using (${GOOD_USING})`, show(r), `${await directCount()} rows`, "Back to 3 rows.");

  // ---------- ③ ログイン前 ----------
  r = await appSelect(anon);
  record("③ Not signed in", "anon client (no session), correct policy", show(r), `${await directCount()} rows`, "The policy is `to authenticated`, so anon sees nothing.");
  r = await appSelect(clientA);
  record("③ Not signed in", "fixed: sign in as client-a first", show(r), `${await directCount()} rows`, "3 rows.");
} catch (e) {
  failed = e;
} finally {
  try {
    await cleanup();
  } catch (e) {
    console.error(`[demo] cleanup failed: ${e.message}. Drop ${TABLE} by hand.`);
    process.exitCode = 1;
  }
  await db.end().catch(() => {});
}

if (failed) {
  console.error(`[demo] failed: ${failed.message}`);
  process.exit(1);
}

// ---------- 表を出す ----------
const esc = (s) => String(s).replaceAll("|", "\\|");
const lines = [
  "# demo-empty-result",
  "",
  `Run at ${new Date().toISOString()} (local Supabase only). Table ${TABLE} was dropped afterwards.`,
  "",
  "| Case | Step | What the app sees (supabase-js) | Direct Postgres count | Note |",
  "| --- | --- | --- | --- | --- |",
  ...rows.map((x) => `| ${esc(x.caseName)} | ${esc(x.step)} | ${esc(x.app)} | ${esc(x.direct)} | ${esc(x.note)} |`),
  "",
  "SQL Editor bypasses RLS, the app doesn't.",
  "",
];
mkdirSync(REPORT_DIR, { recursive: true });
writeFileSync(REPORT_FILE, lines.join("\n"));
console.log(lines.join("\n"));
console.log(`report: ${REPORT_FILE}`);
