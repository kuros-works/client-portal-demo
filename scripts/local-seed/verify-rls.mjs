// RLS 検証：anon・A社オーナー・A社スタッフ・B社オーナー・管理者の立場で操作して、期待どおりか確認する。
// 攻撃役は anon キー＋パスワードログインだけ。service_role は「準備」「読み直し」
// 「このスクリプトが作った Storage の残骸の掃除」にだけ使う。
// ローカルの Postgres（127.0.0.1 だけ）には、ふだんは読むだけでつなぐ。書き込みもできる接続は
// 「question_usage の seed ユーザーの行の削除」と「rollback で終わるトランザクション」の 2 つだけに使う
// （question_usage は service_role からも読み書きできないため）。
// FAIL が出ても RLS や migrations は直さない（報告だけ）。
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadLocalConfig, loadLocalDbConfig } from "./guard.mjs";

// ---------- 列の読み取り（SELECT）の期待値 ----------
// ロールごと・テーブルごとに「読めてよい列」。これ以外の列が読める、または足りなければ FAIL。
// authenticated は client-a・client-a-staff・client-b・admin の共通（同じロールなので、列の権限も同じ）。
// 行の範囲は RLS が決めるので、ここでは列だけを見る。
const EXPECTED_READABLE_COLUMNS = deepFreeze({
  anon: {
    profiles: [],
    projects: [],
    project_files: [],
    stripe_events: [],
    organizations: [],
    organization_members: [],
    project_notes: [],
    project_chunks: [],
    question_usage: [],
    project_file_ingests: [],
  },
  authenticated: {
    profiles: ["id", "email", "name", "role", "created_at"],
    projects: [
      "id", "name", "status", "created_at", "updated_at",
      "amount", "payment_status", "paid_at", "stripe_session_id", "organization_id",
    ],
    project_files: ["id", "project_id", "file_name", "storage_path", "size", "uploaded_at"],
    stripe_events: [],
    organizations: ["id", "name", "created_at"],
    organization_members: ["organization_id", "user_id", "role", "created_at"],
    project_notes: ["project_id", "body", "created_at", "updated_at"],
    // embedding も読める（match_project_chunks は security invoker なので、呼ぶ人が読めないと検索できない）
    project_chunks: [
      "id", "project_id", "file_id", "source_type", "source_label", "chunk_index",
      "content", "embedding", "embedding_model", "created_at",
    ],
    // 回数の表（0008）は読めない。読み書きは consume_question_quota（security definer）からだけ
    question_usage: [],
    // 取り込みの状態（0009）。管理者が本人のセッションで読むので、列の権限は 4 列とも付いている。
    // お客様に見えないのは RLS（「admin all」だけ）で守る
    project_file_ingests: ["file_id", "ingest_status", "ingest_error", "ingested_at"],
  },
});
const PUBLIC_TABLES = Object.keys(EXPECTED_READABLE_COLUMNS.authenticated);
// 列の権限はあるが、行は管理者にしか見えない表（お客様の select は「エラーなし・0 行」が正しい）
const ADMIN_ONLY_ROW_TABLES = deepFreeze(["project_file_ingests"]);
const INGEST_TABLE = "project_file_ingests";
const INGEST_COLUMNS = EXPECTED_READABLE_COLUMNS.authenticated[INGEST_TABLE];

// service_role の表の権限（0009 の後）。service_role は RLS を通らないので、これがそのまま「できること」になる
// TRUNCATE・REFERENCES・TRIGGER・MAINTAIN はどの表にも無い。stripe_events は select と insert だけの台帳
// project_notes・project_chunks・project_file_ingests は seed 用に select / insert / update / delete。
// question_usage は何も無い
const TABLE_PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", "MAINTAIN"];
const EXPECTED_SERVICE_ROLE_PRIVILEGES = deepFreeze({
  profiles: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  projects: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  project_files: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  stripe_events: ["SELECT", "INSERT"],
  organizations: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  organization_members: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  project_notes: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  project_chunks: ["SELECT", "INSERT", "UPDATE", "DELETE"],
  question_usage: [],
  project_file_ingests: ["SELECT", "INSERT", "UPDATE", "DELETE"],
});

// ---------- RAG（0007） ----------
// match_project_chunks の EXECUTE は authenticated だけ（service_role で呼ぶと RLS を通らず全社の行が返るため）
const RAG_RPC = "match_project_chunks";
const RAG_RPC_SIGNATURE = "public.match_project_chunks(extensions.vector, integer, uuid)";
const EXPECTED_RAG_RPC_EXECUTE = deepFreeze({ anon: false, authenticated: true, service_role: false });

// ---------- 質問の回数制限（0008） ----------
// consume_question_quota の EXECUTE は authenticated だけ。question_usage は anon・authenticated から何もできない
const QUOTA_RPC = "consume_question_quota";
const QUOTA_RPC_SIGNATURE = "public.consume_question_quota()";
const EXPECTED_QUOTA_RPC_EXECUTE = deepFreeze({ anon: false, authenticated: true, service_role: false });
const EXPECTED_QUOTA_TABLE_PRIVILEGES = deepFreeze({ anon: [], authenticated: [] });
const DAILY_QUESTION_LIMIT = 20; // 0008 の daily_limit と同じ
const CONCURRENT_QUOTA_CALLS = 25; // 同時に呼ぶ回数（上限より多く）

// EXECUTE を確かめる関数（ローカルの Postgres で has_function_privilege）
const FUNCTION_EXECUTE_CHECKS = deepFreeze([
  { name: RAG_RPC, signature: RAG_RPC_SIGNATURE, expected: EXPECTED_RAG_RPC_EXECUTE },
  { name: QUOTA_RPC, signature: QUOTA_RPC_SIGNATURE, expected: EXPECTED_QUOTA_RPC_EXECUTE },
]);
const MATCH_DEFAULT = 6; // match_count を省いたとき
const MATCH_MAX = 10; // DB 側で 1〜10 に収める
// seed.mjs と同じ作り方の偽の埋め込み（slot 番目だけ 1）。seed の slot は 0〜12 なので、
// テストで作る行はそれと重ならない slot を使う
const EMBEDDING_DIM = 1024;
const EMBEDDING_MODEL = "dummy-1024";
const PROBE_SLOT = 100; // #7・#8 のテスト用 chunk
const WRITE_PROBE_SLOT = 200; // 書き込み拒否のテストで insert を試す chunk
function fakeEmbedding(slot) {
  return `[${Array.from({ length: EMBEDDING_DIM }, (_, i) => (i === slot ? 1 : 0)).join(",")}]`;
}
const isOne = (x) => typeof x === "number" && Math.abs(x - 1) < 1e-9;
// 陽性対照（--positive-control）で期待値に足す、存在しない列
const CONTROL_FAKE_COLUMN = "__control_missing__";
const DEFAULT_CONTROL_TARGET = "projects.stripe_session_id";

function deepFreeze(o) {
  for (const v of Object.values(o)) if (v && typeof v === "object") deepFreeze(v);
  return Object.freeze(o);
}

const DOMAIN = "@seed.test";
const BUCKET = "project-files";
const SEED_PASSWORD = "seed-local-only-pw"; // seed.mjs と同じ値
const REPORT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "reports");
const REPORT_FILE = resolve(REPORT_DIR, "verify-rls-latest.md");
const CONTROL_REPORT_FILE = resolve(REPORT_DIR, "verify-rls-control.md");
// migrations（0001・0003・0004・0005・0007・0008）にある public の関数
const KNOWN_RPC = [
  "is_admin", "handle_new_user", "set_updated_at",
  "prevent_paid_amount_change", "prevent_profile_role_change", "rls_auto_enable",
  "is_org_member", "is_org_owner", RAG_RPC, QUOTA_RPC,
];
// authenticated が呼べてよい関数（RLS 用の判定・RAG の検索・質問の回数）。それ以外はトリガー用で、誰も呼べない
// （QUOTA_RPC は呼ぶと回数が増えるので、TRIGGER_RPC のように全員で呼ぶループには入れない）
const AUTH_RPC = ["is_admin", "is_org_member", "is_org_owner", RAG_RPC, QUOTA_RPC];
const TRIGGER_RPC = KNOWN_RPC.filter((n) => !AUTH_RPC.includes(n));

// ログインして試す立場（会社ごとの役割）
const TENANTS = [
  { key: "a", org: "a", orgRole: "owner", label: "client-a", email: `client-a@seed.test` },
  { key: "aStaff", org: "a", orgRole: "staff", label: "client-a-staff", email: `client-a-staff@seed.test` },
  { key: "b", org: "b", orgRole: "owner", label: "client-b", email: `client-b@seed.test` },
];

let cfg; // guard が返した設定
let admin; // service_role クライアント（準備・読み直し・掃除だけ）
let baseline; // 書き込みテスト前のスナップショット
let secrets = [];
const ids = {}; // { admin, a, aStaff, b } のユーザー ID
const orgIds = {}; // { a, b } の会社 ID
let projects = [];
let files = [];
let members = []; // seed の会社の organization_members
let notes = []; // seed の案件の project_notes
let chunks = []; // seed の案件の project_chunks（embedding も含む）
const results = [];
const probePaths = new Set(); // このスクリプトが upload を試みたパス（掃除の対象はここだけ）
const strayRemoved = [];

// ---------- ユーティリティ ----------
function must(error, label) {
  if (error) throw new Error(`${label}: ${error.message}`);
}

// キー・パスワード・トークンを、画面にも Markdown にも出さない
function redact(text) {
  let s = String(text);
  for (const v of secrets) if (v) s = s.split(v).join("[redacted]");
  return s
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[redacted-jwt]")
    .replace(/sb_(?:secret|publishable)_[\w-]+/g, "[redacted-key]");
}

function record(role, op, expect, actual, pass, note = "") {
  results.push({
    role, op, expect: redact(expect), actual: redact(actual),
    result: pass ? "PASS" : "FAIL", note: redact(note),
  });
}

async function attempt(fn) {
  try {
    return await fn();
  } catch (e) {
    return { data: null, error: { code: "exception", message: e.message } };
  }
}

function errText(e) {
  const code = e.code ?? e.statusCode ?? e.status ?? e.name ?? "?";
  return `error ${code}: ${String(e.message ?? "").slice(0, 70)}`;
}
function describe(r) {
  if (r.error) return errText(r.error);
  const n = Array.isArray(r.data) ? r.data.length : r.data == null ? 0 : 1;
  return `${n} row(s), no error`;
}
function isDenied(r) {
  if (r.error) return true;
  return Array.isArray(r.data) ? r.data.length === 0 : r.data == null;
}
const sameSet = (a, b) => {
  const sa = new Set(a);
  const sb = new Set(b);
  return sa.size === sb.size && [...sa].every((x) => sb.has(x));
};
const nameOf = (id) => projects.find((p) => p.id === id)?.name ?? "?";
const nameList = (pids) => [...new Set(pids)].map(nameOf).sort().join(",");

// ---------- service_role：スナップショットと掃除 ----------
async function listAllObjects() {
  const bucket = admin.storage.from(BUCKET);
  const root = await bucket.list("", { limit: 1000 });
  must(root.error, "list bucket root");
  const out = [];
  for (const entry of root.data) {
    if (entry.id === null) {
      const sub = await bucket.list(entry.name, { limit: 1000 });
      must(sub.error, "list bucket folder");
      for (const o of sub.data) {
        out.push({ name: `${entry.name}/${o.name}`, size: o.metadata?.size ?? null, updated: o.updated_at ?? null });
      }
    } else {
      out.push({ name: entry.name, size: entry.metadata?.size ?? null, updated: entry.updated_at ?? null });
    }
  }
  return out.sort((x, y) => x.name.localeCompare(y.name));
}

