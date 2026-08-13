/**
 * Managing API keys and webhook endpoints.
 *
 * Owner-only. An assistant chasing documents has no business minting a
 * brokerage-wide key that can read every file, and role checks that live only
 * in the UI are decoration.
 */

import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { asBroker, asSystem } from '@/db';
import { brokers, webhooks } from '@/db/schema';
import { recordAudit } from '@/lib/audit';
import { getCurrentUser } from '@/lib/auth/session';
import { issueApiKey, revokeApiKey } from '@/lib/api/keys';
import { generateWebhookSecret, WEBHOOK_EVENTS } from '@/lib/api/webhooks';

const bodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('create_key'),
    name: z.string().trim().min(1).max(80),
    scopes: z.array(z.enum(['read', 'write'])).min(1),
  }),
  z.object({ action: z.literal('revoke_key'), keyId: z.string().uuid() }),
  z.object({
    action: z.literal('create_webhook'),
    url: z.string().url().refine((value) => value.startsWith('https://'), {
      message: 'Webhook URLs must be https — we sign payloads but do not encrypt them.',
    }),
    events: z.array(z.enum(WEBHOOK_EVENTS)).default([]),
  }),
  z.object({ action: z.literal('delete_webhook'), webhookId: z.string().uuid() }),
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
      { error: 'Only the brokerage owner can manage integrations.' },
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

  return asBroker(user.id, async (db) => {
    switch (body.action) {
      case 'create_key': {
        const issued = await issueApiKey(db, {
          brokerId: user.id,
          name: body.name,
          scopes: body.scopes,
        });

        await recordAudit(db, {
          actorType: 'broker',
          actorId: user.id,
          action: 'api_key.created',
          targetType: 'api_key',
          targetId: issued.id,
          metadata: { name: body.name, scopes: body.scopes },
        });

        // The only time the plaintext exists outside the caller's hands.
        return NextResponse.json({ ok: true, key: issued.key, prefix: issued.prefix });
      }

      case 'revoke_key': {
        await revokeApiKey(db, body.keyId);
        await recordAudit(db, {
          actorType: 'broker',
          actorId: user.id,
          action: 'api_key.revoked',
          targetType: 'api_key',
          targetId: body.keyId,
        });
        return NextResponse.json({ ok: true });
      }

      case 'create_webhook': {
        const secret = generateWebhookSecret();

        const [row] = await db
          .insert(webhooks)
          .values({ brokerId: user.id, url: body.url, events: body.events, secret })
          .returning({ id: webhooks.id });

        await recordAudit(db, {
          actorType: 'broker',
          actorId: user.id,
          action: 'webhook.created',
          targetType: 'webhook',
          targetId: row?.id ?? null,
          metadata: { url: body.url, events: body.events },
        });

        // Shown once, like the key — the receiver needs it to verify signatures.
        return NextResponse.json({ ok: true, id: row?.id, secret });
      }

      case 'delete_webhook': {
        await db.delete(webhooks).where(eq(webhooks.id, body.webhookId));
        await recordAudit(db, {
          actorType: 'broker',
          actorId: user.id,
          action: 'webhook.deleted',
          targetType: 'webhook',
          targetId: body.webhookId,
        });
        return NextResponse.json({ ok: true });
      }
    }
  });
}
