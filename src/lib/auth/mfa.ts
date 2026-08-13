/**
 * Two-factor authentication, account side.
 *
 * The enrolment dance, and why it has three steps rather than one:
 *
 *   1. `beginEnrolment` generates a secret and stores it with `totpEnabled`
 *      still false. The secret has to be persisted before the user can scan it,
 *      but an unconfirmed secret must not gate login — otherwise closing the
 *      tab mid-setup locks you out of your own account.
 *
 *   2. `confirmEnrolment` requires a working code from that secret. Only then
 *      does 2FA switch on, which proves the authenticator actually holds the
 *      secret before anything depends on it.
 *
 *   3. Recovery codes are issued at confirmation and shown once. They are the
 *      answer to a lost phone, and without them enabling 2FA on a portal that
 *      has no support desk is a way to permanently lose access to a mortgage
 *      file.
 *
 * Codes and recovery codes are both hashed with the same scrypt parameters as
 * passwords. A recovery code is a password — it is a single string that grants
 * access — and storing it in the clear would make the recovery table an
 * authentication bypass.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';

import type { Db } from '@/db';
import { brokers, clients, recoveryCodes, sessions } from '@/db/schema';
import { hashPassword, verifyPassword } from '@/lib/auth/password';
import {
  generateRecoveryCodes,
  generateTotpSecret,
  normaliseRecoveryCode,
  totpUri,
  verifyTotp,
} from '@/lib/auth/totp';
import { recordAudit } from '@/lib/audit';
import { env } from '@/lib/env';

export type MfaUserType = 'client' | 'broker';

/** The two account tables are structurally identical for MFA purposes. */
function table(userType: MfaUserType) {
  return userType === 'client' ? clients : brokers;
}

export interface MfaStatus {
  enabled: boolean;
  confirmedAt: Date | null;
  recoveryCodesRemaining: number;
}

export async function getMfaStatus(
  db: Db,
  userType: MfaUserType,
  userId: string,
): Promise<MfaStatus> {
  const account = table(userType);

  const [row] = await db
    .select({ enabled: account.totpEnabled, confirmedAt: account.totpConfirmedAt })
    .from(account)
    .where(eq(account.id, userId))
    .limit(1);

  const [remaining] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(recoveryCodes)
    .where(
      and(
        eq(recoveryCodes.userType, userType),
        eq(recoveryCodes.userId, userId),
        isNull(recoveryCodes.usedAt),
      ),
    );

  return {
    enabled: row?.enabled ?? false,
    confirmedAt: row?.confirmedAt ?? null,
    recoveryCodesRemaining: remaining?.count ?? 0,
  };
}

export interface EnrolmentStart {
  secret: string;
  uri: string;
}

/**
 * Step 1 — issue a secret to scan.
 *
 * Re-running this before confirmation replaces the pending secret, which is the
 * behaviour you want when someone abandons setup and starts again on a
 * different phone. Re-running it AFTER confirmation is refused: silently
 * rotating a live secret would lock the user out of an account they can
 * currently access.
 */
export async function beginEnrolment(
  db: Db,
  userType: MfaUserType,
  userId: string,
  accountLabel: string,
): Promise<EnrolmentStart> {
  const account = table(userType);

  const [existing] = await db
    .select({ enabled: account.totpEnabled })
    .from(account)
    .where(eq(account.id, userId))
    .limit(1);

  if (existing?.enabled) {
    throw new Error('Two-factor authentication is already switched on for this account.');
  }

  const secret = generateTotpSecret();

  await db
    .update(account)
    .set({ totpSecret: secret, totpEnabled: false, totpConfirmedAt: null, totpLastStep: null })
    .where(eq(account.id, userId));

  return { secret, uri: totpUri(secret, accountLabel, env.appName) };
}

export interface EnrolmentResult {
  ok: boolean;
  error?: string;
  /** Shown exactly once. Never retrievable afterwards. */
  recoveryCodes?: string[];
}

/** Step 2 — prove the authenticator works, then switch 2FA on. */
export async function confirmEnrolment(
  db: Db,
  userType: MfaUserType,
  userId: string,
  token: string,
): Promise<EnrolmentResult> {
  const account = table(userType);

  const [row] = await db
    .select({ secret: account.totpSecret, enabled: account.totpEnabled })
    .from(account)
    .where(eq(account.id, userId))
    .limit(1);

  if (!row?.secret) {
    return { ok: false, error: 'Start the setup again — there is no pending secret.' };
  }
  if (row.enabled) {
    return { ok: false, error: 'Two-factor authentication is already switched on.' };
  }

  const check = verifyTotp(row.secret, token);
  if (!check.valid) {
    return { ok: false, error: 'That code is not right. Check your authenticator and try again.' };
  }

  const codes = generateRecoveryCodes();

  await db
    .update(account)
    .set({ totpEnabled: true, totpConfirmedAt: new Date(), totpLastStep: check.step })
    .where(eq(account.id, userId));

  // Replace any codes from a previous enrolment rather than accumulating them.
  await db
    .delete(recoveryCodes)
    .where(and(eq(recoveryCodes.userType, userType), eq(recoveryCodes.userId, userId)));

  for (const code of codes) {
    await db.insert(recoveryCodes).values({
      userType,
      userId,
      codeHash: await hashPassword(normaliseRecoveryCode(code)),
    });
  }

  await recordAudit(db, {
    actorType: userType,
    actorId: userId,
    action: 'mfa.enabled',
    targetType: userType,
    targetId: userId,
    clientId: userType === 'client' ? userId : null,
  });

  return { ok: true, recoveryCodes: codes };
}

