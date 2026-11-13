import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from '../lib/db.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');
await sql`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`.catch(() => {});
const done = new Set((await sql`select name from schema_migrations`).map(r => r.name));
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort()) {
  if (done.has(f)) continue;
  const body = fs.readFileSync(path.join(dir, f), 'utf8').replace(/CREATE TABLE schema_migrations[^;]+;/, '');
  await sql.begin(async tx => { await tx.unsafe(body); await tx`insert into schema_migrations (name) values (${f})`; });
  console.log('applied', f);
}
await sql.end();
