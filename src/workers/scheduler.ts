/**
 * Scheduled outbound work: document reminders and renewal mining.
 *
 * Separate from the agent worker because the failure modes are different. An
 * agent run is expensive and idempotent; these send email to real people, and
 * the worst outcome is not a slow tick but a duplicate.
 *
 * Runs on a wide interval and does its own clock check rather than relying on
 * being started at the right moment. Two guards make a restart harmless:
 *
 *   Both passes are idempotent at the database level — reminders bump a
 *   counter and stamp a timestamp, renewals are protected by a unique
 *   constraint on (deal_id, campaign).
 *
 *   Nothing goes out outside business hours. A mortgage document reminder
 *   arriving at 3am reads as a system, not a person, and the whole point of
 *   sending from the broker's own mailbox is that it does not.
 *
 * Run with:  npm run worker:scheduler
 */

import 'dotenv/config';
import { eq } from 'drizzle-orm';

import { asSystem } from '@/db';
import { brokers } from '@/db/schema';
import { attemptDelivery, pendingDeliveries } from '@/lib/api/webhooks';
import { runLifecyclePass } from '@/lib/notify/lifecycle';
import { runReminderPass } from '@/lib/notify/reminders';
import { isSmsConfigured } from '@/lib/notify/sms';

const TICK_MS = 15 * 60 * 1000;

/** Local hours during which outbound mail is allowed. */
const EARLIEST_HOUR = 9;
const LATEST_HOUR = 19;

let shuttingDown = false;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function withinSendingHours(now = new Date()): boolean {
  const day = now.getDay();
  if (day === 0 || day === 6) return false; // Not at the weekend.

  const hour = now.getHours();
  return hour >= EARLIEST_HOUR && hour < LATEST_HOUR;
}

async function primaryBrokerName(): Promise<string> {
  return asSystem(async (db) => {
    const [broker] = await db
      .select({ fullName: brokers.fullName })
      .from(brokers)
      .where(eq(brokers.isActive, true))
      .limit(1);
    return broker?.fullName ?? 'Your mortgage broker';
  });
}

/**
 * Webhooks are drained on EVERY tick, not only during sending hours.
 * They go to machines, not people, and an integration that only receives
 * events between 9 and 7 on weekdays is not an integration.
 */
async function drainWebhooks(): Promise<void> {
  const pending = await asSystem((db) => pendingDeliveries(db));
  if (pending.length === 0) return;

  let delivered = 0;
  for (const delivery of pending) {
    const outcome = await asSystem((db) => attemptDelivery(db, delivery));
    if (outcome.ok) delivered += 1;
    else if (!outcome.willRetry) {
      console.error('[scheduler] webhook gave up', outcome);
    }
  }

  console.info('[scheduler] webhooks', { attempted: pending.length, delivered });
}

async function tick(): Promise<void> {
  const now = new Date();

  await drainWebhooks();

  if (!withinSendingHours(now)) return;

  const brokerName = await primaryBrokerName();

  const reminders = await asSystem((db) => runReminderPass(db, brokerName, now));
  if (reminders.length > 0) {
    const sent = reminders.filter((outcome) => outcome.ok).length;
    console.info('[scheduler] document reminders', {
      attempted: reminders.length,
      sent,
      failed: reminders.length - sent,
      bySms: reminders.filter((outcome) => outcome.channel === 'sms').length,
    });

    for (const failure of reminders.filter((outcome) => !outcome.ok)) {
      console.error('[scheduler] reminder failed', failure);
    }
  }

  const renewals = await asSystem((db) => runLifecyclePass(db, brokerName, now));
  if (renewals.length > 0) {
    const sent = renewals.filter((outcome) => outcome.ok).length;
    console.info('[scheduler] renewal outreach', {
      attempted: renewals.length,
      sent,
      failed: renewals.length - sent,
    });
  }
}

async function main(): Promise<void> {
  console.info('[scheduler] started', {
    tickMinutes: TICK_MS / 60_000,
    sendingHours: `${EARLIEST_HOUR}:00–${LATEST_HOUR}:00 weekdays`,
    sms: isSmsConfigured() ? 'configured' : 'not configured — reminders fall back to email',
  });

  while (!shuttingDown) {
    try {
      await tick();
    } catch (error) {
      console.error('[scheduler] tick failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Interruptible sleep so shutdown does not wait out a full tick.
    for (let waited = 0; waited < TICK_MS && !shuttingDown; waited += 1000) {
      await sleep(1000);
    }
  }

  console.info('[scheduler] stopped');
  process.exit(0);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.info(`[scheduler] ${signal} received, finishing current tick`);
    shuttingDown = true;
  });
}

main().catch((error) => {
  console.error('[scheduler] fatal', error);
  process.exit(1);
});