export interface ChallengeResult {
  ok: boolean;
  error?: string;
  /** True when a recovery code was spent rather than a TOTP code. */
  usedRecoveryCode?: boolean;
  recoveryCodesRemaining?: number;
}

/**
 * Step 3 — the login challenge.
 *
 * Accepts either a TOTP code or an unused recovery code, because at the moment
 * someone needs a recovery code they cannot produce a TOTP one, and asking them
 * to choose a mode first is friction at the worst possible time.
 */
export async function verifyChallenge(
  db: Db,
  userType: MfaUserType,
  userId: string,
  token: string,
): Promise<ChallengeResult> {
  const account = table(userType);

  const [row] = await db
    .select({
      secret: account.totpSecret,
      enabled: account.totpEnabled,
      lastStep: account.totpLastStep,
    })
    .from(account)
    .where(eq(account.id, userId))
    .limit(1);

  if (!row?.enabled || !row.secret) {
    return { ok: false, error: 'Two-factor authentication is not set up for this account.' };
  }

  const check = verifyTotp(row.secret, token, { lastUsedStep: row.lastStep });

  if (check.valid) {
    await db
      .update(account)
      .set({ totpLastStep: check.step })
      .where(eq(account.id, userId));

    return { ok: true };
  }

  // Not a valid TOTP code — try it as a recovery code.
  const normalised = normaliseRecoveryCode(token);
  if (normalised.length === 10) {
    const candidates = await db
      .select({ id: recoveryCodes.id, codeHash: recoveryCodes.codeHash })
      .from(recoveryCodes)
      .where(
        and(
          eq(recoveryCodes.userType, userType),
          eq(recoveryCodes.userId, userId),
          isNull(recoveryCodes.usedAt),
        ),
      );

    // Every candidate is checked even after a match is found. Returning early
    // would make the response time reveal how many codes remain.
    let matched: string | null = null;
    for (const candidate of candidates) {
      if (await verifyPassword(normalised, candidate.codeHash)) {
        matched ??= candidate.id;
      }
    }

    if (matched) {
      await db
        .update(recoveryCodes)
        .set({ usedAt: new Date() })
        .where(eq(recoveryCodes.id, matched));

      await recordAudit(db, {
        actorType: userType,
        actorId: userId,
        action: 'mfa.recovery_code_used',
        targetType: userType,
        targetId: userId,
        clientId: userType === 'client' ? userId : null,
      });

      return {
        ok: true,
        usedRecoveryCode: true,
        recoveryCodesRemaining: candidates.length - 1,
      };
    }
  }

  return { ok: false, error: 'That code is not right.' };
}

/**
 * Switch 2FA off.
 *
 * Requires a current code, not just a signed-in session: if an attacker has
 * ridden a session this far, letting them disarm the second factor without
 * proving they hold it defeats the point.
 *
 * Every other session is revoked, because turning 2FA off is exactly the sort
 * of account change where a session you did not create should not survive.
 */
export async function disableMfa(
  db: Db,
  userType: MfaUserType,
  userId: string,
  token: string,
): Promise<{ ok: boolean; error?: string }> {
  const challenge = await verifyChallenge(db, userType, userId, token);
  if (!challenge.ok) return { ok: false, error: challenge.error };

  const account = table(userType);

  await db
    .update(account)
    .set({ totpEnabled: false, totpSecret: null, totpConfirmedAt: null, totpLastStep: null })
    .where(eq(account.id, userId));

  await db
    .delete(recoveryCodes)
    .where(and(eq(recoveryCodes.userType, userType), eq(recoveryCodes.userId, userId)));

  await db
    .delete(sessions)
    .where(and(eq(sessions.userType, userType), eq(sessions.userId, userId)));

  await recordAudit(db, {
    actorType: userType,
    actorId: userId,
    action: 'mfa.disabled',
    targetType: userType,
    targetId: userId,
    clientId: userType === 'client' ? userId : null,
  });

  return { ok: true };
}

/** Fresh codes, e.g. after most of the old set has been spent. */
export async function regenerateRecoveryCodes(
  db: Db,
  userType: MfaUserType,
  userId: string,
  token: string,
): Promise<EnrolmentResult> {
  const challenge = await verifyChallenge(db, userType, userId, token);
  if (!challenge.ok) return { ok: false, error: challenge.error };

  const codes = generateRecoveryCodes();

  await db
    .delete(recoveryCodes)
    .where(and(eq(recoveryCodes.userType, userType), eq(recoveryCodes.userId, userId)));

  for (const code of codes) {
    await db.insert(recoveryCodes).values({
      userType,
      userId,
      codeHash: await hashPassword(normaliseRecoveryCode(code)),
    });
  }

  await recordAudit(db, {
    actorType: userType,
    actorId: userId,
    action: 'mfa.recovery_codes_regenerated',
    targetType: userType,
    targetId: userId,
    clientId: userType === 'client' ? userId : null,
  });

  return { ok: true, recoveryCodes: codes };
}

/** True when this account must clear a challenge before its session counts. */
export async function requiresMfa(
  db: Db,
  userType: MfaUserType,
  userId: string,
): Promise<boolean> {
  const account = table(userType);

  const [row] = await db
    .select({ enabled: account.totpEnabled })
    .from(account)
    .where(eq(account.id, userId))
    .limit(1);

  return row?.enabled ?? false;
}
