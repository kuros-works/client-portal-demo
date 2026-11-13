// RLS 検証用のテストデータをローカル Supabase に作る（何度実行しても同じ結果）。
// 消すのは @seed.test のユーザーと、その人たちの案件・ファイルだけ。
import { randomUUID } from "node:crypto";
import { createLocalAdminClient } from "./guard.mjs";

const DOMAIN = "@seed.test";
const BUCKET = "project-files";
const SEED_PASSWORD = "seed-local-only-pw"; // ローカル専用。本番には存在しないユーザー用

const USERS = [
  { key: "admin", email: `admin${DOMAIN}`, name: "Seed Admin", role: "admin" },
  { key: "a", email: `client-a${DOMAIN}`, name: "Company A", role: "client" },
  { key: "b", email: `client-b${DOMAIN}`, name: "Company B", role: "client" },
];

// amount が null か paid → お客様にファイルが見える。unpaid で amount あり → 見えない
const PROJECTS = [
  { owner: "a", name: "A-1", status: "in_progress", amount: null, paid: false,
    files: [["brief.txt", "A-1 brief (no invoice)"]] },
  { owner: "a", name: "A-2", status: "in_review", amount: 50000, paid: false,
    files: [["draft.txt", "A-2 draft (unpaid: hidden from client)"]] },
  { owner: "a", name: "A-3", status: "delivered", amount: 30000, paid: true,
    files: [["report.txt", "A-3 report (paid)"], ["納品物_最終版.txt", "A-3 final (paid, Japanese name)"]] },
  { owner: "b", name: "B-1", status: "in_progress", amount: null, paid: false,
    files: [["brief.txt", "B-1 brief (no invoice)"]] },
  { owner: "b", name: "B-2", status: "delivered", amount: 20000, paid: false,
    files: [["draft.txt", "B-2 draft (unpaid: hidden from client)"]] },
  { owner: "b", name: "B-3", status: "in_review", amount: 50, paid: true,
    files: [["notes.txt", "B-3 notes (paid, minimum amount)"]] },
];

function must(error, label) {
  if (error) throw new Error(`${label}: ${error.message}`);
}

async function listSeedUsers(admin) {
  const found = [];
  const perPage = 1000;
  for (let page = 1; ; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    must(error, "listUsers");
    found.push(...data.users.filter((u) => u.email?.endsWith(DOMAIN)));
    if (data.users.length < perPage) return found;
  }
}

async function cleanup(admin) {
  const users = await listSeedUsers(admin);
  for (const user of users) {
    const { data: projects, error: pErr } = await admin
      .from("projects").select("id").eq("client_id", user.id);
    must(pErr, "select projects");
    const ids = projects.map((p) => p.id);
    if (ids.length > 0) {
      const { data: files, error: fErr } = await admin
        .from("project_files").select("storage_path").in("project_id", ids);
      must(fErr, "select project_files");
      if (files.length > 0) {
        const { error } = await admin.storage.from(BUCKET).remove(files.map((f) => f.storage_path));
        must(error, "remove storage objects"); // 案件を消しても Storage の実体は消えないため
      }
      const { error } = await admin.from("projects").delete().in("id", ids);
      must(error, "delete projects");
    }
    const { error } = await admin.auth.admin.deleteUser(user.id); // profiles も連動して消える
    must(error, "deleteUser");
  }
  return users.length;
}

async function main() {
  const admin = await createLocalAdminClient();

  const removed = await cleanup(admin);
  console.log(`cleanup: removed ${removed} existing seed user(s)`);

  // ユーザー（profiles はトリガーが role = client で作る）
  const userIds = {};
  for (const u of USERS) {
    const { data, error } = await admin.auth.admin.createUser({
      email: u.email,
      password: SEED_PASSWORD,
      email_confirm: true,
      user_metadata: { name: u.name },
    });
    must(error, `createUser ${u.key}`);
    userIds[u.key] = data.user.id;
    if (u.role === "admin") {
      // service_role なら role を変えられる（トリガーは anon / authenticated だけを止める）
      const { error: roleErr } = await admin
        .from("profiles").update({ role: "admin" }).eq("id", data.user.id);
      must(roleErr, "promote admin");
    }
  }

  // 案件・ファイル（Storage → project_files の順）
  const projectIds = [];
  let storageUploaded = 0;
  for (const p of PROJECTS) {
    const { data, error } = await admin.from("projects").insert({
      name: p.name,
      status: p.status,
      client_id: userIds[p.owner],
      amount: p.amount,
      payment_status: p.paid ? "paid" : "unpaid",
      paid_at: p.paid ? new Date().toISOString() : null,
    }).select("id").single();
    must(error, `insert project ${p.name}`);
    projectIds.push(data.id);

    for (const [fileName, content] of p.files) {
      const fileId = randomUUID();
      const storagePath = `${data.id}/${fileId}`; // 案件ID/ファイルID
      const body = Buffer.from(content, "utf8");
      const { error: upErr } = await admin.storage.from(BUCKET)
        .upload(storagePath, body, { contentType: "text/plain" });
      must(upErr, `upload ${p.name}/${fileName}`);
      storageUploaded++;
      const { error: rowErr } = await admin.from("project_files").insert({
        id: fileId, project_id: data.id, file_name: fileName,
        storage_path: storagePath, size: body.length,
      });
      must(rowErr, `insert project_files ${p.name}/${fileName}`);
    }
  }

  // 件数の確認（DB から数え直す）
  const allUserIds = Object.values(userIds);
  const { count: profiles, error: e1 } = await admin
    .from("profiles").select("id", { count: "exact", head: true }).in("id", allUserIds);
  must(e1, "count profiles");
  const { count: admins, error: e2 } = await admin
    .from("profiles").select("id", { count: "exact", head: true })
    .in("id", allUserIds).eq("role", "admin");
  must(e2, "count admins");
  const { count: projects, error: e3 } = await admin
    .from("projects").select("id", { count: "exact", head: true }).in("id", projectIds);
  must(e3, "count projects");
  const { count: files, error: e4 } = await admin
    .from("project_files").select("id", { count: "exact", head: true }).in("project_id", projectIds);
  must(e4, "count project_files");

  console.log("created:");
  console.log(`  users:         ${profiles} (admin ${admins}, client ${profiles - admins})`);
  console.log(`  projects:      ${projects}`);
  console.log(`  project_files: ${files}`);
  console.log(`  storage files: ${storageUploaded}`);
}

main().catch((err) => {
  console.error(`[seed] failed: ${err.message}`);
  process.exit(1);
});
