/**
 * Managing two-factor authentication on your own account.
 *
 * Deliberately self-service only — the `userId` is always taken from the
 * session and never from the request body. An endpoint that let a broker
 * enrol, disable or re-key someone else's second factor would be a
 * privilege-escalation route dressed up as an admin convenience.
 *
 * A broker who needs to help a locked-out client reissues their credentials
 * instead, which is already audited and already revokes live sessions.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';

import { asSystem } from '@/db';
import {
  beginEnrolment,
  confirmEnrolment,
  disableMfa,
  getMfaStatus,
  regenerateRecoveryCodes,
} from '@/lib/auth/mfa';
import { getCurrentUser } from '@/lib/auth/session';

const bodySchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('begin') }),
  z.object({ action: z.literal('confirm'), token: z.string().trim().min(1).max(32) }),
  z.object({ action: z.literal('disable'), token: z.string().trim().min(1).max(32) }),
  z.object({ action: z.literal('regenerate'), token: z.string().trim().min(1).max(32) }),
]);

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });

  const status = await asSystem(async (db) => getMfaStatus(db, user.kind, user.id));
  return NextResponse.json(status);
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Not authenticated.' }, { status: 401 });

  // A half-authenticated session may not change security settings. It has not
  // finished proving who it belongs to.
  if (!user.mfaSatisfied) {
    return NextResponse.json({ error: 'Finish verifying first.' }, { status: 403 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  const body = parsed.data;
  const label = user.kind === 'client' ? user.username : user.email;

  try {
    switch (body.action) {
      case 'begin': {
        const start = await asSystem(async (db) =>
          beginEnrolment(db, user.kind, user.id, label),
        );
        return NextResponse.json(start);
      }

      case 'confirm': {
        const result = await asSystem(async (db) =>
          confirmEnrolment(db, user.kind, user.id, body.token),
        );
        return result.ok
          ? NextResponse.json({ ok: true, recoveryCodes: result.recoveryCodes })
          : NextResponse.json({ error: result.error }, { status: 400 });
      }

      case 'disable': {
        const result = await asSystem(async (db) =>
          disableMfa(db, user.kind, user.id, body.token),
        );
        // Disabling revokes every session including this one, so the client
        // must send the user back to sign in.
        return result.ok
          ? NextResponse.json({ ok: true, signOut: true })
          : NextResponse.json({ error: result.error }, { status: 400 });
      }

      case 'regenerate': {
        const result = await asSystem(async (db) =>
          regenerateRecoveryCodes(db, user.kind, user.id, body.token),
        );
        return result.ok
          ? NextResponse.json({ ok: true, recoveryCodes: result.recoveryCodes })
          : NextResponse.json({ error: result.error }, { status: 400 });
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
