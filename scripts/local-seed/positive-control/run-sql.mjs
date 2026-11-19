// RAG の陽性対照用：SQL ファイルを 1 つ、ローカルの Postgres（.env.seed.local の DB_URL）に流す。
// 使い方：node scripts/local-seed/positive-control/run-sql.mjs <SQL ファイル>
// ・接続先は 127.0.0.1:54322 だけ。guard.mjs の loadLocalDbConfig() が 127.0.0.1 以外を止め、
//   さらにここでポートが 54322 でなければ止める。流す前に接続先を表示する
// ・パスワードは表示しない
// ・最後の文が行を返したら、1 行ずつ JSON で表示する（qual.sql の確認用）
import { readFileSync } from "node:fs";
import pg from "pg";
import { loadLocalDbConfig } from "../guard.mjs";

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/local-seed/positive-control/run-sql.mjs <file.sql>");
  process.exit(1);
}

const db = loadLocalDbConfig(); // 127.0.0.1 以外なら、ここで終了する
if (db.host !== "127.0.0.1" || db.port !== 54322) {
  console.error(`refusing: ${db.host}:${db.port} is not 127.0.0.1:54322`);
  process.exit(1);
}
console.log(`target: ${db.host}:${db.port} database=${db.database} user=${db.user}`);

const sql = readFileSync(file, "utf8");
const client = new pg.Client({ ...db, connectionTimeoutMillis: 5000, application_name: "rag-positive-control" });
await client.connect();
try {
  const res = await client.query(sql);
  const last = Array.isArray(res) ? res[res.length - 1] : res;
  if (last?.rows?.length) for (const r of last.rows) console.log(JSON.stringify(r));
  console.log("ok");
} catch (e) {
  console.error(`SQL error: ${e.message}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
