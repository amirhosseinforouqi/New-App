/**
 * Outbound webhooks — the Zapier / Salesforce / Pipedrive seam.
 *
 * Every delivery is signed. The receiver computes HMAC-SHA256 over
 * `{timestamp}.{body}` with the shared secret and compares it to the
 * `X-UWA-Signature` header. Two properties that matter and are usually got
 * wrong:
 *
 *   The timestamp is inside the signed payload, not merely a separate header.
 *   Signing the body alone lets an attacker who captures one delivery replay it
 *   forever; with the timestamp signed, the receiver can reject anything older
 *   than a few minutes and the signature cannot be reused.
 *
 *   Deliveries are recorded before they are attempted. A webhook that fired but
 *   whose row was never written is a webhook nobody can debug.
 *
 * Delivery is at-least-once with bounded retry. Receivers must be idempotent,
 * which is why every payload carries a stable `id`.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, isNull, lt, sql } from 'drizzle-orm';

import type { Db } from '@/db';
import { webhookDeliveries, webhooks } from '@/db/schema';

export const WEBHOOK_EVENTS = [
  'application.submitted',
  'client.created',
  'deal.created',
  'deal.stage_changed',
  'deal.funded',
  'document.uploaded',
  'document.approved',
  'message.received',
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

const MAX_ATTEMPTS = 5;
const TIMEOUT_MS = 10_000;

export function generateWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString('base64url')}`;
}

/** `t=<unix seconds>,v1=<hex hmac>` — the shape most receivers already parse. */
export function signPayload(secret: string, body: string, timestamp: number): string {
  const signature = createHmac('sha256', secret)
    .update(`${timestamp}.${body}`)
    .digest('hex');

  return `t=${timestamp},v1=${signature}`;
}

/**
 * Verify a signature. Exported so the docs can point at a real implementation
 * and so it can be tested — a signing scheme nobody has verified is a guess.
 */
export function verifySignature(
  secret: string,
  body: string,
  header: string,
  toleranceSeconds = 300,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  const parts = Object.fromEntries(
    header.split(',').map((part) => {
      const [key, ...rest] = part.split('=');
      return [key?.trim() ?? '', rest.join('=').trim()];
    }),
  );

  const timestamp = Number(parts.t);
  const provided = parts.v1;
  if (!Number.isFinite(timestamp) || !provided) return false;

  if (Math.abs(nowSeconds - timestamp) > toleranceSeconds) return false;

  const expected = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');

  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Queue an event for every subscribed endpoint.
 *
 * Queued, not sent: this is called from request handlers, and an outbound HTTP
 * call to someone else's server has no business holding a borrower's upload
 * open. The worker drains the queue.
 */
export async function emitEvent(
  db: Db,
  event: WebhookEvent,
  payload: Record<string, unknown>,
): Promise<number> {
  const subscribers = await db
    .select({ id: webhooks.id, events: webhooks.events })
    .from(webhooks)
    .where(eq(webhooks.isActive, true));

  const matching = subscribers.filter(
    (hook) => hook.events.length === 0 || hook.events.includes(event),
  );

  for (const hook of matching) {
    await db.insert(webhookDeliveries).values({
      webhookId: hook.id,
      event,
      payload: { id: crypto.randomUUID(), event, createdAt: new Date().toISOString(), data: payload },
    });
  }

  return matching.length;
}

export interface DeliveryOutcome {
  deliveryId: string;
  ok: boolean;
  statusCode?: number;
  error?: string;
  willRetry: boolean;
}

/** Deliver one queued row. */
export async function attemptDelivery(
  db: Db,
  delivery: { id: string; webhookId: string; payload: unknown; attempts: number },
): Promise<DeliveryOutcome> {
  const [hook] = await db
    .select({ url: webhooks.url, secret: webhooks.secret, isActive: webhooks.isActive })
    .from(webhooks)
    .where(eq(webhooks.id, delivery.webhookId))
    .limit(1);

  if (!hook || !hook.isActive) {
    // The endpoint was deleted or disabled after queueing. Mark it done rather
    // than retrying forever against nothing.
    await db
      .update(webhookDeliveries)
      .set({ deliveredAt: new Date(), error: 'endpoint removed or disabled' })
      .where(eq(webhookDeliveries.id, delivery.id));

    return { deliveryId: delivery.id, ok: false, error: 'endpoint gone', willRetry: false };
  }

  const body = JSON.stringify(delivery.payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const attempts = delivery.attempts + 1;

  try {
    const response = await fetch(hook.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-UWA-Signature': signPayload(hook.secret, body, timestamp),
        'X-UWA-Event': String((delivery.payload as { event?: string }).event ?? ''),
        'User-Agent': 'UWA-Webhooks/1.0',
      },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    const ok = response.ok;
    const exhausted = attempts >= MAX_ATTEMPTS;

    await db
      .update(webhookDeliveries)
      .set({
        attempts,
        statusCode: response.status,
        // Only stamp delivered on success or when giving up, so the worker's
        // "pending" query keeps returning it until one of those happens.
        deliveredAt: ok || exhausted ? new Date() : null,
        error: ok ? null : `HTTP ${response.status}`,
      })
      .where(eq(webhookDeliveries.id, delivery.id));

    return {
      deliveryId: delivery.id,
      ok,
      statusCode: response.status,
      willRetry: !ok && !exhausted,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const exhausted = attempts >= MAX_ATTEMPTS;

    await db
      .update(webhookDeliveries)
      .set({
        attempts,
        error: message.slice(0, 500),
        deliveredAt: exhausted ? new Date() : null,
      })
      .where(eq(webhookDeliveries.id, delivery.id));

    return { deliveryId: delivery.id, ok: false, error: message, willRetry: !exhausted };
  }
}

/**
 * Pending deliveries, oldest first, with exponential backoff.
 *
 * Backoff is expressed in SQL against `created_at` and the attempt count rather
 * than held in memory, so it survives a worker restart.
 */
export async function pendingDeliveries(db: Db, limit = 20) {
  return db
    .select({
      id: webhookDeliveries.id,
      webhookId: webhookDeliveries.webhookId,
      payload: webhookDeliveries.payload,
      attempts: webhookDeliveries.attempts,
    })
    .from(webhookDeliveries)
    .where(
      and(
        isNull(webhookDeliveries.deliveredAt),
        lt(webhookDeliveries.attempts, MAX_ATTEMPTS),
        // 1st retry after ~1 min, then 2, 4, 8 — 2^attempts minutes.
        sql`${webhookDeliveries.createdAt} < now() - (power(2, ${webhookDeliveries.attempts}) * interval '1 minute')`,
      ),
    )
    .orderBy(webhookDeliveries.createdAt)
    .limit(limit);
}
