/**
 * Deal actions: move, assign, lock, archive.
 *
 * One endpoint with an `action` discriminator rather than four routes, because
 * every one of them is "update this deal and write an audit row" and splitting
 * them would duplicate the lookup, the authorisation and the audit three times.
 *
 * Stage moves keep the rule the client-level endpoint established: forward one
 * stage at a time, backward freely. A mis-click must not be able to tell a
 * borrower their mortgage is Funded.
 */

import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { asBroker } from '@/db';
import { clientStageHistory, deals } from '@/db/schema';
import { recordAudit } from '@/lib/audit';
import { getCurrentUser } from '@/lib/auth/session';
import { getDealDetail } from '@/lib/deals/queries';
import { sendEmail } from '@/lib/mail/smtp';
import { stageChangeEmail } from '@/lib/mail/templates';
import { canTransition, getStage, isStageKey } from '@/lib/pipeline/stages';

const bodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('move'),
    stageKey: z.string(),
    note: z.string().trim().max(1000).optional(),
    notifyClient: z.boolean().default(true),
  }),
  z.object({
    action: z.literal('assign'),
    /** null hands the deal back to the unassigned pool. */
    assignedTo: z.string().uuid().nullable(),
  }),
  z.object({ action: z.literal('lock'), locked: z.boolean() }),
  z.object({ action: z.literal('archive'), archived: z.boolean() }),
]);

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user || user.kind !== 'broker') {
    return NextResponse.json({ error: 'Not authorised.' }, { status: 403 });
  }

  const { id: dealId } = await context.params;
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid request.' },
      { status: 400 },
    );
  }

  const body = parsed.data;

  const outcome = await asBroker(user.id, async (db) => {
    const [deal] = await db.select().from(deals).where(eq(deals.id, dealId)).limit(1);
    if (!deal) return { ok: false as const, status: 404, error: 'Deal not found.' };

    switch (body.action) {
      case 'move': {
        if (!isStageKey(body.stageKey)) {
          return { ok: false as const, status: 400, error: `Unknown stage "${body.stageKey}".` };
        }
        if (deal.stageKey === body.stageKey) {
          return { ok: false as const, status: 400, error: 'The deal is already at that stage.' };
        }
        if (!canTransition(deal.stageKey, body.stageKey)) {
          return {
            ok: false as const,
            status: 400,
            error:
              'Deals move forward one stage at a time. Advance through the intermediate ' +
              'stage first.',
          };
        }

        const isFunded = body.stageKey === 'funded';

        await db
          .update(deals)
          .set({
            stageKey: body.stageKey,
            updatedAt: new Date(),
            ...(isFunded ? { status: 'funded' as const, fundedAt: new Date() } : {}),
          })
          .where(eq(deals.id, dealId));

        await db.insert(clientStageHistory).values({
          clientId: deal.clientId,
          dealId,
          stageKey: body.stageKey,
          note: body.note ?? null,
          advancedBy: user.id,
        });

        await recordAudit(db, {
          actorType: 'broker',
          actorId: user.id,
          action: 'stage.advanced',
          targetType: 'deal',
          targetId: dealId,
          clientId: deal.clientId,
          metadata: { from: deal.stageKey, to: body.stageKey, note: body.note },
        });

        return {
          ok: true as const,
          notify: body.notifyClient ? { stageKey: body.stageKey, note: body.note } : null,
        };
      }

      case 'assign': {
        await db
          .update(deals)
          .set({ assignedTo: body.assignedTo, updatedAt: new Date() })
          .where(eq(deals.id, dealId));

        await recordAudit(db, {
          actorType: 'broker',
          actorId: user.id,
          action: 'deal.assigned',
          targetType: 'deal',
          targetId: dealId,
          clientId: deal.clientId,
          metadata: { from: deal.assignedTo, to: body.assignedTo },
        });

        return { ok: true as const, notify: null };
      }

      case 'lock': {
        // The application lock: once underwriting starts, the borrower can no
        // longer change the numbers the lender is assessing. Uploads and
        // messages stay open — locking someone out of sending a document
        // would defeat the purpose of the portal.
        await db
          .update(deals)
          .set({
            lockedAt: body.locked ? new Date() : null,
            lockedBy: body.locked ? user.id : null,
            updatedAt: new Date(),
          })
          .where(eq(deals.id, dealId));

        await recordAudit(db, {
          actorType: 'broker',
          actorId: user.id,
          action: body.locked ? 'deal.locked' : 'deal.unlocked',
          targetType: 'deal',
          targetId: dealId,
          clientId: deal.clientId,
        });

        return { ok: true as const, notify: null };
      }

      case 'archive': {
        await db
          .update(deals)
          .set({
            status: body.archived ? 'archived' : 'active',
            archivedAt: body.archived ? new Date() : null,
            updatedAt: new Date(),
          })
          .where(eq(deals.id, dealId));

        await recordAudit(db, {
          actorType: 'broker',
          actorId: user.id,
          action: body.archived ? 'deal.archived' : 'deal.restored',
          targetType: 'deal',
          targetId: dealId,
          clientId: deal.clientId,
        });

        return { ok: true as const, notify: null };
      }
    }
  });

  if (!outcome.ok) {
    return NextResponse.json({ error: outcome.error }, { status: outcome.status });
  }

  // Notification happens outside the transaction: a slow SMTP server must not
  // hold a row lock on the deal the broker is still working in.
  let emailSent = false;
  const notify = outcome.notify;
  if (notify) {
    const stage = getStage(notify.stageKey);

    // Every borrower on the deal is told, not just the primary. A co-borrower
    // who finds out their mortgage funded from their spouse is a support call.
    const recipients = await asBroker(user.id, async (db) => {
      const detail = await getDealDetail(db, dealId);
      return detail?.borrowers ?? [];
    });

    const results = await Promise.all(
      recipients.map((borrower) =>
        sendEmail(
          borrower.email,
          stageChangeEmail({
            fullName: borrower.fullName,
            stageLabel: stage.label,
            stageDescription: stage.clientDescription,
            note: notify.note,
            brokerName: user.fullName,
          }),
        ),
      ),
    );

    emailSent = results.length > 0 && results.every((result) => result.ok);
  }

  return NextResponse.json({ ok: true, emailSent });
}
