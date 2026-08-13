/**
 * Team, commissions and referral codes.
 *
 * Owner-only throughout. An agent must not be able to change their own
 * commission split, promote themselves, or read the brokerage's payroll —
 * and every one of those checks is on the endpoint, because a role check that
 * exists only in the UI is decoration.
 *
 * Inviting a team member reuses the same credential machinery as onboarding a
 * client: a generated password, hashed, emailed, and forced to change on first
 * login. There is no second path to an account.
 */

import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { asBroker, asSystem } from '@/db';
import { brokers, commissionSplits, dealCommissions, deals, referralSources } from '@/db/schema';
import { recordAudit } from '@/lib/audit';
import { generatePassword, hashPassword } from '@/lib/auth/password';
import { getCurrentUser } from '@/lib/auth/session';
import { calculateCommission } from '@/lib/commissions/calculate';
import { sendEmail } from '@/lib/mail/smtp';
import { teamInviteEmail } from '@/lib/mail/templates';

const bodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('invite'),
    email: z.string().email(),
    fullName: z.string().trim().min(1).max(200),
    role: z.enum(['owner', 'agent', 'assistant', 'compliance']),
    commissionSplitPercent: z.number().min(0).max(100).default(70),
  }),
  z.object({
    action: z.literal('update_member'),
    brokerId: z.string().uuid(),
    role: z.enum(['owner', 'agent', 'assistant', 'compliance']).optional(),
    commissionSplitPercent: z.number().min(0).max(100).optional(),
    isActive: z.boolean().optional(),
  }),
  z.object({
    action: z.literal('record_commission'),
    dealId: z.string().uuid(),
    fundedAmount: z.number().nonnegative(),
    findersFeePercent: z.number().min(0).max(10),
    volumeBonus: z.number().nonnegative().default(0),
    splits: z
      .array(
        z.object({
          payeeName: z.string().trim().min(1).max(200),
          brokerId: z.string().uuid().nullable().optional(),
          percent: z.number().min(0).max(100),
          role: z.string().trim().max(40).default('agent'),
        }),
      )
      .min(1),
  }),
  z.object({
    action: z.literal('create_referral_code'),
    code: z
      .string()
      .trim()
      .min(2)
      .max(64)
      .regex(/^[A-Za-z0-9-]+$/, 'Use letters, numbers and hyphens only — it goes in a URL.'),
    label: z.string().trim().min(1).max(200),
    medium: z.string().trim().max(40).default('referral'),
  }),
]);

async function requireOwner() {
  const user = await getCurrentUser();
  if (!user || user.kind !== 'broker') return null;

  const [row] = await asSystem(async (db) =>
    db.select({ role: brokers.role }).from(brokers).where(eq(brokers.id, user.id)).limit(1),
  );

  return row?.role === 'owner' ? user : null;
}

