// RLS 検証：anon・会社A・会社B・管理者の立場で操作して、期待どおりか確認する。
// 攻撃役は anon キー＋パスワードログインだけ。service_role は「準備」「読み直し」
// 「このスクリプトが作った Storage の残骸の掃除」にだけ使う。
// FAIL が出ても RLS や migrations は直さない（報告だけ）。
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadLocalConfig, loadLocalDbConfig } from "./guard.mjs";

// ---------- 列の読み取り（SELECT）の期待値 ----------
// ロールごと・テーブルごとに「読めてよい列」。これ以外の列が読める、または足りなければ FAIL。
// authenticated は client-a・client-b・admin の共通（同じロールなので、列の権限も同じ）。
// 行の範囲は RLS が決めるので、ここでは列だけを見る。
const EXPECTED_READABLE_COLUMNS = deepFreeze({
  anon: {
    profiles: [],
    projects: [],
    project_files: [],
    stripe_events: [],
  },
  authenticated: {
    profiles: ["id", "email", "name", "role", "created_at"],
    projects: [
      "id", "name", "status", "client_id", "created_at", "updated_at",
      "amount", "payment_status", "paid_at", "stripe_session_id",
    ],
    project_files: ["id", "project_id", "file_name", "storage_path", "size", "uploaded_at"],
    stripe_events: [],
  },
});
const PUBLIC_TABLES = Object.keys(EXPECTED_READABLE_COLUMNS.authenticated);
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
// migrations（0001・0003・0004）にある public の関数
const KNOWN_RPC = [
  "is_admin", "handle_new_user", "set_updated_at",
  "prevent_paid_amount_change", "prevent_profile_role_change", "rls_auto_enable",
];
const TRIGGER_RPC = KNOWN_RPC.filter((n) => n !== "is_admin");

let cfg; // guard が返した設定
let admin; // service_role クライアント（準備・読み直し・掃除だけ）
let baseline; // 書き込みテスト前のスナップショット
let secrets = [];
const ids = {}; // { admin, a, b } のユーザー ID
let projects = [];
let files = [];
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
  const objects = await listAllObjects();
  return JSON.stringify({ p: p.data, f: f.data, pr: pr.data, ev: ev.data, objects });
}

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

// ---------- 準備 ----------
async function loadSeed() {
  const list = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  must(list.error, "listUsers");
  const byEmail = (e) => list.data.users.find((u) => u.email === e)?.id;
  ids.admin = byEmail(`admin${DOMAIN}`);
  ids.a = byEmail(`client-a${DOMAIN}`);
  ids.b = byEmail(`client-b${DOMAIN}`);
  if (!ids.admin || !ids.a || !ids.b) {
    throw new Error("seed users not found. Run: node scripts/local-seed/seed.mjs");
  }
  const p = await admin.from("projects").select("*").in("client_id", [ids.a, ids.b]).order("name");
  must(p.error, "load projects");
  projects = p.data;
  const f = await admin.from("project_files").select("*").in("project_id", projects.map((x) => x.id));
  must(f.error, "load project_files");
  files = f.data;
  if (projects.length !== 6 || files.length !== 7) {
    throw new Error(`unexpected seed shape (projects ${projects.length}, files ${files.length}). Run seed.mjs`);
  }
}

