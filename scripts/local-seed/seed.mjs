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
// note：project_notes の本文と、そこから作った chunk（メモ由来の chunk はいつでも見える）
// files[].chunk：そのファイル由来の chunk（見え方はファイルと同じ）
// slot：偽の埋め込みで 1 にする位置（fakeEmbedding）。chunk ごとに別の値。配列の順番には頼らない
const PROJECTS = [
  { org: "a", name: "A-1", status: "in_progress", amount: null, paid: false,
    note: {
      body: "CANARY-A1-NOTE Kickoff notes for A-1.\n\nCANARY-A1-NOTE-2 Second paragraph of the A-1 note.",
      chunks: [
        { slot: 0, content: "CANARY-A1-NOTE Kickoff notes for A-1." },
        { slot: 1, content: "CANARY-A1-NOTE-2 Second paragraph of the A-1 note." },
      ],
    },
    files: [
      { name: "brief.txt", content: "A-1 brief (no invoice)",
        chunk: { slot: 2, content: "CANARY-A1-FILE-NOINVOICE A-1 brief excerpt." } },
    ] },
  { org: "a", name: "A-2", status: "in_review", amount: 50000, paid: false,
    note: {
      body: "CANARY-A2-NOTE Review notes for A-2.",
      chunks: [{ slot: 3, content: "CANARY-A2-NOTE Review notes for A-2." }],
    },
    files: [
      { name: "draft.txt", content: "A-2 draft (unpaid: hidden from client)",
        chunk: { slot: 4, content: "CANARY-A2-FILE-UNPAID A-2 draft excerpt." } },
    ] },
  { org: "a", name: "A-3", status: "delivered", amount: 30000, paid: true,
    note: {
      body: "CANARY-A3-NOTE Delivery notes for A-3.",
      chunks: [{ slot: 5, content: "CANARY-A3-NOTE Delivery notes for A-3." }],
    },
    files: [
      { name: "report.txt", content: "A-3 report (paid)",
        chunk: { slot: 6, content: "CANARY-A3-FILE-PAID A-3 report excerpt." } },
      { name: "納品物_最終版.txt", content: "A-3 final (paid, Japanese name)", chunk: null },
    ] },
  { org: "b", name: "B-1", status: "in_progress", amount: null, paid: false,
    note: {
      body: "CANARY-B1-NOTE Kickoff notes for B-1.",
      chunks: [{ slot: 7, content: "CANARY-B1-NOTE Kickoff notes for B-1." }],
    },
    files: [
      { name: "brief.txt", content: "B-1 brief (no invoice)",
        chunk: { slot: 8, content: "CANARY-B1-FILE-NOINVOICE B-1 brief excerpt." } },
    ] },
  { org: "b", name: "B-2", status: "delivered", amount: 20000, paid: false,
    note: {
      body: "CANARY-B2-NOTE Delivery notes for B-2.",
      chunks: [{ slot: 9, content: "CANARY-B2-NOTE Delivery notes for B-2." }],
    },
    files: [
      { name: "draft.txt", content: "B-2 draft (unpaid: hidden from client)",
        chunk: { slot: 10, content: "CANARY-B2-FILE-UNPAID B-2 draft excerpt." } },
    ] },
  { org: "b", name: "B-3", status: "in_review", amount: 50, paid: true,
    note: {
      body: "CANARY-B3-NOTE Review notes for B-3.",
      chunks: [{ slot: 11, content: "CANARY-B3-NOTE Review notes for B-3." }],
    },
    files: [
      { name: "notes.txt", content: "B-3 notes (paid, minimum amount)",
        chunk: { slot: 12, content: "CANARY-B3-FILE-PAID B-3 notes excerpt." } },
    ] },
];

// ---------- 偽の埋め込み ----------
// slot 番目だけ 1、ほかは 0 の 1024 次元（乱数は使わない。毎回同じ値になる）
// slot が違えばコサイン類似度は 0、同じなら 1。全部 0 のベクトルはコサイン距離が NaN になるので作らない
const EMBEDDING_DIM = 1024;
const EMBEDDING_MODEL = "dummy-1024"; // 偽物と分かる名前
const NOTE_LABEL = "Project note";

