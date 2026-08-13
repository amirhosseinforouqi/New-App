/**
 * The second-factor challenge.
 *
 * Reachable only by a half-authenticated session — one that has passed the
 * password but not this. That is what stops it being an oracle: without a valid
 * session cookie there is no account to challenge, so it cannot be used to test
 * codes against an arbitrary user.
 *
 * Rate-limited per session rather than per IP. Six digits is a million
 * possibilities, and a code stays live for ninety seconds with drift tolerance;
 * unlimited guesses would make that brute-forceable in minutes.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';

import { asSystem } from '@/db';
import { recordAudit } from '@/lib/audit';
import { verifyChallenge } from '@/lib/auth/mfa';
import { destroySession, getPendingMfaUser, markMfaSatisfied } from '@/lib/auth/session';

const bodySchema = z.object({ token: z.string().trim().min(1).max(32) });

const MAX_ATTEMPTS = 6;
const attempts = new Map<string, { count: number; resetAt: number }>();
const WINDOW_MS = 15 * 60 * 1000;

function tooManyAttempts(key: string): boolean {
  const now = Date.now();
  const record = attempts.get(key);

  if (!record || now > record.resetAt) {
    attempts.set(key, { count: 1, resetAt: now + WINDOW_MS });
    if (attempts.size > 5_000) {
      for (const [id, value] of attempts) if (now > value.resetAt) attempts.delete(id);
    }
    return false;
  }

  record.count += 1;
  return record.count > MAX_ATTEMPTS;
}

export async function POST(request: Request) {
  const user = await getPendingMfaUser();
  if (!user) {
    return NextResponse.json(
      { error: 'There is no verification in progress. Sign in again.' },
      { status: 401 },
    );
  }

  if (tooManyAttempts(`${user.kind}:${user.id}`)) {
    // Too many wrong codes ends the half-session outright. Leaving it alive
    // would let an attacker who has the password keep trying after the window.
    await destroySession();
    return NextResponse.json(
      { error: 'Too many incorrect codes. Sign in again.', signOut: true },
      { status: 429 },
    );
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Enter the 6-digit code.' }, { status: 400 });
  }

  const result = await asSystem(async (db) =>
    verifyChallenge(db, user.kind, user.id, parsed.data.token),
  );

  if (!result.ok) {
    await asSystem(async (db) => {
      await recordAudit(db, {
        actorType: user.kind,
        actorId: user.id,
        action: 'mfa.challenge_failed',
        clientId: user.kind === 'client' ? user.id : null,
      });
    });

    return NextResponse.json({ error: result.error ?? 'That code is not right.' }, { status: 401 });
  }

  await markMfaSatisfied();
  attempts.delete(`${user.kind}:${user.id}`);

  const redirect =
    user.kind === 'broker' ? '/broker' : user.mustChangePassword ? '/change-password' : '/dashboard';

  return NextResponse.json({
    ok: true,
    redirect,
    usedRecoveryCode: result.usedRecoveryCode ?? false,
    recoveryCodesRemaining: result.recoveryCodesRemaining,
  });
}