async function takeSnapshot() {
  const p = await admin.from("projects").select("*").order("id");
  must(p.error, "snapshot projects");
  const f = await admin.from("project_files").select("*").order("id");
  must(f.error, "snapshot project_files");
  const pr = await admin.from("profiles").select("*").order("id");
  must(pr.error, "snapshot profiles");
  const ev = await admin.from("stripe_events").select("*").order("event_id");
  must(ev.error, "snapshot stripe_events");
  const o = await admin.from("organizations").select("*").order("id");
  must(o.error, "snapshot organizations");
  const m = await admin.from("organization_members").select("*").order("organization_id").order("user_id");
  must(m.error, "snapshot organization_members");
  const n = await admin.from("project_notes").select("*").order("project_id");
  must(n.error, "snapshot project_notes");
  const ch = await admin.from("project_chunks").select("*").order("id");
  must(ch.error, "snapshot project_chunks");
  // 取り込みの状態（0009）。表が無い DB（0009 の前）でも全体を止めず、エラーの種類を中身として持つ
  // （表が無いことは、列の権限・service_role の権限・[ingest] のテストが FAIL で知らせる）
  const fi = await admin.from(INGEST_TABLE).select("*").order("file_id");
  const fiData = fi.error ? { error: fi.error.code ?? "unknown" } : fi.data;
  // question_usage は service_role から読めないので、ローカルの Postgres で読む（読むだけ）
  const qu = await queryLocalDb(QUOTA_SNAPSHOT_SQL);
  const objects = await listAllObjects();
  return JSON.stringify({
    p: p.data, f: f.data, pr: pr.data, ev: ev.data, o: o.data, m: m.data, n: n.data, ch: ch.data,
    fi: fiData, qu, objects,
  });
}
const QUOTA_SNAPSHOT_SQL = `
  select u.user_id::text as user_id, u.day::text as day, u.question_count
  from public.question_usage u
  order by 1, 2`;

// このスクリプトが upload を試みたパスのうち、実際に残っているものだけ消す
async function removeProbeObjects() {
  const objects = await listAllObjects();
  const stray = objects.map((o) => o.name).filter((n) => probePaths.has(n));
  if (stray.length === 0) return;
  const { error } = await admin.storage.from(BUCKET).remove(stray);
  must(error, "remove probe objects");
  strayRemoved.push(...stray);
}

// データが変わっていなければ true。変わっていたら残骸を掃除して、基準を取り直す
async function checkUnchanged() {
  const now = await takeSnapshot();
  if (now === baseline) return true;
  await removeProbeObjects();
  baseline = await takeSnapshot();
  return false;
}

// 書き込み系：拒否（エラーか 0 件）かつ、データが変わっていなければ PASS
async function writeTest(role, op, run, expect = "denied, data unchanged") {
  const r = await attempt(run);
  const same = await checkUnchanged();
  record(role, op, expect, describe(r), isDenied(r) && same, same ? "" : "DATA CHANGED (rebuild with seed.mjs)");
}

// 権限が無いはずの操作：0 件ではなく、エラーで止まり、データも変わっていなければ PASS
// （question_usage は権限そのものが無いので、行が無くても 0 件ではなくエラーになるはず）
async function deniedErrorTest(role, op, run) {
  const r = await attempt(run);
  const same = await checkUnchanged();
  record(role, op, "denied (error), data unchanged", describe(r), !!r.error && same,
    same ? "" : "DATA CHANGED (rebuild with seed.mjs)");
}

// ---------- 準備 ----------
async function loadSeed() {
  const list = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  must(list.error, "listUsers");
  const byEmail = (e) => list.data.users.find((u) => u.email === e)?.id;
  ids.admin = byEmail(`admin${DOMAIN}`);
  for (const t of TENANTS) ids[t.key] = byEmail(t.email);
  if (!ids.admin || TENANTS.some((t) => !ids[t.key])) {
    throw new Error("seed users not found. Run: node scripts/local-seed/seed.mjs");
  }

  // 会社はメンバー（organization_members）から特定する
  const m = await admin.from("organization_members").select("*")
    .in("user_id", TENANTS.map((t) => ids[t.key]));
  must(m.error, "load organization_members");
  for (const t of TENANTS) {
    const row = m.data.find((x) => x.user_id === ids[t.key]);
    if (!row || row.role !== t.orgRole) {
      throw new Error(`unexpected membership for ${t.label}. Run seed.mjs`);
    }
    if (orgIds[t.org] && orgIds[t.org] !== row.organization_id) {
      throw new Error(`${t.label} is not in the same organization as its company. Run seed.mjs`);
    }
    orgIds[t.org] = row.organization_id;
  }
  if (orgIds.a === orgIds.b) throw new Error("company A and B share an organization. Run seed.mjs");

  const allMembers = await admin.from("organization_members").select("*")
    .in("organization_id", Object.values(orgIds));
  must(allMembers.error, "load members of seed organizations");
  members = allMembers.data;

  const p = await admin.from("projects").select("*").in("organization_id", Object.values(orgIds)).order("name");
  must(p.error, "load projects");
  projects = p.data;
  const f = await admin.from("project_files").select("*").in("project_id", projects.map((x) => x.id));
  must(f.error, "load project_files");
  files = f.data;
  const n = await admin.from("project_notes").select("*").in("project_id", projects.map((x) => x.id));
  must(n.error, "load project_notes");
  notes = n.data;
  const ch = await admin.from("project_chunks").select("*").in("project_id", projects.map((x) => x.id));
  must(ch.error, "load project_chunks");
  chunks = ch.data;
  if (projects.length !== 6 || files.length !== 7 || members.length !== 3 ||
      notes.length !== 6 || chunks.length !== 13) {
    throw new Error(`unexpected seed shape (projects ${projects.length}, files ${files.length}, ` +
      `members ${members.length}, notes ${notes.length}, chunks ${chunks.length}). Run seed.mjs`);
  }
}

// 案件ごとの「お客様から見えてよいか」。chunk はメモ由来ならいつでも、ファイル由来はファイルと同じ条件
const projectVisible = (p) => p.amount === null || p.payment_status === "paid";
const chunkVisible = (c) => c.source_type === "note" || projectVisible(projects.find((p) => p.id === c.project_id));
const paidFileChunkOf = (projectList) => {
  const paid = projectList.find((p) => p.payment_status === "paid");
  return chunks.find((c) => c.project_id === paid?.id && c.source_type === "file");
};

// 期待値は、DB の中身（organization_id・amount・payment_status）から導く
function tenantOf(t) {
  const orgId = orgIds[t.org];
  const otherOrgId = Object.values(orgIds).find((id) => id !== orgId);
  const own = projects.filter((p) => p.organization_id === orgId);
  const other = projects.filter((p) => p.organization_id !== orgId);
  const visible = projectVisible;
  const filesOf = (ps) => files.filter((f) => ps.some((p) => p.id === f.project_id));
  const chunksOf = (ps) => chunks.filter((c) => ps.some((p) => p.id === c.project_id));
  return {
    ...t, orgId, otherOrgId, own, other,
    ownMembers: members.filter((x) => x.organization_id === orgId),
    ownVisibleFiles: filesOf(own.filter(visible)),
    ownHiddenFiles: filesOf(own.filter((p) => !visible(p))),
    otherFiles: filesOf(other),
    unpaid: own.find((p) => p.amount !== null && p.payment_status === "unpaid"),
    paid: own.find((p) => p.payment_status === "paid"),
    ownNotes: notes.filter((x) => own.some((p) => p.id === x.project_id)),
    otherNotes: notes.filter((x) => other.some((p) => p.id === x.project_id)),
    ownVisibleChunks: chunksOf(own).filter(chunkVisible),
    ownHiddenChunks: chunksOf(own).filter((c) => !chunkVisible(c)),
    otherChunks: chunksOf(other),
    ownPaidFileChunk: paidFileChunkOf(own), // A社なら A-3、B社なら B-3 のファイル由来の chunk
    otherPaidFileChunk: paidFileChunkOf(other), // A社から見た B-3（#4 の検索に使う）
  };
}

async function signIn(email) {
  const c = cfg.makeClient(cfg.anonKey);
  const { error } = await c.auth.signInWithPassword({ email, password: SEED_PASSWORD });
  if (error) throw new Error(`sign-in failed for ${email}`);
  return c;
}

const dl = (c, path) => attempt(() => c.storage.from(BUCKET).download(path));
const sign = (c, path) => attempt(() => c.storage.from(BUCKET).createSignedUrl(path, 60));

// ---------- 1. 未ログイン（anon） ----------
async function runAnon() {
  const role = "anon";
  const anon = cfg.makeClient(cfg.anonKey);
  const some = projects[0];
  const file = files[0];

  // 列の読み取りの確認も兼ねる（行が返らなければ、どの列も読めない）
  for (const table of PUBLIC_TABLES) {
    const r = await attempt(() => anon.from(table).select("*"));
    record(role, `select * ${table} (rows and columns)`, "denied (error or 0 rows)", describe(r), isDenied(r));
  }
  await writeTest(role, "insert projects", () =>
    anon.from("projects").insert({
      name: "verify-probe", status: "in_progress", organization_id: orgIds.a,
    }).select());
  await writeTest(role, "insert organizations", () =>
    anon.from("organizations").insert({ name: "verify-probe" }).select());
  await writeTest(role, "insert organization_members", () =>
    anon.from("organization_members").insert({ organization_id: orgIds.a, user_id: ids.b, role: "staff" }).select());
  await writeTest(role, "update projects", () =>
    anon.from("projects").update({ status: "delivered" }).eq("id", some.id).select());
  await writeTest(role, "delete projects", () =>
    anon.from("projects").delete().eq("id", some.id).select());
  await writeTest(role, "update project_notes", () =>
    anon.from("project_notes").update({ body: "verify-probe" }).eq("project_id", some.id).select());
  await writeTest(role, "insert project_chunks", () =>
    anon.from("project_chunks").insert({
      project_id: some.id, source_type: "note", source_label: "verify-probe", chunk_index: 99,
      content: "verify-probe", embedding: fakeEmbedding(WRITE_PROBE_SLOT), embedding_model: EMBEDDING_MODEL,
    }).select());
  await writeTest(role, `[ingest] insert ${INGEST_TABLE}`, () =>
    anon.from(INGEST_TABLE).insert({ file_id: file.id, ingest_status: "ready" }).select());

  const list = await attempt(() => anon.storage.from(BUCKET).list("", { limit: 1000 }));
  record(role, "storage list (root)", "denied (error or empty)", describe(list), isDenied(list));
  const folder = await attempt(() => anon.storage.from(BUCKET).list(file.project_id, { limit: 1000 }));
  record(role, "storage list (a project folder)", "denied (error or empty)", describe(folder), isDenied(folder));
  const d = await dl(anon, file.storage_path);
  record(role, "storage download", "denied (error)", d.error ? errText(d.error) : "downloaded", !!d.error);
  const s = await sign(anon, file.storage_path);
  record(role, "storage signed URL", "denied (error)", s.error ? errText(s.error) : "created", !!s.error);

  // supabase-js を使わず、curl と同じ条件で直接たたく
  const raw = async (headers) => {
    const res = await cfg.fetch(`${cfg.url}/rest/v1/projects?select=*`, { headers });
    let rows = null;
    try {
      const j = JSON.parse(await res.text());
      if (Array.isArray(j)) rows = j.length;
    } catch { /* JSON でなければ rows は null のまま */ }
    return { status: res.status, ok: res.ok, rows };
  };
  const withKey = await raw({ apikey: cfg.anonKey });
  record(role, "raw fetch /rest/v1/projects (apikey only)", "denied (non-2xx or 0 rows)",
    `HTTP ${withKey.status}${withKey.rows !== null ? `, ${withKey.rows} row(s)` : ""}`,
    !withKey.ok || withKey.rows === 0);
  const noKey = await raw({});
  record(role, "raw fetch /rest/v1/projects (no apikey)", "denied (non-2xx)", `HTTP ${noKey.status}`, !noKey.ok);

  const who = await attempt(() => anon.rpc("is_admin"));
  record(role, "rpc is_admin", "denied (error)", describe(who), !!who.error);
  for (const fn of ["is_org_member", "is_org_owner"]) {
    const r = await attempt(() => anon.rpc(fn, { org: orgIds.a }));
    record(role, `rpc ${fn}(company A)`, "denied (error)", r.error ? describe(r) : `data=${r.data}`, !!r.error);
  }
  const rag = await attempt(() => anon.rpc(RAG_RPC, { query_embedding: chunks[0].embedding }));
  record(role, `rpc ${RAG_RPC}`, "denied (error)", describe(rag), !!rag.error);
  for (const fn of TRIGGER_RPC) {
    await writeTest(role, `rpc ${fn}`, () => anon.rpc(fn), "denied (error), data unchanged");
  }

  // 質問の回数（0008）：anon は関数も表も使えない
  await deniedErrorTest(role, `[quota] rpc ${QUOTA_RPC}`, () => anon.rpc(QUOTA_RPC));
  await deniedErrorTest(role, "[quota] insert question_usage", () =>
    anon.from("question_usage").insert({ user_id: ids.a, day: utcToday(), question_count: 1 }).select());
}

