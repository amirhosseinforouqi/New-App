/**
 * API keys for the public API.
 *
 * Same discipline as session tokens and recovery codes: only the SHA-256 of a
 * key is stored, the plaintext is shown once at creation, and it is
 * unrecoverable afterwards. A key table you can read is a key table an
 * attacker who reaches your database can read.
 *
 * SHA-256 rather than scrypt here, deliberately, and it is worth saying why
 * since passwords in this codebase use scrypt. A password is low-entropy and
 * chosen by a human, so it needs a slow hash to survive an offline dictionary
 * attack. A 32-byte random key has 256 bits of entropy; no amount of
 * brute-force reaches it, and a slow hash on every API request would just be a
 * denial-of-service surface. The prefix is stored separately so the key can be
 * found in one indexed lookup rather than by hashing against every row.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';

import type { Db } from '@/db';
import { apiKeys } from '@/db/schema';

export type Scope = 'read' | 'write';

const PREFIX = 'uwa';

export interface IssuedKey {
  id: string;
  /** Shown once. Never retrievable. */
  key: string;
  prefix: string;
}

function hashKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

/**
 * `uwa_live_<8-char prefix>_<43-char secret>`.
 *
 * The visible prefix lets a key be identified in a list and in logs without
 * exposing it, and — usefully — makes a leaked key greppable by secret
 * scanners, which is a feature rather than a leak.
 */
export async function issueApiKey(
  db: Db,
  input: { brokerId: string | null; name: string; scopes: Scope[] },
): Promise<IssuedKey> {
  const prefix = randomBytes(4).toString('hex');
  const secret = randomBytes(32).toString('base64url');
  const key = `${PREFIX}_live_${prefix}_${secret}`;

  const [row] = await db
    .insert(apiKeys)
    .values({
      brokerId: input.brokerId,
      name: input.name,
      keyPrefix: prefix,
      keyHash: hashKey(key),
      scopes: input.scopes.length > 0 ? input.scopes : ['read'],
    })
    .returning({ id: apiKeys.id });

  if (!row) throw new Error('Could not create the API key.');

  return { id: row.id, key, prefix };
}

export interface ApiCaller {
  keyId: string;
  brokerId: string | null;
  scopes: string[];
}

/**
 * Resolve an Authorization header to a caller, or null.
 *
 * The comparison is constant-time even though the lookup is by hash. It costs
 * nothing and removes any argument about it.
 */
export async function authenticateApiKey(
  db: Db,
  header: string | null,
): Promise<ApiCaller | null> {
  if (!header) return null;

  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  const key = match?.[1];
  if (!key || !key.startsWith(`${PREFIX}_live_`)) return null;

  const hash = hashKey(key);

  const [row] = await db
    .select({
      id: apiKeys.id,
      brokerId: apiKeys.brokerId,
      scopes: apiKeys.scopes,
      keyHash: apiKeys.keyHash,
    })
    .from(apiKeys)
    .where(and(eq(apiKeys.keyHash, hash), isNull(apiKeys.revokedAt)))
    .limit(1);

  if (!row) return null;

  const a = Buffer.from(row.keyHash);
  const b = Buffer.from(hash);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  // Best-effort: a failure to record last-used must not fail the request.
  await db
    .update(apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(apiKeys.id, row.id))
    .catch(() => undefined);

  return { keyId: row.id, brokerId: row.brokerId, scopes: row.scopes };
}

export function hasScope(caller: ApiCaller, scope: Scope): boolean {
  return caller.scopes.includes(scope);
}

export async function revokeApiKey(db: Db, keyId: string): Promise<void> {
  await db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, keyId));
}

export async function listApiKeys(db: Db) {
  return db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      keyPrefix: apiKeys.keyPrefix,
      scopes: apiKeys.scopes,
      lastUsedAt: apiKeys.lastUsedAt,
      revokedAt: apiKeys.revokedAt,
      createdAt: apiKeys.createdAt,
    })
    .from(apiKeys)
    .orderBy(sql`${apiKeys.createdAt} DESC`);
}
