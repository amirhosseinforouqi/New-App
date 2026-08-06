/**
 * Session issue, lookup and revocation.
 *
 * Design notes:
 *  - The cookie holds a 32-byte random token. Only its SHA-256 is stored, so
 *    a database dump does not yield usable sessions.
 *  - The cookie is httpOnly + sameSite=lax + secure (in production), so it is
 *    unreadable from JavaScript and not sent on cross-site POSTs.
 *  - Lookup happens under the `system` actor because we do not yet know who
 *    the user is — that is the whole point of the lookup. Everything after
 *    resolution runs under the resolved actor.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { and, eq, gt, lt } from 'drizzle-orm';

import { asSystem } from '@/db';
import { brokers, clients, sessions } from '@/db/schema';
import { env } from '@/lib/env';

export const SESSION_COOKIE = 'uwa_session';
const SESSION_TTL_HOURS = 12;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export type AuthenticatedUser =
  | {
      kind: 'client';
      id: string;
      fullName: string;
      email: string;
      username: string;
      mustChangePassword: boolean;
      stageKey: string;
      status: string;
    }
  | { kind: 'broker'; id: string; fullName: string; email: string };

/** Issue a session and set the cookie. Returns the raw token for tests. */
export async function createSession(
  userType: 'client' | 'broker',
  userId: string,
  meta: { ip?: string; userAgent?: string } = {},
): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 60 * 60 * 1000);

  await asSystem(async (db) => {
    await db.insert(sessions).values({
      tokenHash: hashToken(token),
      userType,
      userId,
      expiresAt,
      ipAddress: meta.ip ?? null,
      userAgent: meta.userAgent?.slice(0, 500) ?? null,
    });
  });

  const store = await cookies();
  store.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.isProduction,
    path: '/',
    expires: expiresAt,
  });

  return token;
}

/**
 * Resolve the current session, or null.
 *
 * Also enforces client status: a suspended or archived client holding a valid
 * cookie is refused, so revoking access does not require hunting down sessions.
 */
export async function getCurrentUser(): Promise<AuthenticatedUser | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;

  return asSystem(async (db) => {
    const [session] = await db
      .select()
      .from(sessions)
      .where(and(eq(sessions.tokenHash, hashToken(token)), gt(sessions.expiresAt, new Date())))
      .limit(1);

    if (!session) return null;

    if (session.userType === 'broker') {
      const [broker] = await db
        .select()
        .from(brokers)
        .where(and(eq(brokers.id, session.userId), eq(brokers.isActive, true)))
        .limit(1);
      if (!broker) return null;

      return {
        kind: 'broker' as const,
        id: broker.id,
        fullName: broker.fullName,
        email: broker.email,
      };
    }

    if (session.userType === 'client') {
      const [client] = await db
        .select()
        .from(clients)
        .where(eq(clients.id, session.userId))
        .limit(1);
      if (!client) return null;
      if (client.status === 'suspended' || client.status === 'archived') return null;

      return {
        kind: 'client' as const,
        id: client.id,
        fullName: client.fullName,
        email: client.email,
        username: client.username,
        mustChangePassword: client.mustChangePassword,
        stageKey: client.stageKey,
        status: client.status,
      };
    }

    return null;
  });
}

/** Throw-if-absent helpers for route handlers. */
export async function requireClient() {
  const user = await getCurrentUser();
  if (!user || user.kind !== 'client') {
    throw new AuthError('Not authenticated as a client');
  }
  return user;
}

export async function requireBroker() {
  const user = await getCurrentUser();
  if (!user || user.kind !== 'broker') {
    throw new AuthError('Not authenticated as a broker');
  }
  return user;
}

export class AuthError extends Error {
  readonly status = 401;
}

export async function destroySession(): Promise<void> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;

  if (token) {
    await asSystem(async (db) => {
      await db.delete(sessions).where(eq(sessions.tokenHash, hashToken(token)));
    });
  }

  store.delete(SESSION_COOKIE);
}

/** Revoke every session for a user — used when a password changes. */
export async function destroyAllSessionsFor(
  userType: 'client' | 'broker',
  userId: string,
): Promise<void> {
  await asSystem(async (db) => {
    await db
      .delete(sessions)
      .where(and(eq(sessions.userType, userType), eq(sessions.userId, userId)));
  });
}

/** Housekeeping — call from a cron or on boot. */
export async function pruneExpiredSessions(): Promise<number> {
  return asSystem(async (db) => {
    const deleted = await db
      .delete(sessions)
      .where(lt(sessions.expiresAt, new Date()))
      .returning({ id: sessions.id });
    return deleted.length;
  });
}

/**
 * Compare two secrets in constant time. Used for the login flow's dummy-hash
 * path so that a request for a non-existent user takes the same time as one
 * for a real user — otherwise response timing enumerates your client list.
 */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