// UTC の今日（YYYY-MM-DD）。0008 の (now() at time zone 'utc')::date と同じ日
const utcToday = () => new Date().toISOString().slice(0, 10);

// ---------- 2・3. 会社A / 会社B ----------
async function runTenant(t, c) {
  const role = t.label;
  const ownIds = t.own.map((p) => p.id);
  const visFileIds = t.ownVisibleFiles.map((f) => f.id);
  const hiddenIds = t.ownHiddenFiles.map((f) => f.id);
  const otherFileIds = t.otherFiles.map((f) => f.id);
  const now = new Date().toISOString();

  // --- 読み取り
  let r = await attempt(() => c.from("projects").select("id,name").order("name"));
  record(role, "select projects", `own only: ${nameList(ownIds)}`,
    r.error ? describe(r) : `${r.data.length}: ${nameList(r.data.map((x) => x.id))}`,
    !r.error && sameSet(r.data.map((x) => x.id), ownIds));

  r = await attempt(() => c.from("project_files").select("id,project_id"));
  record(role, "select project_files",
    `${visFileIds.length} (visible only, from ${nameList(t.ownVisibleFiles.map((f) => f.project_id))})`,
    r.error ? describe(r) : `${r.data.length} (from ${nameList(r.data.map((x) => x.project_id))})`,
    !r.error && sameSet(r.data.map((x) => x.id), visFileIds));

  r = await attempt(() => c.from("profiles").select("id"));
  record(role, "select profiles", "1 row (self)", describe(r),
    !r.error && r.data.length === 1 && r.data[0].id === ids[t.key]);

  r = await attempt(() => c.from("stripe_events").select("*"));
  record(role, "select stripe_events", "denied (error or 0 rows)", describe(r), isDenied(r));

  // 会社とメンバー：自分の会社の分だけ
  r = await attempt(() => c.from("organizations").select("id"));
  record(role, "select organizations", "1 row (own company)", describe(r),
    !r.error && r.data.length === 1 && r.data[0].id === t.orgId);
  r = await attempt(() => c.from("organization_members").select("organization_id,user_id,role"));
  const memberKey = (x) => `${x.organization_id}/${x.user_id}/${x.role}`;
  record(role, "select organization_members",
    `${t.ownMembers.length} row(s): own company's members (${t.ownMembers.map((x) => x.role).sort().join(",")})`,
    r.error ? describe(r) : `${r.data.length} row(s) (${r.data.map((x) => x.role).sort().join(",")})`,
    !r.error && sameSet(r.data.map(memberKey), t.ownMembers.map(memberKey)));
  r = await attempt(() => c.from("organizations").select("id").eq("id", t.otherOrgId));
  record(role, "select other company's organization by id", "0 rows", describe(r), isDenied(r));
  r = await attempt(() => c.from("organization_members").select("user_id").eq("organization_id", t.otherOrgId));
  record(role, "select other company's members by organization_id", "0 rows", describe(r), isDenied(r));
  r = await attempt(() => c.from("projects").select("id,organizations(id,name)").order("name"));
  const embeddedOrgs = r.error ? [] : [...new Set(r.data.map((p) => p.organizations?.id).filter(Boolean))];
  record(role, "select projects with embedded organizations", "own company only",
    r.error ? describe(r) : `${embeddedOrgs.length} organization(s)`,
    !r.error && sameSet(embeddedOrgs, [t.orgId]));

  // 件数だけ（count, head）：全体の 6 ではなく、自分の分だけになる
  r = await attempt(() => c.from("projects").select("*", { count: "exact", head: true }));
  record(role, "count projects (head)", `${ownIds.length} (not ${projects.length})`,
    r.error ? describe(r) : `count=${r.count}`,
    !r.error && r.count === ownIds.length && r.count !== projects.length);

  // 埋め込み（projects?select=*,project_files(*)）：見えないファイルが混ざらない
  r = await attempt(() => c.from("projects").select("*,project_files(*)"));
  if (r.error) {
    record(role, "select projects with embedded project_files", "own projects + visible files only", describe(r), false);
  } else {
    const embedded = r.data.flatMap((p) => p.project_files.map((f) => f.id));
    const hiddenProject = r.data.find((p) => p.id === t.unpaid?.id);
    const ok =
      sameSet(r.data.map((p) => p.id), ownIds) &&
      sameSet(embedded, visFileIds) &&
      (hiddenProject?.project_files.length ?? 0) === 0;
    record(role, "select projects with embedded project_files",
      `${ownIds.length} projects, ${visFileIds.length} files, unpaid project: 0 files`,
      `${r.data.length} projects, ${embedded.length} files, unpaid project: ${hiddenProject?.project_files.length ?? "n/a"} files`,
      ok);
  }

  // id を直接指定
  r = await attempt(() => c.from("projects").select("id").in("id", t.other.map((p) => p.id)));
  record(role, "select other company's projects by id", "0 rows", describe(r), isDenied(r));
  r = await attempt(() => c.from("project_files").select("id").in("id", hiddenIds));
  record(role, "select own unpaid project's file rows by id", "0 rows", describe(r), isDenied(r));
  r = await attempt(() => c.from("project_files").select("id").in("id", otherFileIds));
  record(role, "select other company's file rows by id", "0 rows", describe(r), isDenied(r));

  // --- RAG：メモと chunk（0007）
  const visChunkIds = t.ownVisibleChunks.map((x) => x.id);
  const hiddenChunkIds = t.ownHiddenChunks.map((x) => x.id);
  const otherChunkIds = t.otherChunks.map((x) => x.id);
  const chunkLabel = (ids) => {
    const notesN = chunks.filter((x) => ids.includes(x.id) && x.source_type === "note").length;
    return `${ids.length} (note ${notesN}, file ${ids.length - notesN})`;
  };

  r = await attempt(() => c.from("project_notes").select("project_id"));
  record(role, "select project_notes", `own only: ${nameList(t.ownNotes.map((x) => x.project_id))}`,
    r.error ? describe(r) : `${r.data.length}: ${nameList(r.data.map((x) => x.project_id))}`,
    !r.error && sameSet(r.data.map((x) => x.project_id), t.ownNotes.map((x) => x.project_id)));
  r = await attempt(() => c.from("project_notes").select("project_id")
    .in("project_id", t.otherNotes.map((x) => x.project_id)));
  record(role, "select other company's project_notes by project_id", "0 rows", describe(r), isDenied(r));

  r = await attempt(() => c.from("project_chunks").select("id,project_id,source_type"));
  record(role, "select project_chunks", `${chunkLabel(visChunkIds)}, own visible only`,
    r.error ? describe(r) : `${chunkLabel(r.data.map((x) => x.id))} from ${nameList(r.data.map((x) => x.project_id))}`,
    !r.error && sameSet(r.data.map((x) => x.id), visChunkIds));
  r = await attempt(() => c.from("project_chunks").select("id").in("id", hiddenChunkIds));
  record(role, "select own unpaid project's file chunks by id", "0 rows", describe(r), isDenied(r));
  r = await attempt(() => c.from("project_chunks").select("id").in("id", otherChunkIds));
  record(role, "select other company's chunks by id", "0 rows", describe(r), isDenied(r));
  r = await attempt(() => c.from("projects").select("id,project_chunks(id)"));
  const embeddedChunks = r.error ? [] : r.data.flatMap((p) => p.project_chunks.map((x) => x.id));
  record(role, "select projects with embedded project_chunks", `${visChunkIds.length} chunks (visible only)`,
    r.error ? describe(r) : `${embeddedChunks.length} chunks`,
    !r.error && sameSet(embeddedChunks, visChunkIds));

  // --- RAG：検索（match_project_chunks）
  const match = (args) => attempt(() => c.rpc(RAG_RPC, args));
  const rowIds = (x) => (x.error ? [] : x.data.map((row) => row.id));
  const within = (x, allowed) => !x.error && x.data.every((row) => allowed.includes(row.id));
  const matchText = (x) => (x.error ? describe(x) : `${x.data.length} row(s)` +
    (x.data[0] ? `, top: ${chunks.find((ch) => ch.id === x.data[0].id)?.content.split(" ")[0] ?? "unknown"}` +
      ` (sim ${Number(x.data[0].similarity).toFixed(3)})` : ""));

  // #4：他社の支払い済みファイル由来の chunk と同じベクトルで探しても、他社の行は 0 件（自社の見える行だけ）
  r = await match({ query_embedding: t.otherPaidFileChunk.embedding });
  const expectN = Math.min(MATCH_DEFAULT, visChunkIds.length);
  record(role, `rpc ${RAG_RPC} (other company's paid file vector)`,
    `0 rows from other company; ${expectN} own visible rows`, matchText(r),
    within(r, visChunkIds) && !rowIds(r).some((x) => otherChunkIds.includes(x)) && r.data.length === expectN);
  // 対照：自社の支払い済みファイル由来の chunk のベクトルなら、その行が 1 件目（類似度 1）
  r = await match({ query_embedding: t.ownPaidFileChunk.embedding });
  record(role, `rpc ${RAG_RPC} (own paid file vector, control)`,
    `top: ${t.ownPaidFileChunk.content.split(" ")[0]} (sim 1.000)`, matchText(r),
    !r.error && r.data[0]?.id === t.ownPaidFileChunk.id && isOne(r.data[0]?.similarity));
  // 自社の未払いファイル由来の chunk のベクトルでも、その行は返らない
  r = await match({ query_embedding: t.ownHiddenChunks[0].embedding, match_count: MATCH_MAX });
  record(role, `rpc ${RAG_RPC} (own unpaid file vector)`, "hidden chunk not returned", matchText(r),
    within(r, visChunkIds) && !rowIds(r).some((x) => hiddenChunkIds.includes(x)));
  // filter_project_id
  r = await match({ query_embedding: t.ownPaidFileChunk.embedding, filter_project_id: t.other[0].id });
  record(role, `rpc ${RAG_RPC} (filter: other company's project)`, "0 rows", matchText(r),
    !r.error && r.data.length === 0);
  const unpaidVisible = t.ownVisibleChunks.filter((x) => x.project_id === t.unpaid.id).map((x) => x.id);
  r = await match({ query_embedding: t.ownPaidFileChunk.embedding, match_count: MATCH_MAX,
    filter_project_id: t.unpaid.id });
  record(role, `rpc ${RAG_RPC} (filter: own unpaid project)`, `${unpaidVisible.length} note chunk(s) only`,
    matchText(r), !r.error && sameSet(rowIds(r), unpaidVisible));
  // #5：件数は 1〜10 に収まる（自社の見える行は 10 以下なので、1000 では見える行が全部返る）
  r = await match({ query_embedding: t.ownPaidFileChunk.embedding, match_count: 1000 });
  record(role, `rpc ${RAG_RPC} (match_count 1000)`, `<= ${MATCH_MAX} (all ${visChunkIds.length} visible)`,
    matchText(r), !r.error && r.data.length <= MATCH_MAX && sameSet(rowIds(r), visChunkIds));
  r = await match({ query_embedding: t.ownPaidFileChunk.embedding, match_count: 0 });
  record(role, `rpc ${RAG_RPC} (match_count 0)`, "1 row", matchText(r),
    !r.error && r.data.length === 1 && within(r, visChunkIds));

  // --- 書き込み（すべて拒否。0 件で終わった場合も、読み直してデータが同じなら PASS）
  const other = t.other[0];
  const otherFile = t.otherFiles[0];
  await writeTest(role, "insert project (own company)", () =>
    c.from("projects").insert({
      name: "verify-probe-self", status: "in_progress", organization_id: t.orgId,
    }).select());
  await writeTest(role, "insert project (other company)", () =>
    c.from("projects").insert({
      name: "verify-probe-other", status: "in_progress", organization_id: other.organization_id,
    }).select());
  await writeTest(role, "insert project with payment_status = paid", () =>
    c.from("projects").insert({
      name: "verify-probe-paid", status: "in_progress", organization_id: t.orgId,
      payment_status: "paid", paid_at: now,
    }).select());
  await writeTest(role, "update own project (move to other company)", () =>
    c.from("projects").update({ organization_id: t.otherOrgId }).eq("id", t.own[0].id).select());
  await writeTest(role, "update other company's project (status)", () =>
    c.from("projects").update({ status: "delivered" }).eq("id", other.id).select());
  await writeTest(role, "delete other company's project", () =>
    c.from("projects").delete().eq("id", other.id).select());
  await writeTest(role, "update own unpaid project (amount)", () =>
    c.from("projects").update({ amount: 100 }).eq("id", t.unpaid.id).select());
  await writeTest(role, "update own unpaid project (status)", () =>
    c.from("projects").update({ status: "delivered" }).eq("id", t.unpaid.id).select());
  await writeTest(role, "update own project (payment_status only)", () =>
    c.from("projects").update({ payment_status: "paid" }).eq("id", t.unpaid.id).select());
  await writeTest(role, "update own project (paid_at only)", () =>
    c.from("projects").update({ paid_at: now }).eq("id", t.unpaid.id).select());
  await writeTest(role, "update own paid project (amount; trigger also blocks)", () =>
    c.from("projects").update({ amount: 100 }).eq("id", t.paid.id).select());
  await writeTest(role, "delete own project", () =>
    c.from("projects").delete().eq("id", t.unpaid.id).select());
  await writeTest(role, "update own profile role = admin", () =>
    c.from("profiles").update({ role: "admin" }).eq("id", ids[t.key]).select());
  await writeTest(role, "insert profile", () =>
    c.from("profiles").insert({ id: randomUUID(), email: "verify-probe@seed.test", role: "client" }).select());
  await writeTest(role, "delete own profile", () =>
    c.from("profiles").delete().eq("id", ids[t.key]).select());
  await writeTest(role, "insert project_files (own project)", () =>
    c.from("project_files").insert({
      project_id: t.own[0].id, file_name: "verify-probe.txt",
      storage_path: `${t.own[0].id}/verify-probe-${randomUUID()}`, size: 1,
    }).select());
  await writeTest(role, "insert project_files (other company's project)", () =>
    c.from("project_files").insert({
      project_id: other.id, file_name: "verify-probe.txt",
      storage_path: `${other.id}/verify-probe-${randomUUID()}`, size: 1,
    }).select());
  await writeTest(role, "delete own visible project_files row", () =>
    c.from("project_files").delete().eq("id", t.ownVisibleFiles[0].id).select());
  await writeTest(role, "delete other company's project_files row", () =>
    c.from("project_files").delete().eq("id", otherFile.id).select());
  await writeTest(role, "insert stripe_events", () =>
    c.from("stripe_events").insert({ event_id: `verify-probe-${randomUUID()}`, event_type: "verify" }).select());

  // 会社とメンバー：書き込みは全部できない（管理者が service_role で行う）
  await writeTest(role, "insert organizations", () =>
    c.from("organizations").insert({ name: "verify-probe" }).select());
  await writeTest(role, "update own organization (name)", () =>
    c.from("organizations").update({ name: "verify-probe" }).eq("id", t.orgId).select());
  await writeTest(role, "delete own organization", () =>
    c.from("organizations").delete().eq("id", t.orgId).select());
  await writeTest(role, "delete other company's organization", () =>
    c.from("organizations").delete().eq("id", t.otherOrgId).select());
  await writeTest(role, "insert organization_members (join other company)", () =>
    c.from("organization_members").insert({ organization_id: t.otherOrgId, user_id: ids[t.key], role: "owner" }).select());
  await writeTest(role, "insert organization_members (add admin to own company)", () =>
    c.from("organization_members").insert({ organization_id: t.orgId, user_id: ids.admin, role: "staff" }).select());
  await writeTest(role, "update own membership role", () =>
    c.from("organization_members").update({ role: t.orgRole === "owner" ? "staff" : "owner" })
      .eq("organization_id", t.orgId).eq("user_id", ids[t.key]).select());
  await writeTest(role, "delete own company's member rows", () =>
    c.from("organization_members").delete().eq("organization_id", t.orgId).select());
  await writeTest(role, "delete other company's member rows", () =>
    c.from("organization_members").delete().eq("organization_id", t.otherOrgId).select());

  // メモと chunk：書き込みは全部できない（管理者だけ）
  const ownNoteProject = t.ownNotes[0].project_id;
  const otherNoteProject = t.otherNotes[0].project_id;
  const chunkProbe = (projectId) => ({
    project_id: projectId, source_type: "note", source_label: "verify-probe", chunk_index: 99,
    content: "verify-probe", embedding: fakeEmbedding(WRITE_PROBE_SLOT), embedding_model: EMBEDDING_MODEL,
  });
  await writeTest(role, "upsert project_notes (own project)", () =>
    c.from("project_notes").upsert({ project_id: ownNoteProject, body: "verify-probe" }).select());
  await writeTest(role, "update own project_notes (body)", () =>
    c.from("project_notes").update({ body: "verify-probe" }).eq("project_id", ownNoteProject).select());
  await writeTest(role, "update other company's project_notes (body)", () =>
    c.from("project_notes").update({ body: "verify-probe" }).eq("project_id", otherNoteProject).select());
  await writeTest(role, "delete own project_notes", () =>
    c.from("project_notes").delete().eq("project_id", ownNoteProject).select());
  await writeTest(role, "insert project_chunks (own project)", () =>
    c.from("project_chunks").insert(chunkProbe(t.own[0].id)).select());
  await writeTest(role, "insert project_chunks (other company's project)", () =>
    c.from("project_chunks").insert(chunkProbe(other.id)).select());
  await writeTest(role, "update own visible project_chunks (content)", () =>
    c.from("project_chunks").update({ content: "verify-probe" }).eq("id", visChunkIds[0]).select());
  await writeTest(role, "delete own visible project_chunks", () =>
    c.from("project_chunks").delete().eq("id", visChunkIds[0]).select());
  await writeTest(role, "delete other company's project_chunks", () =>
    c.from("project_chunks").delete().in("id", otherChunkIds).select());

  // --- Storage
  const visPaths = t.ownVisibleFiles.map((f) => f.storage_path);
  const hiddenPaths = t.ownHiddenFiles.map((f) => f.storage_path);
  const otherPaths = t.otherFiles.map((f) => f.storage_path);
  const allPaths = files.map((f) => f.storage_path);

  const ok = async (paths, fn) => (await Promise.all(paths.map((p) => fn(c, p)))).filter((x) => !x.error).length;

  let n = await ok(visPaths, dl);
  record(role, "download visible files", `${visPaths.length}/${visPaths.length} ok`, `${n}/${visPaths.length} ok`, n === visPaths.length);
  n = await ok(visPaths, sign);
  record(role, "signed URL for visible files", `${visPaths.length}/${visPaths.length} ok`, `${n}/${visPaths.length} ok`, n === visPaths.length);

  n = await ok(hiddenPaths, dl);
  record(role, "download own unpaid project's files", "all denied", `${hiddenPaths.length - n}/${hiddenPaths.length} denied`, n === 0);
  n = await ok(otherPaths, dl);
  record(role, "download other company's files (direct path)", "all denied", `${otherPaths.length - n}/${otherPaths.length} denied`, n === 0);
  n = await ok(hiddenPaths, sign);
  record(role, "signed URL for own unpaid project's files", "all denied", `${hiddenPaths.length - n}/${hiddenPaths.length} denied`, n === 0);
  n = await ok(otherPaths, sign);
  record(role, "signed URL for other company's files", "all denied", `${otherPaths.length - n}/${otherPaths.length} denied`, n === 0);

  const batch = await attempt(() => c.storage.from(BUCKET).createSignedUrls(allPaths, 60));
  const signed = batch.error ? [] : batch.data.filter((x) => !x.error && x.signedUrl).map((x) => x.path);
  record(role, "signed URLs (batch, all 7 paths)", `only the ${visPaths.length} visible paths`,
    batch.error ? describe(batch) : `${signed.length} created`, !batch.error && sameSet(signed, visPaths));

  const rootList = await attempt(() => c.storage.from(BUCKET).list("", { limit: 1000 }));
  const visFolders = [...new Set(t.ownVisibleFiles.map((f) => f.project_id))];
  record(role, "storage list (root)", `folders: ${nameList(visFolders)}`,
    rootList.error ? describe(rootList) : `folders: ${nameList(rootList.data.map((x) => x.name))}`,
    !rootList.error && sameSet(rootList.data.map((x) => x.name), visFolders));
  const hiddenFolders = [...new Set([...t.ownHiddenFiles, ...t.otherFiles].map((f) => f.project_id))];
  let leaked = 0;
  for (const folder of hiddenFolders) {
    const l = await attempt(() => c.storage.from(BUCKET).list(folder, { limit: 1000 }));
    if (!l.error) leaked += l.data.length;
  }
  record(role, "storage list (hidden folders)", "0 entries", `${leaked} entries`, leaked === 0);

  const body = Buffer.from("verify-probe", "utf8");
  const probe = (projectId) => {
    const path = `${projectId}/verify-probe-${randomUUID()}`;
    probePaths.add(path);
    return path;
  };
  await writeTest(role, "storage upload (own project folder)", () =>
    c.storage.from(BUCKET).upload(probe(t.own[0].id), body, { contentType: "text/plain" }));
  await writeTest(role, "storage upload (other company's folder)", () =>
    c.storage.from(BUCKET).upload(probe(other.id), body, { contentType: "text/plain" }));
  await writeTest(role, "storage overwrite existing visible file (upsert)", () =>
    c.storage.from(BUCKET).upload(visPaths[0], body, { contentType: "text/plain", upsert: true }));
  await writeTest(role, "storage remove (own visible + other company's file)", () =>
    c.storage.from(BUCKET).remove([visPaths[0], otherPaths[0]]));

  // --- RPC
  const who = await attempt(() => c.rpc("is_admin"));
  record(role, "rpc is_admin", "false (no escalation)", who.error ? describe(who) : `data=${who.data}`,
    !who.error && who.data === false);
  const rpcBool = async (fn, org, label, expected) => {
    const x = await attempt(() => c.rpc(fn, { org }));
    record(role, `rpc ${fn}(${label})`, String(expected), x.error ? describe(x) : `data=${x.data}`,
      !x.error && x.data === expected);
  };
  await rpcBool("is_org_member", t.orgId, "own company", true);
  await rpcBool("is_org_member", t.otherOrgId, "other company", false);
  await rpcBool("is_org_owner", t.orgId, "own company", t.orgRole === "owner");
  await rpcBool("is_org_owner", t.otherOrgId, "other company", false);
  for (const fn of TRIGGER_RPC) {
    await writeTest(role, `rpc ${fn}`, () => c.rpc(fn), "denied (error), data unchanged");
  }

  // --- 質問の回数（0008）：自分の行でも、表に直接は書けない（回数を戻せない）
  const self = ids[t.key];
  // 値は check 制約（>= 1）を満たすものにする。止まる理由が権限だけになるように
  await deniedErrorTest(role, "[quota] insert own question_usage row", () =>
    c.from("question_usage").insert({ user_id: self, day: utcToday(), question_count: 1 }).select());
  await deniedErrorTest(role, "[quota] update own question_usage (count = 1)", () =>
    c.from("question_usage").update({ question_count: 1 }).eq("user_id", self).select());
  await deniedErrorTest(role, "[quota] delete own question_usage", () =>
    c.from("question_usage").delete().eq("user_id", self).select());
}

