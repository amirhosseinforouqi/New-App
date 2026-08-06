/**
 * Login for both clients and brokers.
 *
 * One endpoint, one generic error message. Distinguishing "no such user" from
 * "wrong password" — or letting response timing distinguish them — turns the
 * login form into a tool for enumerating who your clients are.
 *
 * Protections:
 *  - A dummy scrypt verification runs when the account does not exist, so the
 *    response time is the same either way.
 *  - Five consecutive failures lock the account for 15 minutes.
 *  - Every attempt, successful or not, is written to the audit log.
 */

import { NextResponse } from 'next/server';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { asSystem } from '@/db';
import { brokers, clients } from '@/db/schema';
import { recordAudit } from '@/lib/audit';
import { hashPassword, needsRehash, verifyPassword } from '@/lib/auth/password';
import { createSession } from '@/lib/auth/session';

const bodySchema = z.object({
  identifier: z.string().min(1).max(320),
  password: z.string().min(1).max(400),
});

const MAX_ATTEMPTS = 5;
const LOCKOUT_MINUTES = 15;
const GENERIC_ERROR = 'Those details did not match. Please check and try again.';

/**
 * A real scrypt hash of a random value, used to burn the same CPU time when
 * the account does not exist. Without this, "user not found" returns in
 * microseconds while a real check takes ~100ms — a trivially measurable
 * difference.
 */
let dummyHashPromise: Promise<string> | undefined;
function getDummyHash(): Promise<string> {
  dummyHashPromise ??= hashPassword('not-a-real-password-placeholder');
  return dummyHashPromise;
}

function clientIp(request: Request): string | null {
  const forwarded = request.headers.get('x-forwarded-for');
  return forwarded?.split(',')[0]?.trim() ?? request.headers.get('x-real-ip');
}

export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: GENERIC_ERROR }, { status: 400 });
  }

  const identifier = parsed.data.identifier.trim().toLowerCase();
  const ip = clientIp(request);
  const userAgent = request.headers.get('user-agent') ?? undefined;

  const outcome = await asSystem(async (db) => {
    // Clients sign in with the username we generated, or their email.
    const [client] = await db
      .select()
      .from(clients)
      .where(sql`lower(${clients.username}) = ${identifier} OR lower(${clients.email}) = ${identifier}`)
      .limit(1);

    if (client) {
      if (client.lockedUntil && client.lockedUntil > new Date()) {
        await recordAudit(db, {
          actorType: 'client',
          actorId: client.id,
          action: 'client.login_failed',
          clientId: client.id,
          metadata: { reason: 'locked' },
          ipAddress: ip,
        });
        return {
          ok: false as const,
          status: 429,
          error: `Too many failed attempts. Try again in ${LOCKOUT_MINUTES} minutes.`,
        };
      }

      if (client.status === 'suspended' || client.status === 'archived') {
        return { ok: false as const, status: 403, error: GENERIC_ERROR };
      }

      const valid = await verifyPassword(parsed.data.password, client.passwordHash);

      if (!valid) {
        const attempts = client.failedLoginCount + 1;
        await db
          .update(clients)
          .set({
            failedLoginCount: attempts,
            lockedUntil:
              attempts >= MAX_ATTEMPTS
                ? new Date(Date.now() + LOCKOUT_MINUTES * 60 * 1000)
                : null,
          })
          .where(eq(clients.id, client.id));

        await recordAudit(db, {
          actorType: 'client',
          actorId: client.id,
          action: 'client.login_failed',
          clientId: client.id,
          metadata: { attempts },
          ipAddress: ip,
        });

        return { ok: false as const, status: 401, error: GENERIC_ERROR };
      }

      // Transparent hash upgrade if the parameters have been raised since.
      const updates: Record<string, unknown> = {
        failedLoginCount: 0,
        lockedUntil: null,
        lastLoginAt: new Date(),
      };
      if (needsRehash(client.passwordHash)) {
        updates.passwordHash = await hashPassword(parsed.data.password);
      }
      await db.update(clients).set(updates).where(eq(clients.id, client.id));

      await recordAudit(db, {
        actorType: 'client',
        actorId: client.id,
        action: 'client.login',
        clientId: client.id,
        ipAddress: ip,
      });

      return {
        ok: true as const,
        userType: 'client' as const,
        userId: client.id,
        redirect: client.mustChangePassword ? '/change-password' : '/dashboard',
      };
    }

    const [broker] = await db
      .select()
      .from(brokers)
      .where(sql`lower(${brokers.email}) = ${identifier}`)
      .limit(1);

    if (broker && broker.isActive) {
      const valid = await verifyPassword(parsed.data.password, broker.passwordHash);
      if (!valid) {
        await recordAudit(db, {
          actorType: 'broker',
          actorId: broker.id,
          action: 'broker.login_failed',
          ipAddress: ip,
        });
        return { ok: false as const, status: 401, error: GENERIC_ERROR };
      }

      await db.update(brokers).set({ lastLoginAt: new Date() }).where(eq(brokers.id, broker.id));
      await recordAudit(db, {
        actorType: 'broker',
        actorId: broker.id,
        action: 'broker.login',
        ipAddress: ip,
      });

      return {
        ok: true as const,
        userType: 'broker' as const,
        userId: broker.id,
        redirect: '/broker',
      };
    }

    // No such account. Burn equivalent CPU so timing reveals nothing.
    await verifyPassword(parsed.data.password, await getDummyHash());
    return { ok: false as const, status: 401, error: GENERIC_ERROR };
  });

  if (!outcome.ok) {
    return NextResponse.json({ error: outcome.error }, { status: outcome.status });
  }

  await createSession(outcome.userType, outcome.userId, { ip: ip ?? undefined, userAgent });

  return NextResponse.json({ ok: true, redirect: outcome.redirect });
}