function fakeEmbedding(slot) {
  const v = Array.from({ length: EMBEDDING_DIM }, (_, i) => (i === slot ? 1 : 0));
  return `[${v.join(",")}]`; // pgvector のテキスト形式
}

// slot が重なっていない・範囲内であることを、書き込む前に確かめる
function checkSlots() {
  const slots = PROJECTS.flatMap((p) => [
    ...p.note.chunks.map((c) => c.slot),
    ...p.files.filter((f) => f.chunk).map((f) => f.chunk.slot),
  ]);
  if (new Set(slots).size !== slots.length) throw new Error("duplicate chunk slot in PROJECTS");
  if (slots.some((s) => !Number.isInteger(s) || s < 0 || s >= EMBEDDING_DIM)) {
    throw new Error(`chunk slot must be an integer in 0..${EMBEDDING_DIM - 1}`);
  }
}

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
  checkSlots();
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

  // 案件・ファイル（Storage → project_files の順）→ メモ → chunk
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

    const chunkRows = [];
    for (const f of p.files) {
      const fileId = randomUUID();
      const storagePath = `${data.id}/${fileId}`; // 案件ID/ファイルID
      const body = Buffer.from(f.content, "utf8");
      const { error: upErr } = await admin.storage.from(BUCKET)
        .upload(storagePath, body, { contentType: "text/plain" });
      must(upErr, `upload ${p.name}/${f.name}`);
      storageUploaded++;
      const { error: rowErr } = await admin.from("project_files").insert({
        id: fileId, project_id: data.id, file_name: f.name,
        storage_path: storagePath, size: body.length,
      });
      must(rowErr, `insert project_files ${p.name}/${f.name}`);

      // ファイル由来の chunk：(file_id, project_id) が今作った project_files の行に合う
      if (f.chunk) {
        chunkRows.push({
          project_id: data.id, file_id: fileId, source_type: "file", source_label: f.name,
          chunk_index: 0, content: f.chunk.content,
          embedding: fakeEmbedding(f.chunk.slot), embedding_model: EMBEDDING_MODEL,
        });
      }
    }

    // メモ（1 案件 1 行）と、メモ由来の chunk（chunk_index は 0 から順に）
    const { error: noteErr } = await admin.from("project_notes")
      .insert({ project_id: data.id, body: p.note.body });
    must(noteErr, `insert project_notes ${p.name}`);
    p.note.chunks.forEach((c, i) => {
      chunkRows.push({
        project_id: data.id, file_id: null, source_type: "note", source_label: NOTE_LABEL,
        chunk_index: i, content: c.content,
        embedding: fakeEmbedding(c.slot), embedding_model: EMBEDDING_MODEL,
      });
    });

    const { error: chunkErr } = await admin.from("project_chunks").insert(chunkRows);
    must(chunkErr, `insert project_chunks ${p.name}`);
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
  const { count: notes, error: e7 } = await admin
    .from("project_notes").select("project_id", { count: "exact", head: true }).in("project_id", projectIds);
  must(e7, "count project_notes");
  const { count: chunks, error: e8 } = await admin
    .from("project_chunks").select("id", { count: "exact", head: true }).in("project_id", projectIds);
  must(e8, "count project_chunks");

  console.log("created:");
  console.log(`  users:         ${profiles} (admin ${admins}, client ${profiles - admins})`);
  console.log(`  organizations: ${orgs} (members ${members})`);
  console.log(`  projects:      ${projects}`);
  console.log(`  project_files: ${files}`);
  console.log(`  storage files: ${storageUploaded}`);
  console.log(`  project_notes: ${notes}`);
  console.log(`  project_chunks: ${chunks}`);
}

main().catch((err) => {
  console.error(`[seed] failed: ${err.message}`);
  process.exit(1);
});