// ---------- 4. 管理者（対照） ----------
async function runAdmin() {
  const role = "admin";
  const c = await signIn(`admin${DOMAIN}`);
  const total = async (table) => {
    const r = await admin.from(table).select("*", { count: "exact", head: true });
    return r.error ? null : r.count;
  };
  for (const table of ["projects", "project_files", "profiles", "organizations", "organization_members",
    "project_notes", "project_chunks", INGEST_TABLE]) {
    const expected = await total(table);
    // service_role で数えられない（表が無いなど）ときは、比べられないので FAIL にして次へ
    if (expected === null) {
      record(role, `count ${table}`, "service_role count available", "service_role count failed", false);
      continue;
    }
    const r = await attempt(() => c.from(table).select("*", { count: "exact", head: true }));
    record(role, `count ${table}`, `${expected} (all rows)`, r.error ? describe(r) : `count=${r.count}`,
      !r.error && r.count === expected);
  }
  const n = (await Promise.all(files.map((f) => dl(c, f.storage_path)))).filter((x) => !x.error).length;
  record(role, "download all files", `${files.length}/${files.length} ok`, `${n}/${files.length} ok`, n === files.length);
  const ev = await attempt(() => c.from("stripe_events").select("*"));
  record(role, "select stripe_events", "denied (service_role only)", describe(ev), isDenied(ev));
  const who = await attempt(() => c.rpc("is_admin"));
  record(role, "rpc is_admin", "true", who.error ? describe(who) : `data=${who.data}`, !who.error && who.data === true);

  // RAG の検索：管理者は全社の行が対象
  const b3 = paidFileChunkOf(projects.filter((p) => p.organization_id === orgIds.b));
  const match = (args) => attempt(() => c.rpc(RAG_RPC, args));
  let r = await match({ query_embedding: b3.embedding });
  record(role, `rpc ${RAG_RPC} (B-3 paid file vector)`, `${MATCH_DEFAULT} rows, top: B-3 file chunk (sim 1.000)`,
    r.error ? describe(r) : `${r.data.length} row(s), top sim ${Number(r.data[0]?.similarity).toFixed(3)}`,
    !r.error && r.data.length === MATCH_DEFAULT && r.data[0]?.id === b3.id && isOne(r.data[0]?.similarity));
  // #5：全 13 行が見えるので、1000 を渡しても 10 件で止まる
  r = await match({ query_embedding: b3.embedding, match_count: 1000 });
  record(role, `rpc ${RAG_RPC} (match_count 1000)`, `${MATCH_MAX} rows (of ${chunks.length} visible)`,
    describe(r), !r.error && r.data.length === MATCH_MAX);
  r = await match({ query_embedding: b3.embedding, match_count: 0 });
  record(role, `rpc ${RAG_RPC} (match_count 0)`, "1 row", describe(r), !r.error && r.data.length === 1);
}

