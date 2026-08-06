/**
 * Add checklist items for a client.
 *
 * Used for conditions that appear mid-file — an underwriter asking for a gift
 * letter after conditional approval, for example. Accepts a batch so the
 * broker can paste a lender's condition list in one go.
 */

import { NextResponse } from 'next/server';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';

import { asBroker } from '@/db';
import { clients, documentRequests } from '@/db/schema';
import { recordAudit } from '@/lib/audit';
import { getCurrentUser } from '@/lib/auth/session';
import { sendEmail } from '@/lib/mail/smtp';
import { documentsRequestedEmail } from '@/lib/mail/templates';

const bodySchema = z.object({
  clientId: z.string().uuid(),
  items: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(200),
        description: z.string().trim().max(1000).optional(),
        category: z
          .enum(['identity', 'income', 'employment', 'assets', 'property', 'liabilities', 'other'])
          .default('other'),
        isRequired: z.boolean().default(true),
      }),
    )
    .min(1, 'Add at least one item.')
    .max(50),
  notifyClient: z.boolean().default(true),
});

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user || user.kind !== 'broker') {
    return NextResponse.json({ error: 'Not authorised.' }, { status: 403 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid request.' },
      { status: 400 },
    );
  }

  const { clientId, items, notifyClient } = parsed.data;

  const outcome = await asBroker(user.id, async (db) => {
    const [client] = await db
      .select({ email: clients.email, fullName: clients.fullName })
      .from(clients)
      .where(eq(clients.id, clientId))
      .limit(1);

    if (!client) return { ok: false as const, error: 'Client not found.' };

    // Continue the existing ordering rather than restarting at zero, so newly
    // added conditions land at the bottom of the client's list.
    const [last] = await db
      .select({ sortOrder: documentRequests.sortOrder })
      .from(documentRequests)
      .where(eq(documentRequests.clientId, clientId))
      .orderBy(desc(documentRequests.sortOrder))
      .limit(1);

    const base = (last?.sortOrder ?? -1) + 1;

    await db.insert(documentRequests).values(
      items.map((item, index) => ({
        clientId,
        label: item.label,
        description: item.description ?? null,
        category: item.category,
        isRequired: item.isRequired,
        createdBy: 'broker' as const,
        sortOrder: base + index,
      })),
    );

    await recordAudit(db, {
      actorType: 'broker',
      actorId: user.id,
      action: 'request.created',
      targetType: 'client',
      targetId: clientId,
      clientId,
      metadata: { count: items.length, labels: items.map((item) => item.label) },
    });

    return { ok: true as const, client };
  });

  if (!outcome.ok) {
    return NextResponse.json({ error: outcome.error }, { status: 404 });
  }

  let emailSent = false;
  if (notifyClient) {
    const result = await sendEmail(
      outcome.client.email,
      documentsRequestedEmail({
        fullName: outcome.client.fullName,
        items: items.map((item) => item.label),
        brokerName: user.fullName,
      }),
    );
    emailSent = result.ok;
  }

  return NextResponse.json({ ok: true, added: items.length, emailSent });
}