// 期待値は、DB の中身（amount と payment_status）から導く
function tenantOf(key) {
  const own = projects.filter((p) => p.client_id === ids[key]);
  const other = projects.filter((p) => p.client_id !== ids[key]);
  const visible = (p) => p.amount === null || p.payment_status === "paid";
  const filesOf = (ps) => files.filter((f) => ps.some((p) => p.id === f.project_id));
  return {
    key, label: `client-${key}`, email: `client-${key}${DOMAIN}`, own, other,
    ownVisibleFiles: filesOf(own.filter(visible)),
    ownHiddenFiles: filesOf(own.filter((p) => !visible(p))),
    otherFiles: filesOf(other),
    unpaid: own.find((p) => p.amount !== null && p.payment_status === "unpaid"),
    paid: own.find((p) => p.payment_status === "paid"),
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
    anon.from("projects").insert({ name: "verify-probe", status: "in_progress", client_id: ids.a }).select());
  await writeTest(role, "update projects", () =>
    anon.from("projects").update({ status: "delivered" }).eq("id", some.id).select());
  await writeTest(role, "delete projects", () =>
    anon.from("projects").delete().eq("id", some.id).select());

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
  for (const fn of TRIGGER_RPC) {
    await writeTest(role, `rpc ${fn}`, () => anon.rpc(fn), "denied (error), data unchanged");
  }
}

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

  // --- 書き込み（すべて拒否。0 件で終わった場合も、読み直してデータが同じなら PASS）
  const other = t.other[0];
  const otherFile = t.otherFiles[0];
  await writeTest(role, "insert project (client_id = self)", () =>
    c.from("projects").insert({ name: "verify-probe-self", status: "in_progress", client_id: ids[t.key] }).select());
  await writeTest(role, "insert project (client_id = other company)", () =>
    c.from("projects").insert({ name: "verify-probe-other", status: "in_progress", client_id: other.client_id }).select());
  await writeTest(role, "insert project with payment_status = paid", () =>
    c.from("projects").insert({
      name: "verify-probe-paid", status: "in_progress", client_id: ids[t.key],
      payment_status: "paid", paid_at: now,
    }).select());
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
  for (const fn of TRIGGER_RPC) {
    await writeTest(role, `rpc ${fn}`, () => c.rpc(fn), "denied (error), data unchanged");
  }
}

// ---------- 4. 管理者（対照） ----------
async function runAdmin() {
  const role = "admin";
  const c = await signIn(`admin${DOMAIN}`);
  const total = async (table) => {
    const r = await admin.from(table).select("*", { count: "exact", head: true });
    must(r.error, `count ${table}`);
    return r.count;
  };
  for (const table of ["projects", "project_files", "profiles"]) {
    const expected = await total(table);
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

async function runColumnGrants(ctx) {
  const db = loadLocalDbConfig(); // 127.0.0.1 以外なら、ここで終了する
  secrets.push(db.password);
  const client = new pg.Client({ ...db, connectionTimeoutMillis: 5000, application_name: "verify-rls" });
  let rows;
  try {
    await client.connect();
    await client.query("set default_transaction_read_only = on"); // 読むだけ
    rows = (await client.query(GRANTS_SQL)).rows;
  } catch (e) {
    record("grants", "query column privileges (local Postgres)", "query succeeds",
      `error: ${String(e.message).slice(0, 70)}`, false);
    return;
  } finally {
    await client.end().catch(() => {});
  }

  if (rows.length === 0) {
    record("grants", "information_schema.columns (public)", "columns listed", "0 rows", false,
      "cannot check column privileges without the column list");
    return;
  }

  // public にあるテーブル（とビュー）は、期待値にある 4 つだけのはず
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
    ["client-a", `client-a${DOMAIN}`],
    ["client-b", `client-b${DOMAIN}`],
    ["admin", `admin${DOMAIN}`],
  ];
  for (const [role, email] of users) {
    const c = await signIn(email);
    for (const table of PUBLIC_TABLES) {
      const expected = ctx.expected.authenticated[table];
      const op = `select * ${table}: returned columns`;
      const r = await attempt(() => c.from(table).select("*"));

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
  for (const [role, headers] of viewers) {
    const seen = await fetchRpcNames(headers);
    if (seen.names === null) {
      record(role, "visible RPC functions (OpenAPI)", "only is_admin visible",
        `skipped: OpenAPI not available to this role (HTTP ${seen.status})`, true,
        "could not list; the functions were still called by name above");
      continue;
    }
    const extra = seen.names.filter((f) => f !== "is_admin");
    record(role, "visible RPC functions (OpenAPI)", "only is_admin visible",
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

  baseline = await takeSnapshot();
  const initial = baseline;

  await runAnon();
  for (const key of ["a", "b"]) {
    const t = tenantOf(key);
    await runTenant(t, await signIn(t.email));
  }
  await runAdmin();
  await runColumnChecks({ expected: EXPECTED_READABLE_COLUMNS, control: null });
  await runRpcList();
  await runCleanupCheck(initial);

  process.exitCode = report() > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error(`[verify] failed: ${redact(err.message)}`);
  process.exit(1);
});