// ---------- #7・#8. 支払い後に見える・ファイルを消すと chunk も消える ----------
// seed の既存データは触らない。A社にテスト用の案件（amount あり・unpaid）とファイル 1 行・
// そのファイル由来の chunk 1 行を service_role で作り、最後に finally で必ず消す
// （Storage の実体は作らない。project_files の行だけ）
async function runPaywallAndCascade() {
  const owner = await signIn(`client-a${DOMAIN}`);
  const staff = await signIn(`client-a-staff${DOMAIN}`);
  const otherOrg = await signIn(`client-b${DOMAIN}`);
  const adminUser = await signIn(`admin${DOMAIN}`);
  const viewers = [["client-a", owner], ["client-a-staff", staff]];
  const probeEmbedding = fakeEmbedding(PROBE_SLOT);
  let projectId = null;

  try {
    const p = await admin.from("projects").insert({
      name: "verify-probe-paywall", status: "in_progress", organization_id: orgIds.a, amount: 100,
    }).select("id").single();
    must(p.error, "insert probe project");
    projectId = p.data.id;
    const fileId = randomUUID();
    const f = await admin.from("project_files").insert({
      id: fileId, project_id: projectId, file_name: "verify-probe.txt",
      storage_path: `${projectId}/verify-probe-${fileId}`, size: 1,
    });
    must(f.error, "insert probe project_files");
    const ch = await admin.from("project_chunks").insert({
      project_id: projectId, file_id: fileId, source_type: "file", source_label: "verify-probe.txt",
      chunk_index: 0, content: "CANARY-PROBE-FILE", embedding: probeEmbedding, embedding_model: EMBEDDING_MODEL,
    }).select("id").single();
    must(ch.error, "insert probe project_chunks");
    const chunkId = ch.data.id;

    const see = (c) => attempt(() => c.from("project_chunks").select("id").eq("id", chunkId));
    const search = (c) => attempt(() => c.rpc(RAG_RPC, {
      query_embedding: probeEmbedding, match_count: MATCH_MAX, filter_project_id: projectId,
    }));

    // #7 前半：未払いの間は見えない
    for (const [label, c] of viewers) {
      let r = await see(c);
      record(label, "[#7] select probe file chunk (unpaid)", "0 rows", describe(r), isDenied(r));
      r = await search(c);
      record(label, `[#7] rpc ${RAG_RPC} probe project (unpaid)`, "0 rows", describe(r),
        !r.error && r.data.length === 0);
    }

    // #7 後半：paid にすると見える（paid_at は制約で必須）
    const u = await admin.from("projects")
      .update({ payment_status: "paid", paid_at: new Date().toISOString() }).eq("id", projectId);
    must(u.error, "mark probe project paid");
    for (const [label, c] of viewers) {
      let r = await see(c);
      record(label, "[#7] select probe file chunk (paid)", "1 row", describe(r),
        !r.error && r.data.length === 1 && r.data[0].id === chunkId);
      r = await search(c);
      record(label, `[#7] rpc ${RAG_RPC} probe project (paid)`, "1 row (probe chunk, sim 1.000)",
        r.error ? describe(r) : `${r.data.length} row(s), top sim ${Number(r.data[0]?.similarity).toFixed(3)}`,
        !r.error && r.data.length === 1 && r.data[0].id === chunkId && isOne(r.data[0].similarity));
    }
    // 支払い済みでも、他社からは見えない
    const rb = await see(otherOrg);
    record("client-b", "[#7] select company A's probe file chunk (paid)", "0 rows", describe(rb), isDenied(rb));

    // #8 の準備：テスト用のファイルに、取り込みの状態の行を管理者本人のセッションで作る（0009）。
    // 失敗しても #8 の chunk の確認は続ける（must を使わず、結果として記録する）
    const ing = await attempt(() => adminUser.from(INGEST_TABLE)
      .upsert({ file_id: fileId, ingest_status: "ready", ingested_at: new Date().toISOString() },
        { onConflict: "file_id" })
      .select("file_id"));
    record("admin", `[#8] upsert probe ${INGEST_TABLE} row`, "1 row", describe(ing),
      !ing.error && ing.data?.length === 1);

    // #8：管理者（authenticated・admin ポリシー）がファイルの行を消すと、chunk も状態の行も連鎖で消える
    const d = await attempt(() => adminUser.from("project_files").delete().eq("id", fileId).select("id"));
    record("admin", "[#8] delete probe project_files row", "1 row deleted", describe(d),
      !d.error && d.data?.length === 1);
    const left = await admin.from("project_chunks").select("id", { count: "exact", head: true }).eq("id", chunkId);
    must(left.error, "count probe chunk after file delete");
    record("service", "[#8] probe file chunk after its file is deleted", "0 rows (cascaded)",
      `count=${left.count}`, left.count === 0);
    const ingLeft = await attempt(() => admin.from(INGEST_TABLE)
      .select("file_id", { count: "exact", head: true }).eq("file_id", fileId));
    record("service", `[#8] probe ${INGEST_TABLE} row after its file is deleted`, "0 rows (cascaded)",
      ingLeft.error ? errText(ingLeft.error) : `count=${ingLeft.count}`,
      !ing.error && !ingLeft.error && ingLeft.count === 0);
  } catch (e) {
    record("service", "[#7/#8] probe setup or checks", "no exception", `exception: ${e.message}`, false);
  } finally {
    // 途中で失敗しても、テスト用の案件は必ず消す（ファイル・chunk も連鎖で消える）
    if (projectId) {
      const del = await attempt(() => admin.from("projects").delete().eq("id", projectId));
      const chk = await attempt(() =>
        admin.from("projects").select("id", { count: "exact", head: true }).eq("id", projectId));
      record("service", "[#7/#8] probe project removed", "0 rows left",
        del.error ? errText(del.error) : chk.error ? errText(chk.error) : `count=${chk.count}`,
        !del.error && !chk.error && chk.count === 0);
    }
  }
}

// ---------- 取り込みの状態（0009） ----------
// seed のファイルには状態の行が無い前提。A社の「お客様にも見えるファイル」1 つに、管理者本人のセッションで
// upsert（ready）して、お客様からは見えない・書けないこと、check 制約が効くことを確かめる。
// テストで作った行は、finally で service_role で必ず消す（#7・#8 と同じやり方）
const CHECK_VIOLATION = "23514";

