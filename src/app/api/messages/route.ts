/**
 * Post a message to a client's thread.
 *
 * Both clients and brokers use this endpoint. Authorization is layered:
 *   - The route checks the session and rejects a client posting to another
 *     client's thread outright.
 *   - RLS enforces the same rule at the database, including `sender_type`, so
 *     a client cannot forge a message that appears to come from the broker
 *     even if this handler had a bug.
 */

import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { asBroker, asClient, asSystem } from '@/db';
import { clients, messages } from '@/db/schema';
import { recordAudit } from '@/lib/audit';
import { resolveDealForClient } from '@/lib/deals/active';
import { getCurrentUser } from '@/lib/auth/session';
import { messageChannel, publish } from '@/lib/events';
import { sendEmail } from '@/lib/mail/smtp';
import { newMessageEmail } from '@/lib/mail/templates';

const bodySchema = z.object({
  clientId: z.string().uuid(),
  body: z.string().trim().min(1, 'Write something first.').max(5000),
});

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: 'Not signed in.' }, { status: 401 });

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid message.' },
      { status: 400 },
    );
  }

  const { clientId, body } = parsed.data;

  if (user.kind === 'client' && user.id !== clientId) {
    return NextResponse.json({ error: 'Not found.' }, { status: 404 });
  }

  const inserted =
    user.kind === 'client'
      ? await asClient(user.id, async (db) => {
          const [row] = await db
            .insert(messages)
            .values({
              clientId,
              dealId: await resolveDealForClient(db, clientId),
              senderType: 'client',
              senderId: user.id,
              body,
            })
            .returning();
          return row;
        })
      : await asBroker(user.id, async (db) => {
          const [row] = await db
            .insert(messages)
            .values({
              clientId,
              dealId: await resolveDealForClient(db, clientId),
              senderType: 'broker',
              senderId: user.id,
              body,
            })
            .returning();

          await recordAudit(db, {
            actorType: 'broker',
            actorId: user.id,
            action: 'message.sent',
            clientId,
            targetType: 'message',
            targetId: row?.id ?? null,
          });

          return row;
        });

  if (!inserted) {
    return NextResponse.json({ error: 'Message could not be saved.' }, { status: 500 });
  }

  const payload = {
    id: inserted.id,
    senderType: inserted.senderType,
    body: inserted.body,
    createdAt: inserted.createdAt.toISOString(),
  };

  publish(messageChannel(clientId), payload);

  // Notify the client by email when the broker writes. Not the other way
  // round: the broker is looking at the portal, and an email per client
  // message would be noise.
  if (user.kind === 'broker') {
    void (async () => {
      try {
        const client = await asSystem(async (db) => {
          const [row] = await db
            .select({ email: clients.email, fullName: clients.fullName })
            .from(clients)
            .where(eq(clients.id, clientId))
            .limit(1);
          return row;
        });

        if (client) {
          await sendEmail(
            client.email,
            newMessageEmail({
              fullName: client.fullName,
              preview: body.length > 180 ? `${body.slice(0, 180)}…` : body,
              brokerName: user.fullName,
            }),
          );
        }
      } catch (error) {
        console.error('[messages] notification email failed', error);
      }
    })();
  }

  return NextResponse.json({ message: payload });
}
