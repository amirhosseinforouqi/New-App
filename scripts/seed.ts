/**
 * Create the first broker account.
 *
 *   npm run db:seed -- "you@your-domain.ca" "Your Name"
 *
 * Connects as the OWNER role, not the application role. That is deliberate:
 * 0002_rls.sql revokes INSERT on `brokers` from `uwa_app`, so a compromise of
 * the running application cannot mint itself an administrator account.
 * Creating a broker is an out-of-band, privileged operation and this script is
 * the only path to it.
 *
 * Prints a generated password once. It is not stored in plaintext anywhere and
 * cannot be recovered — change it after first sign-in.
 */

import 'dotenv/config';
import pg from 'pg';

import { hashPassword, generatePassword } from '../src/lib/auth/password';

async function main() {
  const [email, ...nameParts] = process.argv.slice(2);
  const fullName = nameParts.join(' ').trim();

  if (!email || !fullName) {
    console.error('Usage: npm run db:seed -- "you@your-domain.ca" "Your Name"');
    process.exit(1);
  }

  const connectionString = process.env.DATABASE_MIGRATION_URL;
  if (!connectionString) {
    console.error(
      'DATABASE_MIGRATION_URL is not set.\n' +
        'Broker accounts are created with the owner role — the application role is\n' +
        'deliberately not permitted to insert into `brokers`. See drizzle/0002_rls.sql.',
    );
    process.exit(1);
  }

  const client = new pg.Client({
    connectionString,
    ssl: process.env.DATABASE_SSL && process.env.DATABASE_SSL !== 'disable' ? {} : undefined,
  });

  await client.connect();

  try {
    const existing = await client.query('SELECT id FROM brokers WHERE lower(email) = lower($1)', [
      email,
    ]);

    if (existing.rowCount && existing.rowCount > 0) {
      console.error(`A broker with the email ${email} already exists. Nothing was changed.`);
      process.exitCode = 1;
      return;
    }

    const password = generatePassword(20);
    const passwordHash = await hashPassword(password);

    await client.query(
      // Role 'owner': this is the account that sets the brokerage up, and
      // without it nobody can invite the team, issue API keys or see
      // commissions. Migration 0004 promotes the first broker, but only for
      // brokerages that already existed when it ran.
      `INSERT INTO brokers (email, full_name, password_hash, role)
       VALUES (lower($1), $2, $3, 'owner')`,
      [email, fullName, passwordHash],
    );

    console.info(`
  Broker account created.

    Email:    ${email}
    Password: ${password}

  Sign in at /login. This password is shown once and is not recoverable —
  copy it now, then change it after signing in.
`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error('[seed] error:', error instanceof Error ? error.message : error);
  process.exit(1);
});