async function runFileIngest() {
  const adminUser = await signIn(`admin${DOMAIN}`);
  const owner = await signIn(`client-a${DOMAIN}`);
  const staff = await signIn(`client-a-staff${DOMAIN}`);
  const otherOrg = await signIn(`client-b${DOMAIN}`);
  const companyA = tenantOf(TENANTS[0]);
  const target = companyA.ownVisibleFiles[0]; // 状態の行を作るファイル
  // お客様の insert を試す、行の無いファイル（同じ A社）
  const spare = [...companyA.ownVisibleFiles, ...companyA.ownHiddenFiles].find((f) => f.id !== target?.id);
  const rowsOk = (r, n) => !r.error && Array.isArray(r.data) && r.data.length === n;

  if (!target || !spare) {
    record("service", "[ingest] seed files for the test", "2 files of company A",
      `target ${target ? "found" : "missing"}, spare ${spare ? "found" : "missing"}`, false);
    return;
  }
  const touched = [target.id, spare.id];

  try {
    // 前提：seed のファイルには状態の行が無い
    const pre = await attempt(() => admin.from(INGEST_TABLE)
      .select("file_id", { count: "exact", head: true }).in("file_id", files.map((f) => f.id)));
    record("service", `[ingest] ${INGEST_TABLE} rows of seed files (before)`, "0 rows",
      pre.error ? errText(pre.error) : `count=${pre.count}`, !pre.error && pre.count === 0);

    // 管理者：upsert（ready）→ 1 行。返ってきた列が 4 列そろっているかも見る
    const up = await attempt(() => adminUser.from(INGEST_TABLE)
      .upsert({ file_id: target.id, ingest_status: "ready", ingest_error: null, ingested_at: new Date().toISOString() },
        { onConflict: "file_id" })
      .select("*"));
    const upCols = rowsOk(up, 1) ? Object.keys(up.data[0]) : [];
    record("admin", `[ingest] upsert ${INGEST_TABLE} (ready)`, `1 row: ${listText(INGEST_COLUMNS)}`,
      up.error ? describe(up) : `${up.data.length} row(s): ${listText(upCols)}`,
      rowsOk(up, 1) && up.data[0].ingest_status === "ready" && sameSet(upCols, INGEST_COLUMNS));
    const back = await attempt(() => adminUser.from(INGEST_TABLE)
      .select("file_id,ingest_status").eq("file_id", target.id));
    record("admin", `[ingest] select ${INGEST_TABLE} (after upsert)`, "1 row (ready)", describe(back),
      rowsOk(back, 1) && back.data[0].ingest_status === "ready");

    // ここからの書き込みテストは、この行がある状態を基準にする
    baseline = await takeSnapshot();

    // 同じ会社のお客様（オーナー・スタッフ）：ファイルの行は見えるが、状態の行は 0 行・書けない
    for (const [label, c] of [["client-a", owner], ["client-a-staff", staff]]) {
      const fileRow = await attempt(() => c.from("project_files").select("id").eq("id", target.id));
      record(label, "[ingest] select the target project_files row (control)", "1 row", describe(fileRow),
        rowsOk(fileRow, 1));
      let r = await attempt(() => c.from(INGEST_TABLE).select("*").eq("file_id", target.id));
      record(label, `[ingest] select ${INGEST_TABLE} (own company's file)`, "0 rows, no error", describe(r),
        rowsOk(r, 0));
      r = await attempt(() => c.from(INGEST_TABLE).select("*"));
      record(label, `[ingest] select * ${INGEST_TABLE}`, "0 rows, no error", describe(r), rowsOk(r, 0));

      await writeTest(label, `[ingest] insert ${INGEST_TABLE} (own company's file)`, () =>
        c.from(INGEST_TABLE).insert({ file_id: spare.id, ingest_status: "ready" }).select());
      await writeTest(label, `[ingest] upsert ${INGEST_TABLE} (own company's file)`, () =>
        c.from(INGEST_TABLE).upsert({ file_id: target.id, ingest_status: "failed", ingest_error: "failed" },
          { onConflict: "file_id" }).select());
      await writeTest(label, `[ingest] update ${INGEST_TABLE} (own company's file)`, () =>
        c.from(INGEST_TABLE).update({ ingest_status: "failed" }).eq("file_id", target.id).select());
      await writeTest(label, `[ingest] delete ${INGEST_TABLE} (own company's file)`, () =>
        c.from(INGEST_TABLE).delete().eq("file_id", target.id).select());
    }

    // 別の会社のお客様：0 行・書けない
    let rb = await attempt(() => otherOrg.from(INGEST_TABLE).select("*").eq("file_id", target.id));
    record("client-b", `[ingest] select ${INGEST_TABLE} (company A's file)`, "0 rows, no error", describe(rb),
      rowsOk(rb, 0));
    rb = await attempt(() => otherOrg.from(INGEST_TABLE).select("*"));
    record("client-b", `[ingest] select * ${INGEST_TABLE}`, "0 rows, no error", describe(rb), rowsOk(rb, 0));
    await writeTest("client-b", `[ingest] insert ${INGEST_TABLE} (company A's file)`, () =>
      otherOrg.from(INGEST_TABLE).insert({ file_id: spare.id, ingest_status: "ready" }).select());
    await writeTest("client-b", `[ingest] update ${INGEST_TABLE} (company A's file)`, () =>
      otherOrg.from(INGEST_TABLE).update({ ingest_status: "failed" }).eq("file_id", target.id).select());

    // check 制約：決めた種類以外は、管理者でも入れられない
    for (const [column, value] of [["ingest_error", "boom"], ["ingest_status", "boom"]]) {
      const r = await attempt(() => adminUser.from(INGEST_TABLE)
        .update({ [column]: value }).eq("file_id", target.id).select());
      const same = await checkUnchanged();
      record("admin", `[ingest] update ${column} = '${value}'`,
        `error ${CHECK_VIOLATION} (check constraint), data unchanged`, describe(r),
        r.error?.code === CHECK_VIOLATION && same, same ? "" : "DATA CHANGED (rebuild with seed.mjs)");
    }
    // 対照：決めた種類なら入る（制約がすべてを拒否しているのではないこと）
    const ok = await attempt(() => adminUser.from(INGEST_TABLE)
      .update({ ingest_status: "failed", ingest_error: "too_many_pages" }).eq("file_id", target.id).select());
    record("admin", "[ingest] update ingest_error = 'too_many_pages' (control)", "1 row updated", describe(ok),
      rowsOk(ok, 1) && ok.data[0].ingest_error === "too_many_pages");
  } catch (e) {
    record("service", "[ingest] setup or checks", "no exception", `exception: ${e.message}`, false);
  } finally {
    // 途中で失敗しても、テストで作った状態の行は必ず消す
    const del = await attempt(() => admin.from(INGEST_TABLE).delete().in("file_id", touched));
    const chk = await attempt(() => admin.from(INGEST_TABLE)
      .select("file_id", { count: "exact", head: true }).in("file_id", touched));
    record("service", `[ingest] ${INGEST_TABLE} test rows removed`, "0 rows left",
      del.error ? errText(del.error) : chk.error ? errText(chk.error) : `count=${chk.count}`,
      !del.error && !chk.error && chk.count === 0);
    baseline = await takeSnapshot();
  }
}

// ---------- 質問の回数制限（0008） ----------
// 回数の行は、テストの前（main）と、ここの最初と finally で、seed ユーザーの分を消す。
// 「呼んだ人が数えられる」「同時に呼んでもちょうど上限まで」「上限の後は止まる」は PostgREST 経由で、
// 「uid が null なら例外」「昨日の分は今日に効かない」は rollback で終わるトランザクションで確かめる
const QUOTA_ROWS_SQL = `
  select u.user_id::text as user_id, u.day::text as day, u.question_count,
         ((now() at time zone 'utc')::date)::text as utc_today
  from public.question_usage u
  where u.user_id = any($1::uuid[])
  order by 2`;

async function runQuestionQuota() {
  const role = "service";
  const owner = await signIn(`client-a${DOMAIN}`);
  const staff = await signIn(`client-a-staff${DOMAIN}`);
  const otherOrg = await signIn(`client-b${DOMAIN}`);
  const call = (c) => attempt(() => c.rpc(QUOTA_RPC));
  const one = (r) => (!r.error && Array.isArray(r.data) && r.data.length === 1 ? r.data[0] : null);
  const show = (r) => {
    const x = one(r);
    return x ? `allowed=${x.allowed}, remaining=${x.remaining}` : describe(r);
  };
  const rowsOf = (userId) => queryLocalDb(QUOTA_ROWS_SQL, [[userId]]);
  const full = DAILY_QUESTION_LIMIT;

  try {
    await deleteSeedQuotaRows();

    // 1 回目：受け付けて、残りは上限 - 1
    let r = await call(owner);
    let x = one(r);
    record("client-a", `[quota] rpc ${QUOTA_RPC} (1st call)`, `allowed=true, remaining=${full - 1}`, show(r),
      x?.allowed === true && x?.remaining === full - 1);

    // 行は本人・UTC の今日・1 回
    let rows = await rowsOf(ids.a);
    record(role, "[quota] client-a's question_usage after 1st call", "1 row: today (UTC), count 1",
      rows.map((y) => `${y.day === y.utc_today ? "today" : y.day}: ${y.question_count}`).join(", ") || "(none)",
      rows.length === 1 && rows[0].day === rows[0].utc_today && rows[0].day === utcToday() &&
        rows[0].question_count === 1);

    // 人ごとに数える（同じ会社のスタッフも、別の会社のオーナーも、client-a の分に影響されない）
    for (const [label, c] of [["client-a-staff", staff], ["client-b", otherOrg]]) {
      r = await call(c);
      x = one(r);
      record(label, `[quota] rpc ${QUOTA_RPC} (own 1st call, counted per user)`,
        `allowed=true, remaining=${full - 1}`, show(r), x?.allowed === true && x?.remaining === full - 1);
    }

    // 同時に呼ぶ：行を消してから 25 回を一度に。ちょうど上限の回数だけ通る
    await deleteSeedQuotaRows();
    const burst = await Promise.all(Array.from({ length: CONCURRENT_QUOTA_CALLS }, () => call(owner)));
    const outs = burst.map(one);
    const errors = outs.filter((y) => y === null).length;
    const allowed = outs.filter((y) => y?.allowed === true);
    const denied = outs.filter((y) => y?.allowed === false);
    record("client-a", `[quota] ${CONCURRENT_QUOTA_CALLS} concurrent calls: allowed / denied`,
      `${full} allowed, ${CONCURRENT_QUOTA_CALLS - full} denied (remaining=0), 0 errors`,
      `${allowed.length} allowed, ${denied.length} denied, ${errors} errors`,
      errors === 0 && allowed.length === full && denied.length === CONCURRENT_QUOTA_CALLS - full &&
        denied.every((y) => y.remaining === 0));
    const remainings = allowed.map((y) => y.remaining).sort((a, b) => a - b);
    const expectedRemainings = Array.from({ length: full }, (_, i) => i);
    record("client-a", `[quota] ${CONCURRENT_QUOTA_CALLS} concurrent calls: remaining values`,
      `0..${full - 1}, each once`, remainings.length ? `${remainings.join(",")}` : "(none)",
      remainings.length === full && remainings.every((v, i) => v === expectedRemainings[i]));
    rows = await rowsOf(ids.a);
    record(role, `[quota] client-a's count after ${CONCURRENT_QUOTA_CALLS} concurrent calls`, `1 row, count ${full}`,
      rows.map((y) => `${y.day}: ${y.question_count}`).join(", ") || "(none)",
      rows.length === 1 && rows[0].question_count === full);

    // 上限の後：止まり、回数は増えない
    r = await call(owner);
    x = one(r);
    record("client-a", `[quota] rpc ${QUOTA_RPC} (call ${full + 1}+)`, "allowed=false, remaining=0", show(r),
      x?.allowed === false && x?.remaining === 0);
    rows = await rowsOf(ids.a);
    record(role, "[quota] client-a's count after the limit", `still ${full}`,
      rows.map((y) => `${y.day}: ${y.question_count}`).join(", ") || "(none)",
      rows.length === 1 && rows[0].question_count === full);

    // uid が null（JWT の sub が無い）なら例外。authenticated のまま claims を入れずに呼ぶ
    const noUid = await inRolledBackTransaction(async (db) => {
      await db.query("set local role authenticated");
      try {
        await db.query("select * from public.consume_question_quota()");
        return { threw: false };
      } catch (e) {
        return { threw: true, code: e.code, message: e.message };
      }
    });
    record(role, `[quota] ${QUOTA_RPC} without a user id (rolled back)`, "error 42501: not authenticated",
      noUid.threw ? `error ${noUid.code}: ${String(noUid.message).slice(0, 70)}` : "no error",
      noUid.threw && noUid.code === "42501" && /not authenticated/.test(noUid.message));

    // 日付の境目：昨日（UTC）が上限でも、今日は 1 回目として通る。
    // client-a の今日の行（上限）はトランザクションの中で消し、最後に rollback で元に戻る
    const boundary = await inRolledBackTransaction(async (db) => {
      await db.query("delete from public.question_usage where user_id = $1", [ids.a]);
      await db.query(
        `insert into public.question_usage (user_id, day, question_count)
         values ($1, (now() at time zone 'utc')::date - 1, $2)`, [ids.a, full]);
      await db.query("set local role authenticated");
      await db.query("select set_config('request.jwt.claims', $1, true)",
        [JSON.stringify({ sub: ids.a, role: "authenticated" })]);
      const res = (await db.query("select allowed, remaining from public.consume_question_quota()")).rows;
      await db.query("reset role");
      const left = (await db.query(
        `select u.day = (now() at time zone 'utc')::date as is_today, u.question_count
         from public.question_usage u where u.user_id = $1 order by u.day`, [ids.a])).rows;
      return { res, left };
    });
    const bx = boundary.res[0];
    record(role, `[quota] ${QUOTA_RPC} when yesterday (UTC) is at the limit (rolled back)`,
      `allowed=true, remaining=${full - 1}; yesterday ${full}, today 1`,
      `${bx ? `allowed=${bx.allowed}, remaining=${bx.remaining}` : "no row"}; ` +
        boundary.left.map((y) => `${y.is_today ? "today" : "yesterday"} ${y.question_count}`).join(", "),
      boundary.res.length === 1 && bx.allowed === true && bx.remaining === full - 1 &&
        boundary.left.length === 2 &&
        boundary.left[0].is_today === false && boundary.left[0].question_count === full &&
        boundary.left[1].is_today === true && boundary.left[1].question_count === 1);

    // rollback で元に戻ったこと（今日の上限の行だけ。昨日の行は残っていない）
    rows = await rowsOf(ids.a);
    record(role, "[quota] rolled-back transactions left no changes", `1 row: today (UTC), count ${full}`,
      rows.map((y) => `${y.day === y.utc_today ? "today" : y.day}: ${y.question_count}`).join(", ") || "(none)",
      rows.length === 1 && rows[0].day === rows[0].utc_today && rows[0].question_count === full);
  } catch (e) {
    record(role, "[quota] setup or checks", "no exception", `exception: ${e.message}`, false);
  } finally {
    // 途中で失敗しても、seed ユーザーの回数の行は必ず消す
    const res = await attempt(async () => {
      await deleteSeedQuotaRows();
      const left = await queryLocalDb(QUOTA_ROWS_SQL, [seedUserIds()]);
      return { data: left, error: null };
    });
    record(role, "[quota] seed users' question_usage rows removed", "0 rows left",
      res.error ? errText(res.error) : `${res.data.length} row(s) left`,
      !res.error && res.data.length === 0);
  }
}

