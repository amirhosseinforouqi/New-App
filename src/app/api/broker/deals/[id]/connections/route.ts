/**
 * Recording bank, CRA and bureau verification on a deal.
 *
 * This records what happened; it does not perform the verification. See
 * `src/lib/deals/connections.ts` for why — every one of these needs a vendor
 * agreement this codebase cannot ship with.
 *
 * The consent gate is enforced here and not only in the UI. Marking a bureau
 * pull or a bank connection as requested against a borrower who has not signed
 * is exactly the thing the consent exists to prevent.
 */

import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import { asBroker } from '@/db';
import { consents, externalConnections } from '@/db/schema';
import { recordAudit } from '@/lib/audit';
import { getCurrentUser } from '@/lib/auth/session';
import { canRequest, CONNECTION_KINDS_BY_KEY } from '@/lib/deals/connections';
import { getDealDetail } from '@/lib/deals/queries';

const bodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('record'),
    clientId: z.string().uuid(),
    kind: z.string().min(1).max(64),
    status: z.enum(['requested', 'received', 'declined']),
    detail: z.string().trim().max(500).optional(),
  }),
  z.object({
    action: z.literal('remove'),
    connectionId: z.string().uuid(),
  }),
]);

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user || user.kind !== 'broker') {
    return NextResponse.json({ error: 'Not authorised.' }, { status: 403 });
  }

  const { id: dealId } = await context.params;
  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  const body = parsed.data;

  return asBroker(user.id, async (db) => {
    const detail = await getDealDetail(db, dealId);
    if (!detail) return NextResponse.json({ error: 'Deal not found.' }, { status: 404 });

    if (body.action === 'remove') {
      await db
        .delete(externalConnections)
        .where(
          and(eq(externalConnections.id, body.connectionId), eq(externalConnections.dealId, dealId)),
        );

      return NextResponse.json({ ok: true });
    }

    const kind = CONNECTION_KINDS_BY_KEY.get(body.kind);
    if (!kind) return NextResponse.json({ error: 'No such verification.' }, { status: 404 });

    // The borrower must actually be on this deal — a client id from elsewhere
    // must not be able to attach a record here.
    if (!detail.borrowers.some((borrower) => borrower.clientId === body.clientId)) {
      return NextResponse.json({ error: 'That borrower is not on this deal.' }, { status: 400 });
    }

    if (kind.requiresConsent) {
      const [signed] = await db
        .select({ id: consents.id })
        .from(consents)
        .where(
          and(
            eq(consents.dealId, dealId),
            eq(consents.clientId, body.clientId),
            eq(consents.kind, 'credit_pull'),
          ),
        )
        .limit(1);

      const gate = canRequest(kind, Boolean(signed));
      if (!gate.allowed) {
        return NextResponse.json({ error: gate.reason }, { status: 400 });
      }
    }

    await db.insert(externalConnections).values({
      clientId: body.clientId,
      dealId,
      kind: body.kind,
      // Honest by default. When a vendor agreement exists this becomes the
      // vendor's name and `externalRef` carries their request id.
      provider: 'manual',
      status: body.status,
      detail: body.detail ?? null,
      completedAt: body.status === 'received' ? new Date() : null,
    });

    await recordAudit(db, {
      actorType: 'broker',
      actorId: user.id,
      action: 'connection.recorded',
      targetType: 'deal',
      targetId: dealId,
      clientId: body.clientId,
      metadata: { kind: body.kind, status: body.status },
    });

    return NextResponse.json({ ok: true });
  });
}
