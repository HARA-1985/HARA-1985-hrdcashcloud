// デプロイ時に supabase/migrations の未適用分だけを順に適用する（適用済みは private.schema_migrations に記録）
import fs from "node:fs";
import path from "node:path";
import pg from "pg";

const raw = process.env.POSTGRES_URL_NON_POOLING || process.env.POSTGRES_URL;
if (!raw) {
  console.log("[migrate] POSTGRES_URL_NON_POOLING が無いのでスキップします");
  process.exit(0);
}
const url = new URL(raw);
url.searchParams.delete("sslmode");
url.searchParams.delete("supa");

const client = new pg.Client({ connectionString: url.toString(), ssl: { rejectUnauthorized: false } });
await client.connect();
await client.query(`create schema if not exists private;
  create table if not exists private.schema_migrations (version text primary key, name text, applied_at timestamptz not null default now());`);

const dir = path.join(process.cwd(), "supabase", "migrations");
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
const { rows } = await client.query("select version from private.schema_migrations");
const done = new Set(rows.map((r) => r.version));

let applied = 0;
for (const f of files) {
  const version = f.split("_")[0];
  if (done.has(version)) continue;
  const sql = fs.readFileSync(path.join(dir, f), "utf8");
  console.log(`[migrate] 適用中: ${f}`);
  try {
    await client.query("begin");
    await client.query(sql);
    await client.query("insert into private.schema_migrations(version, name) values ($1, $2)", [version, f]);
    await client.query("commit");
    applied++;
  } catch (e) {
    await client.query("rollback");
    console.error(`[migrate] 失敗: ${f}\n${e.message}`);
    await client.end();
    process.exit(1);
  }
}
console.log(`[migrate] 完了（新規 ${applied} 件 / 全 ${files.length} 件）`);
await client.end();
