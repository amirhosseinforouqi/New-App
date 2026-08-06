/**
 * Row-level security integration test.
 *
 * This is the test that matters most in this repo. It proves the claim
 * "each client can only see their own data" is enforced by Postgres, not by
 * application code — by issuing queries with NO WHERE clause at all and
 * asserting the database still returns only the caller's rows.
 *
 * Requires a live database. Run:
 *
 *   DATABASE_MIGRATION_URL=postgres://owner@host/db npm run db:migrate
 *   DATABASE_URL=postgres://uwa_app@host/db npm test
 *
 * Skips (rather than fails) when UWA_TEST_DATABASE_URL is unset, so the unit
 * suite stays runnable with no infrastructure.
 */

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import pg from 'pg';

const CONNECTION = process.env.UWA_TEST_DATABASE_URL;

describe('row-level security', { skip: !CONNECTION ? 'UWA_TEST_DATABASE_URL not set' : false }, () => {
  let pool: pg.Pool;
  let clientA: string;
  let clientB: string;

  /** Run a query inside a transaction bound to an actor, exactly as src/db does. */
  async function as<T extends pg.QueryResultRow = pg.QueryResultRow>(
    actor: { type: string; clientId?: string },
    sql: string,
    params: unknown[] = [],
  ): Promise<pg.QueryResult<T>> {
    const connection = await pool.connect();
    try {
      await connection.query('BEGIN');
      await connection.query('SELECT set_config($1, $2, true)', ['app.actor_type', actor.type]);
      await connection.query('SELECT set_config($1, $2, true)', [
        'app.client_id',
        actor.clientId ?? '',
      ]);
      const result = await connection.query<T>(sql, params);
      await connection.query('COMMIT');
      return result;
    } catch (error) {
      await connection.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      connection.release();
    }
  }

  before(async () => {
    pool = new pg.Pool({ connectionString: CONNECTION });

    // Seed as the system actor (staff-equivalent under the policies).
    // No broker row is created: `brokers` is intentionally not writable by the
    // application role, and the broker policies key off app.actor_type rather
    // than a lookup, so the tests below need no broker record to exercise them.
    const a = await as<{ id: string }>(
      { type: 'system' },
      `INSERT INTO clients (email, full_name, username, password_hash)
       VALUES ('rls-a@example.test', 'Alice Anderson', 'aanderson_rlstest', 'scrypt$1$1$1$x$y')
       RETURNING id`,
    );
    clientA = a.rows[0]!.id;

    const b = await as<{ id: string }>(
      { type: 'system' },
      `INSERT INTO clients (email, full_name, username, password_hash)
       VALUES ('rls-b@example.test', 'Bob Brown', 'bbrown_rlstest', 'scrypt$1$1$1$x$y')
       RETURNING id`,
    );
    clientB = b.rows[0]!.id;

    for (const [id, name] of [
      [clientA, 'alice-secret.pdf'],
      [clientB, 'bob-secret.pdf'],
    ] as const) {
      await as(
        { type: 'system' },
        `INSERT INTO documents (client_id, drive_file_id, file_name, mime_type, size_bytes)
         VALUES ($1, $2, $3, 'application/pdf', 1024)`,
        [id, `drive-${name}`, name],
      );
      await as(
        { type: 'system' },
        `INSERT INTO messages (client_id, sender_type, body) VALUES ($1, 'client', $2)`,
        [id, `private message from ${name}`],
      );
    }
  });

  after(async () => {
    if (!pool) return;
    await as({ type: 'system' }, 'DELETE FROM clients WHERE email LIKE $1', ['rls-%@example.test']);
    await pool.end();
  });

  it('shows a client only their own client row — with no WHERE clause', async () => {
    const result = await as({ type: 'client', clientId: clientA }, 'SELECT id, email FROM clients');
    assert.equal(result.rowCount, 1);
    assert.equal(result.rows[0]!.id, clientA);
  });

  it('hides another client’s documents even when asked for directly', async () => {
    const all = await as({ type: 'client', clientId: clientA }, 'SELECT * FROM documents');
    assert.equal(all.rowCount, 1);
    assert.equal(all.rows[0]!.file_name, 'alice-secret.pdf');

    // The IDOR attempt: name Bob's row explicitly.
    const targeted = await as(
      { type: 'client', clientId: clientA },
      'SELECT * FROM documents WHERE client_id = $1',
      [clientB],
    );
    assert.equal(targeted.rowCount, 0);
  });

  it('hides another client’s messages', async () => {
    const result = await as({ type: 'client', clientId: clientA }, 'SELECT body FROM messages');
    assert.equal(result.rowCount, 1);
    assert.match(result.rows[0]!.body, /alice-secret/);
  });

  it('stops a client forging a message that appears to come from the broker', async () => {
    await assert.rejects(
      () =>
        as(
          { type: 'client', clientId: clientA },
          `INSERT INTO messages (client_id, sender_type, body)
           VALUES ($1, 'broker', 'Your mortgage is approved, send the deposit here')`,
          [clientA],
        ),
      /row-level security/i,
    );
  });

  it('stops a client writing into another client’s thread', async () => {
    await assert.rejects(
      () =>
        as(
          { type: 'client', clientId: clientA },
          `INSERT INTO messages (client_id, sender_type, body) VALUES ($1, 'client', 'injected')`,
          [clientB],
        ),
      /row-level security/i,
    );
  });

  it('stops a client approving their own document', async () => {
    await assert.rejects(
      () =>
        as(
          { type: 'client', clientId: clientA },
          `INSERT INTO documents (client_id, drive_file_id, file_name, mime_type, size_bytes, status, uploaded_by)
           VALUES ($1, 'forged', 'self-approved.pdf', 'application/pdf', 1, 'approved', 'client')`,
          [clientA],
        ),
      /row-level security/i,
    );
  });

  it('stops a client writing their own stage history', async () => {
    await assert.rejects(
      () =>
        as(
          { type: 'client', clientId: clientA },
          `INSERT INTO client_stage_history (client_id, stage_key) VALUES ($1, 'funded')`,
          [clientA],
        ),
      /row-level security/i,
    );
  });

  it('returns nothing at all when no actor is set', async () => {
    const connection = await pool.connect();
    try {
      await connection.query('BEGIN');
      const result = await connection.query('SELECT * FROM documents');
      await connection.query('COMMIT');
      assert.equal(result.rowCount, 0);
    } finally {
      connection.release();
    }
  });

  it('gives the broker access to every client', async () => {
    const clientsSeen = await as({ type: 'broker' }, 'SELECT id FROM clients');
    assert.ok((clientsSeen.rowCount ?? 0) >= 2);

    const docs = await as({ type: 'broker' }, 'SELECT file_name FROM documents');
    const names = docs.rows.map((row) => row.file_name);
    assert.ok(names.includes('alice-secret.pdf'));
    assert.ok(names.includes('bob-secret.pdf'));
  });

  it('lets the agent read across a file, as skills require', async () => {
    const result = await as({ type: 'agent' }, 'SELECT id FROM documents');
    assert.ok((result.rowCount ?? 0) >= 2);
  });

  it('does not leak identity between pooled connections', async () => {
    // Borrow, identify as A, release; then borrow again with no identity.
    // SET LOCAL is transaction-scoped, so the second borrow must see nothing.
    await as({ type: 'client', clientId: clientA }, 'SELECT * FROM documents');

    const connection = await pool.connect();
    try {
      await connection.query('BEGIN');
      const leaked = await connection.query('SELECT * FROM documents');
      await connection.query('COMMIT');
      assert.equal(leaked.rowCount, 0, 'identity leaked across a pooled connection');
    } finally {
      connection.release();
    }
  });

  it('confirms the app role is not exempt from RLS', async () => {
    const result = await as<{ rolsuper: boolean; rolbypassrls: boolean }>(
      { type: 'system' },
      'SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user',
    );
    assert.equal(result.rows[0]!.rolsuper, false, 'app role is a superuser — RLS is inert');
    assert.equal(result.rows[0]!.rolbypassrls, false, 'app role has BYPASSRLS — RLS is inert');
  });
});
