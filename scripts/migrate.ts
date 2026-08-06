/**
 * Migration runner.
 *
 * Applies drizzle/*.sql in filename order, recording each in a
 * `_migrations` table so re-runs are safe.
 *
 * Runs as the OWNER role (DATABASE_MIGRATION_URL), not the application role.
 * That separation is load-bearing: Postgres exempts table owners from row-level
 * security, so if the app connected as the owner every RLS policy in
 * 0002_rls.sql would be silently inert.
 *
 *   npm run db:migrate
 */

import 'dotenv/config';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import pg from 'pg';

const MIGRATIONS_DIR = join(process.cwd(), 'drizzle');

async function main() {
  const connectionString = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error('Set DATABASE_MIGRATION_URL (preferred) or DATABASE_URL before migrating.');
  }

  if (!process.env.DATABASE_MIGRATION_URL) {
    console.warn(
      '[migrate] DATABASE_MIGRATION_URL is not set, falling back to DATABASE_URL.\n' +
        '          If that role owns the tables, row-level security will NOT be enforced\n' +
        '          against it. See docs/ARCHITECTURE.md § Row-level security.',
    );
  }

  const client = new pg.Client({
    connectionString,
    ssl: process.env.DATABASE_SSL && process.env.DATABASE_SSL !== 'disable' ? {} : undefined,
  });

  await client.connect();

  await client.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name        text PRIMARY KEY,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `);

  const applied = new Set(
    (await client.query<{ name: string }>('SELECT name FROM _migrations')).rows.map(
      (row) => row.name,
    ),
  );

  const files = (await readdir(MIGRATIONS_DIR)).filter((name) => name.endsWith('.sql')).sort();

  let count = 0;
  for (const file of files) {
    if (applied.has(file)) {
      console.info(`[migrate] skip   ${file}`);
      continue;
    }

    const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8');
    console.info(`[migrate] apply  ${file}`);

    // Each migration is its own transaction: a failure half way through
    // 0001 must not leave a partially-created schema behind.
    try {
      await client.query('BEGIN');
      await client.query(sql);
      await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      count += 1;
    } catch (error) {
      await client.query('ROLLBACK');
      console.error(`[migrate] FAILED ${file}`);
      throw error;
    }
  }

  await client.end();
  console.info(`[migrate] done — ${count} migration(s) applied, ${files.length} total.`);
}

main().catch((error) => {
  console.error('[migrate] error:', error instanceof Error ? error.message : error);
  process.exit(1);
});
