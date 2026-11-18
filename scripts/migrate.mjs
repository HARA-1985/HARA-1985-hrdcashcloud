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

// 状態の確認（ログに出すだけ）
const hist = await client.query("select version, applied_at from private.schema_migrations order by version");
console.log("[migrate] 適用履歴:", hist.rows.map((r) => `${r.version}@${new Date(r.applied_at).toISOString()}`).join(", "));
const t = await client.query(`select c.relname, c.relrowsecurity as rls,
  (select count(*) from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policies
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' order by c.relname`);
console.log("[migrate] public テーブル:", t.rows.map((r) => `${r.relname}(RLS:${r.rls ? "ON" : "OFF"},policy:${r.policies})`).join(" "));
const b = await client.query("select id, public from storage.buckets where id = 'inbox'");
console.log("[migrate] inbox バケット:", b.rows.length ? (b.rows[0].public ? "公開(要確認)" : "非公開") : "なし");
const tg = await client.query("select count(*)::int as n from pg_trigger where tgname in ('on_auth_user_created','payments_guard')");
console.log("[migrate] 統制トリガー:", tg.rows[0].n, "/ 2");
const v = await client.query("select extversion from pg_extension where extname = 'supabase_vault'");
const vf = await client.query("select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'vault' and p.proname in ('create_secret','update_secret')");
console.log("[migrate] Supabase Vault:", v.rows.length ? `有効 v${v.rows[0].extversion}（関数 ${vf.rows[0].n}/2）` : "無効（要対応）");
const mf = await client.query("select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'mf\\_%'");
console.log("[migrate] MF連携関数:", mf.rows[0].n, "/ 5");
await client.end();
