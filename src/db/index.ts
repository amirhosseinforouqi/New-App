/**
 * Database access with a mandatory actor context.
 *
 * Every query in this application runs inside `withActor()`, which opens a
 * transaction and sets the Postgres session variables the RLS policies in
 * drizzle/0002_rls.sql read:
 *
 *     SET LOCAL app.actor_type = 'client' | 'broker' | 'agent' | 'system'
 *     SET LOCAL app.client_id  = '<uuid>'
 *
 * `SET LOCAL` is transaction-scoped, so when the connection returns to the
 * pool it carries no identity. That property is what makes RLS safe to combine
 * with connection pooling — a plain `SET` would leak the previous request's
 * identity to whoever borrows the connection next.
 *
 * There is deliberately no exported "raw query" escape hatch for request paths.
 * If you find yourself wanting one, you are about to bypass row-level security.
 */

import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import { env } from '@/lib/env';
import * as schema from './schema';

const { Pool } = pg;

/**
 * Postgres returns bigint as a string by default to avoid precision loss. Our
 * only bigint is size_bytes, which is comfortably inside Number.MAX_SAFE_INTEGER,
 * so parse it to a number for ergonomics.
 */
pg.types.setTypeParser(20, (value) => Number.parseInt(value, 10));

declare global {
  // Next.js dev mode re-evaluates modules on hot reload; without this the pool
  // is recreated each time and Postgres runs out of connections.
  //
  // `var` is not a style choice: `let`/`const` in a `declare global` block do
  // not attach to `globalThis`, so the cache below would miss on every reload.
  var __uwaPool: pg.Pool | undefined;
}

export const pool: pg.Pool =
  globalThis.__uwaPool ??
  new Pool({
    connectionString: env.databaseUrl,
    ssl: env.databaseSsl ? { rejectUnauthorized: true } : undefined,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

if (!env.isProduction) globalThis.__uwaPool = pool;

export type Db = NodePgDatabase<typeof schema>;

/** Who is making the request. Never derived from user-supplied input. */
export type Actor =
  | { type: 'client'; clientId: string }
  | { type: 'broker'; brokerId: string }
  | { type: 'agent' }
  | { type: 'system' };

/**
 * Run `fn` inside a transaction bound to `actor`.
 *
 * Rolls back on any thrown error, so a partially-applied multi-table write
 * (create client → create Drive folder record → seed checklist) cannot leave
 * the database in a half-built state.
 */
export async function withActor<T>(actor: Actor, fn: (db: Db) => Promise<T>): Promise<T> {
  const connection = await pool.connect();
  try {
    await connection.query('BEGIN');

    // Parameterised: actor values are server-derived, but string-concatenating
    // into SET is a habit worth never forming.
    await connection.query('SELECT set_config($1, $2, true)', ['app.actor_type', actor.type]);
    await connection.query('SELECT set_config($1, $2, true)', [
      'app.client_id',
      actor.type === 'client' ? actor.clientId : '',
    ]);
    // Published so policies can distinguish WHICH broker is acting, not merely
    // that one is. Only the owner-gated INSERT on `brokers` uses it today.
    await connection.query('SELECT set_config($1, $2, true)', [
      'app.broker_id',
      actor.type === 'broker' ? actor.brokerId : '',
    ]);

    const db = drizzle(connection, { schema });
    const result = await fn(db);

    await connection.query('COMMIT');
    return result;
  } catch (error) {
    await connection.query('ROLLBACK').catch(() => {
      /* connection may already be broken; the original error is what matters */
    });
    throw error;
  } finally {
    connection.release();
  }
}

/** Convenience wrappers so call sites read as the permission they need. */
export const asClient = <T>(clientId: string, fn: (db: Db) => Promise<T>) =>
  withActor({ type: 'client', clientId }, fn);

export const asBroker = <T>(brokerId: string, fn: (db: Db) => Promise<T>) =>
  withActor({ type: 'broker', brokerId }, fn);

export const asAgent = <T>(fn: (db: Db) => Promise<T>) => withActor({ type: 'agent' }, fn);

/**
 * For work with no authenticated user: session lookup, inbound mail
 * processing, migrations. Keep the surface small and grep-able.
 */
export const asSystem = <T>(fn: (db: Db) => Promise<T>) => withActor({ type: 'system' }, fn);

export { schema };