export async function POST(request: Request) {
  const user = await requireOwner();
  if (!user) {
    return NextResponse.json(
      { error: 'Only the brokerage owner can manage the team.' },
      { status: 403 },
    );
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid request.' },
      { status: 400 },
    );
  }

  const body = parsed.data;

  switch (body.action) {
    case 'invite': {
      const password = generatePassword();
      const passwordHash = await hashPassword(password);

      // Runs as the acting BROKER, not as system. Migration 0007 permits
      // INSERT on `brokers` only when `app.broker_id` belongs to an active
      // owner, so the database — not this handler — is what stops an agent, an
      // assistant, or a compromised system-actor path from minting an admin.
      const created = await asBroker(user.id, async (db) => {
        const [existing] = await db
          .select({ id: brokers.id })
          .from(brokers)
          .where(eq(brokers.email, body.email.toLowerCase()))
          .limit(1);

        if (existing) return { ok: false as const, error: 'That email is already on the team.' };

        const [row] = await db
          .insert(brokers)
          .values({
            email: body.email.toLowerCase(),
            fullName: body.fullName,
            passwordHash,
            role: body.role,
            commissionSplitPercent: String(body.commissionSplitPercent),
            invitedBy: user.id,
          })
          .returning({ id: brokers.id });

        return { ok: true as const, id: row?.id ?? null };
      }).catch((error) => ({
        ok: false as const,
        error: error instanceof Error ? error.message : String(error),
      }));

      if (!created.ok) {
        return NextResponse.json({ error: created.error }, { status: 400 });
      }

      const mail = await sendEmail(
        body.email,
        teamInviteEmail({
          fullName: body.fullName,
          email: body.email,
          password,
          role: body.role,
          invitedBy: user.fullName,
        }),
      );

      await asBroker(user.id, async (db) => {
        await recordAudit(db, {
          actorType: 'broker',
          actorId: user.id,
          action: 'team.invited',
          targetType: 'broker',
          targetId: created.id,
          metadata: { email: body.email, role: body.role, emailSent: mail.ok },
        });
      });

      return NextResponse.json({
        ok: true,
        emailSent: mail.ok,
        // Shown once so the owner can pass it on by hand if mail is down.
        temporaryPassword: mail.ok ? undefined : password,
        warning: mail.ok
          ? undefined
          : `The invitation email failed (${mail.error}). Give them the password below yourself.`,
      });
    }

    case 'update_member': {
      if (body.brokerId === user.id && body.role && body.role !== 'owner') {
        return NextResponse.json(
          { error: 'You cannot demote yourself — another owner has to do it.' },
          { status: 400 },
        );
      }

      if (body.brokerId === user.id && body.isActive === false) {
        return NextResponse.json(
          { error: 'You cannot deactivate your own account.' },
          { status: 400 },
        );
      }

      await asBroker(user.id, async (db) => {
        await db
          .update(brokers)
          .set({
            ...(body.role ? { role: body.role } : {}),
            ...(body.commissionSplitPercent != null
              ? { commissionSplitPercent: String(body.commissionSplitPercent) }
              : {}),
            ...(body.isActive != null ? { isActive: body.isActive } : {}),
          })
          .where(eq(brokers.id, body.brokerId));
      });

      await asBroker(user.id, async (db) => {
        await recordAudit(db, {
          actorType: 'broker',
          actorId: user.id,
          action: 'team.updated',
          targetType: 'broker',
          targetId: body.brokerId,
          metadata: {
            role: body.role,
            commissionSplitPercent: body.commissionSplitPercent,
            isActive: body.isActive,
          },
        });
      });

      return NextResponse.json({ ok: true });
    }

    case 'record_commission': {
      const result = calculateCommission(
        {
          fundedAmount: body.fundedAmount,
          findersFeePercent: body.findersFeePercent,
          volumeBonus: body.volumeBonus,
        },
        body.splits,
      );

      return asBroker(user.id, async (db) => {
        const [deal] = await db
          .select({ id: deals.id, clientId: deals.clientId })
          .from(deals)
          .where(eq(deals.id, body.dealId))
          .limit(1);

        if (!deal) return NextResponse.json({ error: 'Deal not found.' }, { status: 404 });

        // One commission per deal; re-recording replaces it rather than
        // stacking a second payout on the same file.
        await db.delete(dealCommissions).where(eq(dealCommissions.dealId, body.dealId));

        const [commission] = await db
          .insert(dealCommissions)
          .values({
            dealId: body.dealId,
            fundedAmount: String(result.fundedAmount),
            findersFeePercent: String(result.findersFeePercent),
            volumeBonus: String(result.volumeBonus),
            totalCommission: String(result.totalCommission),
          })
          .returning({ id: dealCommissions.id });

        if (!commission) {
          return NextResponse.json({ error: 'Could not record it.' }, { status: 500 });
        }

        for (const split of result.splits) {
          await db.insert(commissionSplits).values({
            commissionId: commission.id,
            brokerId: split.brokerId ?? null,
            payeeName: split.payeeName,
            percent: String(split.percent),
            amount: String(split.amount),
            role: split.role ?? 'agent',
          });
        }

        await recordAudit(db, {
          actorType: 'broker',
          actorId: user.id,
          action: 'commission.recorded',
          targetType: 'deal',
          targetId: body.dealId,
          clientId: deal.clientId,
          metadata: { total: result.totalCommission, splits: result.splits.length },
        });

        return NextResponse.json({ ok: true, ...result });
      });
    }

    case 'create_referral_code': {
      return asBroker(user.id, async (db) => {
        const [row] = await db
          .insert(referralSources)
          .values({
            brokerId: user.id,
            code: body.code.toUpperCase(),
            label: body.label,
            medium: body.medium,
          })
          .onConflictDoNothing()
          .returning({ id: referralSources.id, code: referralSources.code });

        if (!row) {
          return NextResponse.json({ error: 'That code already exists.' }, { status: 409 });
        }

        return NextResponse.json({ ok: true, code: row.code });
      });
    }
  }
}
