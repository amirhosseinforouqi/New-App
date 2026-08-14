/**
 * Adjusting the submission rules.
 *
 * Owners only. Where the readiness bar sits is a brokerage policy decision, and
 * an agent who found a rule inconvenient should not be able to switch it off on
 * their own file.
 *
 * Locked rules are refused here as well as ignored by the engine. FINTRAC
 * identity verification and the borrower's credit-pull consent are legal
 * obligations, so there is no code path — UI, API or otherwise — that turns
 * them off.
 */

import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { asBroker, asSystem } from '@/db';
import { brokers } from '@/db/schema';
import { recordAudit } from '@/lib/audit';
import { getCurrentUser } from '@/lib/auth/session';
import { resetRuleSetting, saveRuleSetting } from '@/lib/deals/rule-settings';
import { RULES_BY_KEY } from '@/lib/deals/validation';

const bodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('set'),
    ruleKey: z.string().min(1).max(64),
    severity: z.enum(['blocking', 'warning']),
    enabled: z.boolean(),
  }),
  z.object({
    action: z.literal('reset'),
    ruleKey: z.string().min(1).max(64),
  }),
]);

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user || user.kind !== 'broker') {
    return NextResponse.json({ error: 'Not authorised.' }, { status: 403 });
  }

  const [me] = await asSystem(async (db) =>
    db.select({ role: brokers.role }).from(brokers).where(eq(brokers.id, user.id)).limit(1),
  );

  if (me?.role !== 'owner') {
    return NextResponse.json(
      { error: 'Only an owner can change the submission rules.' },
      { status: 403 },
    );
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  const body = parsed.data;
  const rule = RULES_BY_KEY.get(body.ruleKey);

  if (!rule) {
    return NextResponse.json({ error: 'No such rule.' }, { status: 404 });
  }

  if (rule.locked) {
    return NextResponse.json(
      { error: rule.lockedReason ?? 'That rule cannot be changed.' },
      { status: 403 },
    );
  }

  return asBroker(user.id, async (db) => {
    const ok =
      body.action === 'reset'
        ? await resetRuleSetting(db, body.ruleKey)
        : await saveRuleSetting(db, {
            ruleKey: body.ruleKey,
            severity: body.severity,
            enabled: body.enabled,
          });

    if (!ok) {
      return NextResponse.json({ error: 'That rule cannot be changed.' }, { status: 403 });
    }

    await recordAudit(db, {
      actorType: 'broker',
      actorId: user.id,
      action: 'validation_rule.changed',
      targetType: 'validation_rule',
      metadata:
        body.action === 'reset'
          ? { ruleKey: body.ruleKey, reset: true }
          : { ruleKey: body.ruleKey, severity: body.severity, enabled: body.enabled },
    });

    return NextResponse.json({ ok: true });
  });
}