// ---------- 関数の EXECUTE（ローカルの Postgres で has_function_privilege） ----------
// match_project_chunks：service_role で呼ぶと RLS を通らず全社の行が返るので、authenticated だけ
// consume_question_quota：auth.uid() の無い呼び出しでは使わないので、authenticated だけ
const FUNCTION_EXECUTE_SQL = `
  select r.role,
         has_function_privilege(r.role::name, $1::text, 'EXECUTE') as can_execute
  from (values ('anon'), ('authenticated'), ('service_role')) as r(role)
  order by 1`;

async function runFunctionPrivileges() {
  for (const fn of FUNCTION_EXECUTE_CHECKS) {
    let rows;
    try {
      rows = await queryLocalDb(FUNCTION_EXECUTE_SQL, [fn.signature]);
    } catch (e) {
      record("grants:function", `query EXECUTE on ${fn.name} (local Postgres)`, "query succeeds",
        `error: ${String(e.message).slice(0, 70)}`, false);
      continue;
    }
    for (const [roleName, expected] of Object.entries(fn.expected)) {
      const row = rows.find((x) => x.role === roleName);
      record("grants:function", `EXECUTE on ${fn.name} for ${roleName}`, String(expected),
        row ? String(row.can_execute) : "missing", row?.can_execute === expected);
    }
  }
}

// service_role の RPC：EXECUTE が無いので、呼べない（回数も増えない）
async function runQuotaServiceRoleCall() {
  await deniedErrorTest("service", `[quota] rpc ${QUOTA_RPC} with service_role key`, () => admin.rpc(QUOTA_RPC));
}

// ---------- 列の読み取り（SELECT）の確認 ----------
// ctx = { expected: 期待値, control: null または { table, column }（陽性対照） }

const listText = (cols) => (cols.length ? [...cols].sort().join(", ") : "(none)");

function diffColumns(expected, actual) {
  const e = new Set(expected);
  const a = new Set(actual);
  return {
    extra: [...a].filter((c) => !e.has(c)).sort(),
    missing: [...e].filter((c) => !a.has(c)).sort(),
  };
}

// 期待値と実際の列を比べて記録する。
// 陽性対照の対象（authenticated の指定テーブル）だけは、仕込んだ差を「検出できたら」PASS
function recordColumnCheck(ctx, role, group, table, op, actual, problem = "") {
  const expected = ctx.expected[group][table];
  const { extra, missing } = diffColumns(expected, actual);
  const diffText = [
    extra.length ? `extra: ${extra.join(", ")}` : "",
    missing.length ? `missing: ${missing.join(", ")}` : "",
  ].filter(Boolean).join(" | ");

  const isTarget = ctx.control && group === "authenticated" && table === ctx.control.table;
  if (isTarget) {
    const detected =
      !problem &&
      sameSet(extra, [ctx.control.column]) && extra.length === 1 &&
      sameSet(missing, [CONTROL_FAKE_COLUMN]) && missing.length === 1;
    record(role, `[control] ${op}`,
      `FAIL detected (extra: ${ctx.control.column} | missing: ${CONTROL_FAKE_COLUMN})`,
      diffText ? `detected → ${diffText}` : "NOT detected (columns matched)", detected,
      detected ? "" : `the column check did not catch the planted difference${problem ? `; ${problem}` : ""}`);
    return;
  }
  record(role, op, listText(expected), diffText || `match (${actual.length} columns)`,
    !diffText && !problem, problem);
}

// 1. 権限：information_schema.columns の全列について has_column_privilege（表全体の権限も含む）
const GRANTS_SQL = `
  select c.table_name::text  as table_name,
         c.column_name::text as column_name,
         r.role              as role,
         has_column_privilege(r.role::name,
                              format('%I.%I', c.table_schema, c.table_name),
                              c.column_name::text, 'SELECT') as can_select
  from information_schema.columns c
  cross join (values ('anon'), ('authenticated')) as r(role)
  where c.table_schema = 'public'
  order by 1, 2, 3`;

// ローカルの Postgres へのクライアント（127.0.0.1 以外なら、loadLocalDbConfig で終了する）
function newLocalDbClient() {
  const db = loadLocalDbConfig();
  if (!secrets.includes(db.password)) secrets.push(db.password);
  return new pg.Client({ ...db, connectionTimeoutMillis: 5000, application_name: "verify-rls" });
}

// ローカルの Postgres に読み取り専用でつなぎ、SELECT を 1 つ流して行を返す
async function queryLocalDb(sql, params = []) {
  const client = newLocalDbClient();
  try {
    await client.connect();
    await client.query("set default_transaction_read_only = on"); // 読むだけ
    return (await client.query(sql, params)).rows;
  } finally {
    await client.end().catch(() => {});
  }
}

// ---- 書き込みもできる接続：用途は次の 2 つだけ（ほかの目的には使わない）----

// seed ユーザー（admin・client-a・client-a-staff・client-b）の ID
function seedUserIds() {
  const list = [ids.admin, ...TENANTS.map((t) => ids[t.key])];
  if (list.some((id) => !id)) throw new Error("seed user ids are not loaded");
  return list;
}

// 1. question_usage の、seed ユーザーの行を消す（消した行数を返す）
async function deleteSeedQuotaRows() {
  const client = newLocalDbClient();
  try {
    await client.connect();
    const r = await client.query(
      "delete from public.question_usage where user_id = any($1::uuid[])", [seedUserIds()]);
    return r.rowCount;
  } finally {
    await client.end().catch(() => {});
  }
}

// 2. rollback で終わるトランザクションの中で fn(client) を動かす（成功しても失敗しても必ず rollback）
async function inRolledBackTransaction(fn) {
  const client = newLocalDbClient();
  try {
    await client.connect();
    await client.query("begin");
    return await fn(client);
  } finally {
    await client.query("rollback").catch(() => {});
    await client.end().catch(() => {});
  }
}

async function runColumnGrants(ctx) {
  let rows;
  try {
    rows = await queryLocalDb(GRANTS_SQL);
  } catch (e) {
    record("grants", "query column privileges (local Postgres)", "query succeeds",
      `error: ${String(e.message).slice(0, 70)}`, false);
    return;
  }

  if (rows.length === 0) {
    record("grants", "information_schema.columns (public)", "columns listed", "0 rows", false,
      "cannot check column privileges without the column list");
    return;
  }

  // public にあるテーブル（とビュー）は、期待値にある 6 つだけのはず
  const tables = [...new Set(rows.map((r) => r.table_name))].sort();
  const unknown = tables.filter((t) => !PUBLIC_TABLES.includes(t));
  const absent = PUBLIC_TABLES.filter((t) => !tables.includes(t));
  const unknownReadable = unknown.map((t) => {
    const readable = (role) => rows.filter((r) => r.table_name === t && r.role === role && r.can_select).length;
    return `${t} (anon ${readable("anon")}, authenticated ${readable("authenticated")} readable columns)`;
  });
  record("grants", "tables and views in public", listText(PUBLIC_TABLES), listText(tables),
    unknown.length === 0 && absent.length === 0,
    [unknown.length ? `not in expected list: ${unknownReadable.join("; ")}` : "",
      absent.length ? `missing: ${absent.join(", ")}` : ""].filter(Boolean).join(" | "));

  for (const group of ["anon", "authenticated"]) {
    for (const table of PUBLIC_TABLES) {
      const actual = rows
        .filter((r) => r.role === group && r.table_name === table && r.can_select)
        .map((r) => r.column_name);
      recordColumnCheck(ctx, `grants:${group}`, group, table, `SELECT privilege: ${table} columns`, actual);
    }
  }
}

// 2. 実際の読み取り：ログインして select * し、返ってきた列名を比べる
async function runColumnReads(ctx) {
  const users = [
    ...TENANTS.map((t) => [t.label, t.email]),
    ["admin", `admin${DOMAIN}`],
  ];
  for (const [role, email] of users) {
    const c = await signIn(email);
    for (const table of PUBLIC_TABLES) {
      const expected = ctx.expected.authenticated[table];
      const op = `select * ${table}: returned columns`;
      const r = await attempt(() => c.from(table).select("*"));

      // 行が管理者にしか見えない表（0009）：
      // お客様は「エラーなし・0 行」で PASS（エラーは表が無い・権限が無いことを示すので FAIL）。
      // 管理者は seed に行が無いので、ここでは「エラーなし・0 行」だけを見る（列は [ingest] のテストで見る）
      if (ADMIN_ONLY_ROW_TABLES.includes(table)) {
        const ok = !r.error && Array.isArray(r.data) && r.data.length === 0;
        record(role, op, role === "admin" ? "0 rows, no error (seed has no rows)" : "0 rows, no error (RLS)",
          describe(r), ok);
        continue;
      }

      // 読めてよい列がないテーブル：エラーか 0 件なら PASS
      if (expected.length === 0) {
        const keys = !r.error && Array.isArray(r.data) ? [...new Set(r.data.flatMap(Object.keys))] : [];
        record(role, op, "no columns readable (error or 0 rows)", describe(r), isDenied(r),
          keys.length ? `returned columns: ${listText(keys)}` : "");
        continue;
      }

      // 1 行も返らなければ、列を確かめられないので FAIL
      if (r.error || !Array.isArray(r.data) || r.data.length === 0) {
        const isTarget = ctx.control && table === ctx.control.table;
        record(role, isTarget ? `[control] ${op}` : op, listText(expected), describe(r), false,
          "no rows returned, so the column check could not run");
        continue;
      }

      // 全行の列名がそろっているかも見る
      const shapes = new Set(r.data.map((row) => Object.keys(row).sort().join(",")));
      const actual = [...new Set(r.data.flatMap(Object.keys))];
      recordColumnCheck(ctx, role, "authenticated", table, `${op} (${r.data.length} rows)`, actual,
        shapes.size === 1 ? "" : `rows have different column sets (${shapes.size} shapes)`);
    }
  }
}

