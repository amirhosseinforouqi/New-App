/**
 * Saving and deleting product comparisons for a deal.
 *
 * The snapshot is built server-side from the same ranked matches the deal page
 * renders, rather than being posted by the client. A client that sent its own
 * numbers could save a comparison showing any payment it liked, and the saved
 * comparison is the record of what a borrower was quoted.
 */

import { NextResponse } from 'next/server';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import { asBroker } from '@/db';
import { scenarios } from '@/db/schema';
import { recordAudit } from '@/lib/audit';
import { getCurrentUser } from '@/lib/auth/session';
import { getDealDetail, num } from '@/lib/deals/queries';
import { buildSnapshot } from '@/lib/deals/scenarios';
import { loadWorkspace } from '@/lib/deals/workspace';

const bodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('save'),
    name: z.string().trim().min(1).max(120),
    // Two to four is not arbitrary: one is not a comparison, and past four the
    // table stops being readable on the page it is meant to be read from.
    productIds: z.array(z.string().uuid()).min(2).max(4),
  }),
  z.object({
    action: z.literal('delete'),
    scenarioId: z.string().uuid(),
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
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid request.' },
      { status: 400 },
    );
  }

  const body = parsed.data;

  return asBroker(user.id, async (db) => {
    const detail = await getDealDetail(db, dealId);
    if (!detail) return NextResponse.json({ error: 'Deal not found.' }, { status: 404 });

    if (body.action === 'delete') {
      // Scoped by deal id as well as scenario id so a scenario id from another
      // file cannot be deleted by guessing.
      await db
        .delete(scenarios)
        .where(and(eq(scenarios.id, body.scenarioId), eq(scenarios.dealId, dealId)));

      await recordAudit(db, {
        actorType: 'broker',
        actorId: user.id,
        action: 'scenario.deleted',
        targetType: 'deal',
        targetId: dealId,
      });

      return NextResponse.json({ ok: true });
    }

    const workspace = await loadWorkspace(db, detail);

    const snapshot = buildSnapshot(workspace.matches, body.productIds, {
      mortgageAmount: num(detail.deal.mortgageAmount) ?? 0,
      propertyValue: num(detail.deal.propertyValue) ?? num(detail.deal.purchasePrice) ?? 0,
      amortizationYears: detail.deal.amortizationYears ?? 25,
    });

    if (snapshot.options.length < 2) {
      return NextResponse.json(
        {
          error:
            'Those products are not in your table any more. Reload the page and pick again.',
        },
        { status: 400 },
      );
    }

    const [saved] = await db
      .insert(scenarios)
      .values({
        dealId,
        name: body.name,
        productIds: body.productIds,
        snapshot,
        createdBy: user.id,
      })
      .returning({ id: scenarios.id });

    await recordAudit(db, {
      actorType: 'broker',
      actorId: user.id,
      action: 'scenario.saved',
      targetType: 'deal',
      targetId: dealId,
      metadata: { name: body.name, products: snapshot.options.length },
    });

    return NextResponse.json({ ok: true, id: saved?.id ?? null });
  });
}
