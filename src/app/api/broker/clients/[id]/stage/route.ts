/**
 * Advance (or correct) a client's pipeline stage.
 *
 * Broker-only, by design — this endpoint is the "manually advance them"
 * requirement. Forward moves are limited to the immediate next stage so a
 * mis-click cannot jump a client from Inquiry to Funded; backward moves are
 * unrestricted so a premature advance is easy to undo.
 */

import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { asBroker } from '@/db';
import { clients, clientStageHistory } from '@/db/schema';
import { recordAudit } from '@/lib/audit';
import { getCurrentUser } from '@/lib/auth/session';
import { sendEmail } from '@/lib/mail/smtp';
import { stageChangeEmail } from '@/lib/mail/templates';
import { canTransition, getStage, isStageKey } from '@/lib/pipeline/stages';

const bodySchema = z.object({
  stageKey: z.string(),
  note: z.string().trim().max(1000).optional(),
  notifyClient: z.boolean().default(true),
});

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user || user.kind !== 'broker') {
    return NextResponse.json({ error: 'Not authorised.' }, { status: 403 });
  }

  const { id: clientId } = await context.params;
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  const { stageKey, note, notifyClient } = parsed.data;

  if (!isStageKey(stageKey)) {
    return NextResponse.json({ error: `Unknown stage "${stageKey}".` }, { status: 400 });
  }

  const outcome = await asBroker(user.id, async (db) => {
    const [client] = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
    if (!client) return { ok: false as const, status: 404, error: 'Client not found.' };

    if (client.stageKey === stageKey) {
      return { ok: false as const, status: 400, error: 'The client is already at that stage.' };
    }

    if (!canTransition(client.stageKey, stageKey)) {
      return {
        ok: false as const,
        status: 400,
        error:
          'You can only move a client forward one stage at a time. Advance through the ' +
          'intermediate stage first.',
      };
    }

    await db
      .update(clients)
      .set({ stageKey, updatedAt: new Date() })
      .where(eq(clients.id, clientId));

    await db.insert(clientStageHistory).values({
      clientId,
      stageKey,
      note: note ?? null,
      advancedBy: user.id,
    });

    await recordAudit(db, {
      actorType: 'broker',
      actorId: user.id,
      action: 'stage.advanced',
      targetType: 'client',
      targetId: clientId,
      clientId,
      metadata: { from: client.stageKey, to: stageKey, note },
    });

    return {
      ok: true as const,
      client: { email: client.email, fullName: client.fullName },
    };
  });

  if (!outcome.ok) {
    return NextResponse.json({ error: outcome.error }, { status: outcome.status });
  }

  let emailSent = false;
  if (notifyClient) {
    const stage = getStage(stageKey);
    const result = await sendEmail(
      outcome.client.email,
      stageChangeEmail({
        fullName: outcome.client.fullName,
        stageLabel: stage.label,
        stageDescription: stage.clientDescription,
        note,
        brokerName: user.fullName,
      }),
    );
    emailSent = result.ok;
  }

  return NextResponse.json({ ok: true, stageKey, emailSent });
}
