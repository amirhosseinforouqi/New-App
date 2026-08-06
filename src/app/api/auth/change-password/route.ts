/**
 * Password change for the signed-in client.
 *
 * Requires the current password even when `mustChangePassword` is set — a
 * borrowed unlocked laptop should not be enough to take over the account.
 *
 * On success every other session for this client is revoked, so a password
 * change is also the "sign me out everywhere" action.
 */

import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { asSystem } from '@/db';
import { clients } from '@/db/schema';
import { recordAudit } from '@/lib/audit';
import { hashPassword, verifyPassword } from '@/lib/auth/password';
import {
  createSession,
  destroyAllSessionsFor,
  getCurrentUser,
} from '@/lib/auth/session';

const bodySchema = z.object({
  currentPassword: z.string().min(1),
  // 12 is above the NIST floor and realistic for a passphrase. Length is the
  // only requirement — composition rules push people toward "Password1!".
  newPassword: z.string().min(12, 'Choose a password of at least 12 characters.').max(400),
});

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user || user.kind !== 'client') {
    return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid request.' },
      { status: 400 },
    );
  }

  const { currentPassword, newPassword } = parsed.data;

  if (currentPassword === newPassword) {
    return NextResponse.json(
      { error: 'Your new password must be different from the current one.' },
      { status: 400 },
    );
  }

  const result = await asSystem(async (db) => {
    const [client] = await db.select().from(clients).where(eq(clients.id, user.id)).limit(1);
    if (!client) return { ok: false as const, error: 'Account not found.' };

    if (!(await verifyPassword(currentPassword, client.passwordHash))) {
      await recordAudit(db, {
        actorType: 'client',
        actorId: client.id,
        action: 'client.login_failed',
        clientId: client.id,
        metadata: { context: 'change_password' },
      });
      return { ok: false as const, error: 'Your current password is not correct.' };
    }

    await db
      .update(clients)
      .set({
        passwordHash: await hashPassword(newPassword),
        mustChangePassword: false,
        status: client.status === 'invited' ? 'active' : client.status,
        updatedAt: new Date(),
      })
      .where(eq(clients.id, client.id));

    await recordAudit(db, {
      actorType: 'client',
      actorId: client.id,
      action: 'client.password_changed',
      clientId: client.id,
    });

    return { ok: true as const };
  });

  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }

  // Revoke everything, then issue a fresh session so the user is not bounced
  // to the login screen immediately after succeeding.
  await destroyAllSessionsFor('client', user.id);
  await createSession('client', user.id);

  return NextResponse.json({ ok: true, redirect: '/dashboard' });
}
