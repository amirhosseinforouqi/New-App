/**
 * Review a document: approve it, or send it back.
 *
 * Approving also closes the linked checklist item. Sending it back sets a note
 * the client sees on their own dashboard — a rejection without a reason just
 * produces a phone call.
 */

import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { asBroker } from '@/db';
import { clients, documentRequests, documents } from '@/db/schema';
import { recordAudit } from '@/lib/audit';
import { getCurrentUser } from '@/lib/auth/session';
import { sendEmail } from '@/lib/mail/smtp';
import { documentsRequestedEmail } from '@/lib/mail/templates';

const bodySchema = z
  .object({
    status: z.enum(['approved', 'needs_attention', 'in_review']),
    reviewNote: z.string().trim().max(1000).optional(),
    notifyClient: z.boolean().default(false),
  })
  .refine((value) => value.status !== 'needs_attention' || Boolean(value.reviewNote), {
    message: 'Tell the client what is wrong with the document.',
    path: ['reviewNote'],
  });

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user || user.kind !== 'broker') {
    return NextResponse.json({ error: 'Not authorised.' }, { status: 403 });
  }

  const { id: documentId } = await context.params;
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid request.' },
      { status: 400 },
    );
  }

  const { status, reviewNote, notifyClient } = parsed.data;

  const outcome = await asBroker(user.id, async (db) => {
    const [document] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, documentId))
      .limit(1);

    if (!document) return { ok: false as const, error: 'Document not found.' };

    await db
      .update(documents)
      .set({
        status,
        reviewNote: reviewNote ?? null,
        reviewedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(documents.id, documentId));

    // Keep the checklist item in step with the document that satisfies it.
    if (document.requestId) {
      await db
        .update(documentRequests)
        .set({
          status: status === 'approved' ? 'approved' : status,
          reviewNote: reviewNote ?? null,
          updatedAt: new Date(),
        })
        .where(eq(documentRequests.id, document.requestId));
    }

    await recordAudit(db, {
      actorType: 'broker',
      actorId: user.id,
      action: 'document.reviewed',
      targetType: 'document',
      targetId: documentId,
      clientId: document.clientId,
      metadata: { status, reviewNote },
    });

    const [client] = await db
      .select({ email: clients.email, fullName: clients.fullName })
      .from(clients)
      .where(eq(clients.id, document.clientId))
      .limit(1);

    return { ok: true as const, client, fileName: document.fileName };
  });

  if (!outcome.ok) {
    return NextResponse.json({ error: outcome.error }, { status: 404 });
  }

  if (notifyClient && status === 'needs_attention' && outcome.client && reviewNote) {
    await sendEmail(
      outcome.client.email,
      documentsRequestedEmail({
        fullName: outcome.client.fullName,
        items: [`${outcome.fileName} — ${reviewNote}`],
        brokerName: user.fullName,
      }),
    );
  }

  return NextResponse.json({ ok: true, status });
}
