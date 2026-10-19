import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { connect, type SqlClient } from '../src/db/client.ts';

/** Applies sql/*.sql in name order, once each, recording them in schema_migrations. */
export async function migrate(db: SqlClient): Promise<string[]> {
  const dir = fileURLToPath(new URL('../sql/', import.meta.url));
  await db.query(`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`);
  const done = new Set((await db.query<{ name: string }>(`select name from schema_migrations`)).map((r) => r.name));
  const applied: string[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    if (done.has(file)) continue;
    const sql = readFileSync(dir + file, 'utf8');
    await db.transaction(async (tx) => {
      await tx.query(sql);
      await tx.query(`insert into schema_migrations (name) values ($1)`, [file]);
    });
    applied.push(file);
  }
  return applied;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Set DATABASE_URL');
  const db = await connect(url);
  const applied = await migrate(db);
  console.log(applied.length ? `applied ${applied.join(', ')}` : 'schema up to date');
  await db.end();
}
