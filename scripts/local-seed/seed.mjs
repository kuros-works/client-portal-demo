// RLS 検証用のテストデータをローカル Supabase に作る（何度実行しても同じ結果）。
// 消すのは @seed.test のユーザーと、その人たちの会社・案件・ファイルだけ。
import { randomUUID } from "node:crypto";
import { createLocalAdminClient } from "./guard.mjs";

const DOMAIN = "@seed.test";
const BUCKET = "project-files";
const SEED_PASSWORD = "seed-local-only-pw"; // ローカル専用。本番には存在しないユーザー用

const USERS = [
  { key: "admin", email: `admin${DOMAIN}`, name: "Seed Admin", role: "admin" },
  { key: "a", email: `client-a${DOMAIN}`, name: "Company A Owner", role: "client" },
  { key: "aStaff", email: `client-a-staff${DOMAIN}`, name: "Company A Staff", role: "client" },
  { key: "b", email: `client-b${DOMAIN}`, name: "Company B Owner", role: "client" },
];

// 会社とメンバー（最初の 1 人がオーナー）
const ORGS = [
  { key: "a", name: "Company A", members: [["a", "owner"], ["aStaff", "staff"]] },
  { key: "b", name: "Company B", members: [["b", "owner"]] },
];

// amount が null か paid → お客様にファイルが見える。unpaid で amount あり → 見えない
const PROJECTS = [
  { org: "a", name: "A-1", status: "in_progress", amount: null, paid: false,
    files: [["brief.txt", "A-1 brief (no invoice)"]] },
  { org: "a", name: "A-2", status: "in_review", amount: 50000, paid: false,
    files: [["draft.txt", "A-2 draft (unpaid: hidden from client)"]] },
  { org: "a", name: "A-3", status: "delivered", amount: 30000, paid: true,
    files: [["report.txt", "A-3 report (paid)"], ["納品物_最終版.txt", "A-3 final (paid, Japanese name)"]] },
  { org: "b", name: "B-1", status: "in_progress", amount: null, paid: false,
    files: [["brief.txt", "B-1 brief (no invoice)"]] },
  { org: "b", name: "B-2", status: "delivered", amount: 20000, paid: false,
    files: [["draft.txt", "B-2 draft (unpaid: hidden from client)"]] },
  { org: "b", name: "B-3", status: "in_review", amount: 50, paid: true,
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

// 後片付けは organization_id で行う：seed ユーザーが入っている会社 → その会社の案件・ファイル → 会社 → ユーザー
async function cleanup(admin) {
  const users = await listSeedUsers(admin);
  const userIds = users.map((u) => u.id);
  if (userIds.length === 0) return 0;

  const { data: memberships, error: mErr } = await admin
    .from("organization_members").select("organization_id").in("user_id", userIds);
  must(mErr, "select organization_members");
  const orgIds = [...new Set(memberships.map((m) => m.organization_id))];

  if (orgIds.length > 0) {
    // seed 以外の人が入っている会社は消さない（安全のため、ここで止める）
    const { data: allMembers, error: amErr } = await admin
      .from("organization_members").select("user_id").in("organization_id", orgIds);
    must(amErr, "select members of seed organizations");
    if (allMembers.some((m) => !userIds.includes(m.user_id))) {
      throw new Error("a seed organization has a non-seed member; refusing to delete it");
    }

    const { data: projects, error: pErr } = await admin
      .from("projects").select("id").in("organization_id", orgIds);
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

    const { error } = await admin.from("organizations").delete().in("id", orgIds); // メンバーも連動して消える
    must(error, "delete organizations");

    // seed の会社の案件と会社が、本当に消えたか確かめてからユーザーを消す
    const { count: leftoverProjects, error: lpErr } = await admin
      .from("projects").select("id", { count: "exact", head: true }).in("organization_id", orgIds);
    must(lpErr, "count leftover projects");
    const { count: leftoverOrgs, error: loErr } = await admin
      .from("organizations").select("id", { count: "exact", head: true }).in("id", orgIds);
    must(loErr, "count leftover organizations");
    if (leftoverProjects > 0 || leftoverOrgs > 0) {
      throw new Error(
        `seed organizations were not fully removed (projects ${leftoverProjects}, organizations ${leftoverOrgs})`);
    }
  }

  for (const user of users) {
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

  // 会社とメンバー
  const orgIds = {};
  for (const o of ORGS) {
    const { data, error } = await admin.from("organizations")
      .insert({ name: o.name }).select("id").single();
    must(error, `insert organization ${o.key}`);
    orgIds[o.key] = data.id;
    const { error: memErr } = await admin.from("organization_members").insert(
      o.members.map(([userKey, role]) => ({ organization_id: data.id, user_id: userIds[userKey], role })));
    must(memErr, `insert organization_members ${o.key}`);
  }

  // 案件・ファイル（Storage → project_files の順）
  const projectIds = [];
  let storageUploaded = 0;
  for (const p of PROJECTS) {
    const { data, error } = await admin.from("projects").insert({
      name: p.name,
      status: p.status,
      organization_id: orgIds[p.org],
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
  const allOrgIds = Object.values(orgIds);
  const { count: orgs, error: e5 } = await admin
    .from("organizations").select("id", { count: "exact", head: true }).in("id", allOrgIds);
  must(e5, "count organizations");
  const { count: members, error: e6 } = await admin
    .from("organization_members").select("user_id", { count: "exact", head: true })
    .in("organization_id", allOrgIds);
  must(e6, "count organization_members");

  console.log("created:");
  console.log(`  users:         ${profiles} (admin ${admins}, client ${profiles - admins})`);
  console.log(`  organizations: ${orgs} (members ${members})`);
  console.log(`  projects:      ${projects}`);
  console.log(`  project_files: ${files}`);
  console.log(`  storage files: ${storageUploaded}`);
}

main().catch((err) => {
  console.error(`[seed] failed: ${err.message}`);
  process.exit(1);
});