async function runColumnChecks(ctx) {
  await runColumnGrants(ctx);
  await runColumnReads(ctx);
}

// 3. service_role の表の権限：has_table_privilege で 8 種類を当てる（MAINTAIN は information_schema に出ないため）
//    余分（extra）＝外したはずの権限が残っている / 足りない（missing）＝アプリが使う権限が無い
const SERVICE_ROLE_PRIVILEGES_SQL = `
  select t.table_name,
         p.privilege,
         has_table_privilege('service_role', format('public.%I', t.table_name), p.privilege) as granted
  from unnest($1::text[]) as t(table_name)
  cross join unnest($2::text[]) as p(privilege)
  order by 1, 2`;

async function runServiceRolePrivileges() {
  const tables = Object.keys(EXPECTED_SERVICE_ROLE_PRIVILEGES);
  let rows;
  try {
    rows = await queryLocalDb(SERVICE_ROLE_PRIVILEGES_SQL, [tables, TABLE_PRIVILEGES]);
  } catch (e) {
    record("grants:service_role", "query table privileges (local Postgres)", "query succeeds",
      `error: ${String(e.message).slice(0, 70)}`, false);
    return;
  }

  for (const table of tables) {
    const expected = EXPECTED_SERVICE_ROLE_PRIVILEGES[table];
    const actual = rows.filter((r) => r.table_name === table && r.granted).map((r) => r.privilege);
    const { extra, missing } = diffColumns(expected, actual);
    const diffText = [
      extra.length ? `extra (should be revoked): ${extra.join(", ")}` : "",
      missing.length ? `missing (app needs it): ${missing.join(", ")}` : "",
    ].filter(Boolean).join(" | ");
    record("grants:service_role", `table privileges: ${table} (of ${TABLE_PRIVILEGES.length} checked)`,
      listText(expected), diffText || `match (${actual.length} privileges)`, !diffText);
  }
}

// 4. question_usage の anon・authenticated の表の権限（8 種類とも無いこと）
//    列の確認は SELECT だけなので、INSERT・UPDATE・DELETE なども表全体で確かめる
const ROLE_TABLE_PRIVILEGES_SQL = `
  select r.role,
         p.privilege,
         has_table_privilege(r.role::name, $1::text, p.privilege) as granted
  from unnest($2::text[]) as r(role)
  cross join unnest($3::text[]) as p(privilege)
  order by 1, 2`;

async function runQuotaTablePrivileges() {
  const roles = Object.keys(EXPECTED_QUOTA_TABLE_PRIVILEGES);
  let rows;
  try {
    rows = await queryLocalDb(ROLE_TABLE_PRIVILEGES_SQL, ["public.question_usage", roles, TABLE_PRIVILEGES]);
  } catch (e) {
    record("grants", "query question_usage table privileges (local Postgres)", "query succeeds",
      `error: ${String(e.message).slice(0, 70)}`, false);
    return;
  }
  for (const roleName of roles) {
    const expected = EXPECTED_QUOTA_TABLE_PRIVILEGES[roleName];
    const actual = rows.filter((r) => r.role === roleName && r.granted).map((r) => r.privilege);
    const { extra, missing } = diffColumns(expected, actual);
    const diffText = [
      extra.length ? `extra (should be revoked): ${extra.join(", ")}` : "",
      missing.length ? `missing: ${missing.join(", ")}` : "",
    ].filter(Boolean).join(" | ");
    record(`grants:${roleName}`, `table privileges: question_usage (of ${TABLE_PRIVILEGES.length} checked)`,
      listText(expected), diffText || `match (${actual.length} privileges)`, !diffText);
  }
}

// --positive-control[=table.column]：期待値の写しから 1 列を抜き、存在しない列を 1 つ足して、
// 列の確認が FAIL を出せることを確かめる。本物の期待値（EXPECTED_READABLE_COLUMNS）は変えない
function parseControlArg(argv) {
  const arg = argv.find((a) => a === "--positive-control" || a.startsWith("--positive-control="));
  if (!arg) return null;
  const target = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : DEFAULT_CONTROL_TARGET;
  const [table, column, rest] = target.split(".");
  if (!table || !column || rest !== undefined ||
      !EXPECTED_READABLE_COLUMNS.authenticated[table]?.includes(column)) {
    throw new Error(
      `--positive-control: "${target}" is not a column in the authenticated expected list (use table.column)`);
  }
  return { table, column };
}

function buildControlExpected({ table, column }) {
  const copy = structuredClone(EXPECTED_READABLE_COLUMNS);
  copy.authenticated[table] = copy.authenticated[table].filter((c) => c !== column).concat(CONTROL_FAKE_COLUMN);
  return copy;
}

// ---------- 公開されている RPC の一覧 ----------
// /rest/v1/ の OpenAPI から /rpc/ の関数名を取る。取れなければ null
async function fetchRpcNames(headers) {
  try {
    const res = await cfg.fetch(`${cfg.url}/rest/v1/`, { headers });
    if (!res.ok) return { names: null, status: res.status };
    const spec = await res.json();
    const names = Object.keys(spec.paths ?? {}).filter((p) => p.startsWith("/rpc/")).map((p) => p.slice(5));
    return { names, status: res.status };
  } catch {
    return { names: null, status: "exception" };
  }
}

async function runRpcList() {
  // service_role（全体像）
  const svc = await fetchRpcNames({ apikey: cfg.serviceKey, Authorization: `Bearer ${cfg.serviceKey}` });
  if (svc.names === null) {
    record("service", "exposed RPC functions (OpenAPI)", "list available",
      `OpenAPI unavailable (HTTP ${svc.status}); used names from migrations`, true,
      "is_admin and trigger functions were checked by name");
  } else {
    const extra = svc.names.filter((f) => !KNOWN_RPC.includes(f));
    record("service", "exposed RPC functions (OpenAPI)", "only functions from migrations",
      `found: ${[...svc.names].sort().join(", ") || "(none)"}${extra.length ? ` | unexpected: ${extra.join(", ")}` : ""}`,
      extra.length === 0);
  }

  // 攻撃者側から見える関数：anon キーだけ / client-a のトークン
  const ca = await signIn(`client-a${DOMAIN}`);
  const session = await ca.auth.getSession();
  const token = session.data.session?.access_token;
  if (token) secrets.push(token);
  const viewers = [
    ["anon", { apikey: cfg.anonKey }],
    ["client-a", { apikey: cfg.anonKey, Authorization: `Bearer ${token}` }],
  ];
  const expectText = `only ${AUTH_RPC.join(", ")} visible`;
  for (const [role, headers] of viewers) {
    const seen = await fetchRpcNames(headers);
    if (seen.names === null) {
      record(role, "visible RPC functions (OpenAPI)", expectText,
        `skipped: OpenAPI not available to this role (HTTP ${seen.status})`, true,
        "could not list; the functions were still called by name above");
      continue;
    }
    const extra = seen.names.filter((f) => !AUTH_RPC.includes(f));
    record(role, "visible RPC functions (OpenAPI)", expectText,
      `visible: ${[...seen.names].sort().join(", ") || "(none)"}`, extra.length === 0,
      extra.length ? `visible but unexpected: ${extra.join(", ")}` : "");
  }
}

// ---------- 5. 後片付けの確認 ----------
async function runCleanupCheck(initial) {
  await removeProbeObjects();
  const objects = await listAllObjects();
  const registered = files.map((f) => f.storage_path);
  record("service", "bucket file count", `${files.length} (no leftovers)`, `${objects.length}`,
    objects.length === files.length && sameSet(objects.map((o) => o.name), registered));
  const final = await takeSnapshot();
  record("service", "data unchanged after all tests", "identical to the initial snapshot",
    final === initial ? "identical" : "DIFFERENT", final === initial);
}

// ---------- 出力 ----------
function report({ file = REPORT_FILE, mode = "full" } = {}) {
  const pass = results.filter((r) => r.result === "PASS").length;
  const fail = results.length - pass;
  console.table(results.map(({ role, op, expect, actual, result }) => ({ role, op, expect, actual, result })));
  console.log(`\nPASS ${pass} / FAIL ${fail} (total ${results.length})`);
  if (strayRemoved.length) console.log(`stray storage objects removed: ${strayRemoved.length}`);
  for (const r of results.filter((x) => x.result === "FAIL")) console.log(`FAIL: [${r.role}] ${r.op} -> ${r.actual}`);

  const esc = (s) => String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");
  const lines = [
    "# RLS verification report", "",
    `- Run at: ${new Date().toISOString()}`,
    `- Target: local Supabase (${cfg.url})`,
    `- Mode: ${mode}`,
    `- Result: ${pass} PASS / ${fail} FAIL (total ${results.length})`, "",
    "| Role | Operation | Expected | Actual | Result |", "|---|---|---|---|---|",
    ...results.map((r) => `| ${esc(r.role)} | ${esc(r.op)} | ${esc(r.expect)} | ${esc(r.actual)} | ${r.result} |`), "",
  ];
  const notes = results.filter((r) => r.note);
  if (notes.length) lines.push("## Notes", "", ...notes.map((r) => `- [${r.role}] ${r.op}: ${r.note}`), "");
  lines.push("## Stray storage objects removed", "",
    strayRemoved.length ? strayRemoved.map((p) => `- ${p}`).join("\n") : "None.", "",
    "## Rebuild", "", "If a test changed data, rebuild with `node scripts/local-seed/seed.mjs`.",
    "This script never changes RLS policies or migrations.", "");
  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(file, redact(lines.join("\n")));
  console.log(`report: scripts/local-seed/reports/${file.split("/").pop()}`);
  return fail;
}

async function main() {
  const control = parseControlArg(process.argv.slice(2)); // 不明な列なら、何もせずに終了
  cfg = await loadLocalConfig({ requireAnon: true });
  secrets = [cfg.serviceKey, cfg.anonKey, SEED_PASSWORD];
  admin = cfg.makeClient(cfg.serviceKey);

  await loadSeed();

  // 陽性対照：列の確認だけを、書き換えた期待値の写しで走らせる（読み取りのみ）
  if (control) {
    const mode = `positive control (expected list copy: dropped ${control.table}.${control.column}, ` +
      `added ${control.table}.${CONTROL_FAKE_COLUMN})`;
    console.log(mode);
    await runColumnChecks({ expected: buildControlExpected(control), control });
    process.exitCode = report({ file: CONTROL_REPORT_FILE, mode }) > 0 ? 1 : 0;
    return;
  }

  // 前の実行やアプリの手動確認で残った、seed ユーザーの質問の回数を消してから基準を取る
  const staleQuotaRows = await deleteSeedQuotaRows();
  if (staleQuotaRows) console.log(`removed ${staleQuotaRows} stale question_usage row(s) of seed users`);

  baseline = await takeSnapshot();
  const initial = baseline;

  await runAnon();
  for (const tenant of TENANTS) {
    const t = tenantOf(tenant);
    await runTenant(t, await signIn(t.email));
  }
  await runAdmin();
  await runPaywallAndCascade();
  await runFileIngest();
  await runQuotaServiceRoleCall();
  await runQuestionQuota();
  await runColumnChecks({ expected: EXPECTED_READABLE_COLUMNS, control: null });
  await runServiceRolePrivileges();
  await runQuotaTablePrivileges();
  await runFunctionPrivileges();
  await runRpcList();
  await runCleanupCheck(initial);

  process.exitCode = report() > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error(`[verify] failed: ${redact(err.message)}`);
  process.exit(1);
});
