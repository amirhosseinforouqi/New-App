/**
 * Automated document reminders.
 *
 * The cadence is deliberately gentle and finite: three days after the due date,
 * then a week, then a fortnight, then stop. A system that nags indefinitely
 * gets muted, and a muted channel is worse than none because the broker
 * believes it is working.
 *
 * Every send is recorded in `reminder_log` before the next one can be
 * scheduled. That log is doing three jobs: it stops a client being emailed six
 * times because a worker restarted mid-run, it is the evidence when someone
 * says nobody told them, and it lets the broker see the chase history without
 * asking.
 *
 * SMS is attempted first when a mobile number exists and Twilio is configured,
 * because a text is read and an email is not. It falls back to email rather
 * than failing, and it never reports success for a channel that did not send.
 */

import { and, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';

import type { Db } from '@/db';
import { clients, documentRequests, reminderLog } from '@/db/schema';
import { env } from '@/lib/env';
import { sendEmail } from '@/lib/mail/smtp';
import { documentReminderEmail } from '@/lib/mail/templates';
import { documentReminderSms, isSmsConfigured, sendSms, toE164 } from '@/lib/notify/sms';

/** Days after the due date at which each reminder goes out. */
export const REMINDER_SCHEDULE_DAYS = [3, 10, 24] as const;
export const MAX_REMINDERS = REMINDER_SCHEDULE_DAYS.length;

export interface DueReminder {
  clientId: string;
  clientName: string;
  email: string;
  phone: string | null;
  dealId: string | null;
  requestIds: string[];
  labels: string[];
  reminderCount: number;
}

/**
 * Which clients are due a reminder right now.
 *
 * Grouped per client rather than per document on purpose: three outstanding
 * items is one message listing three things, not three messages. The opposite
 * is how a portal teaches people to ignore it.
 */
export async function findDueReminders(db: Db, now = new Date()): Promise<DueReminder[]> {
  const rows = await db
    .select({
      requestId: documentRequests.id,
      clientId: documentRequests.clientId,
      dealId: documentRequests.dealId,
      label: documentRequests.label,
      dueAt: documentRequests.dueAt,
      reminderCount: documentRequests.reminderCount,
      lastReminderAt: documentRequests.lastReminderAt,
      clientName: clients.fullName,
      email: clients.email,
      phone: clients.phone,
      status: clients.status,
    })
    .from(documentRequests)
    .innerJoin(clients, eq(clients.id, documentRequests.clientId))
    .where(
      and(
        eq(documentRequests.remindersEnabled, true),
        inArray(documentRequests.status, ['requested', 'needs_attention']),
        sql`${documentRequests.dueAt} IS NOT NULL`,
        lte(documentRequests.dueAt, now),
        sql`${documentRequests.reminderCount} < ${MAX_REMINDERS}`,
        // A suspended or archived client is not chased.
        inArray(clients.status, ['invited', 'active']),
      ),
    );

  const due = new Map<string, DueReminder>();

  for (const row of rows) {
    if (!row.dueAt) continue;

    const daysOverdue = Math.floor((now.getTime() - row.dueAt.getTime()) / 86_400_000);
    const threshold = REMINDER_SCHEDULE_DAYS[row.reminderCount];
    if (threshold === undefined || daysOverdue < threshold) continue;

    // Never twice in the same day, whatever the schedule says.
    if (row.lastReminderAt && now.getTime() - row.lastReminderAt.getTime() < 20 * 3_600_000) {
      continue;
    }

    const entry = due.get(row.clientId) ?? {
      clientId: row.clientId,
      clientName: row.clientName,
      email: row.email,
      phone: row.phone,
      dealId: row.dealId,
      requestIds: [],
      labels: [],
      reminderCount: row.reminderCount,
    };

    entry.requestIds.push(row.requestId);
    entry.labels.push(row.label);
    // The message's tone follows the least-chased item in the group.
    entry.reminderCount = Math.min(entry.reminderCount, row.reminderCount);
    due.set(row.clientId, entry);
  }

  return [...due.values()];
}

export interface ReminderOutcome {
  clientId: string;
  channel: 'email' | 'sms' | 'none';
  ok: boolean;
  error?: string;
}

const firstName = (fullName: string) => fullName.trim().split(/\s+/)[0] ?? fullName;

/**
 * Send one client's reminder and record it.
 *
 * The counter is bumped whether or not delivery succeeded. That is deliberate:
 * a permanently bouncing address must not be retried forever, and the failure
 * is visible in `reminder_log` for the broker to act on.
 */
export async function sendReminder(
  db: Db,
  reminder: DueReminder,
  brokerName: string,
): Promise<ReminderOutcome> {
  const portalUrl = `${env.appUrl}/dashboard`;
  const attempt = reminder.reminderCount + 1;

  let channel: 'email' | 'sms' = 'email';
  let ok = false;
  let error: string | undefined;
  let subject: string | undefined;
  let body: string;
  let destination = reminder.email;

  const mobile = toE164(reminder.phone);

  if (mobile && isSmsConfigured()) {
    body = documentReminderSms({
      firstName: firstName(reminder.clientName),
      outstandingCount: reminder.labels.length,
      brokerName,
      portalUrl,
    });

    const result = await sendSms(mobile, body);

    if (result.ok) {
      channel = 'sms';
      destination = mobile;
      ok = true;
    } else {
      // Fall through to email. The SMS failure is still logged below via the
      // email attempt's own row, and the reason is carried in `error`.
      error = `SMS failed (${result.reason ?? 'unknown'}); fell back to email.`;
    }
  }

  if (!ok) {
    const message = documentReminderEmail({
      fullName: reminder.clientName,
      labels: reminder.labels,
      attempt,
      brokerName,
      portalUrl,
    });

    subject = message.subject;
    body = message.text;
    destination = reminder.email;

    const result = await sendEmail(reminder.email, message);
    ok = result.ok;
    if (!result.ok) error = [error, result.error].filter(Boolean).join(' ');
  } else {
    body = documentReminderSms({
      firstName: firstName(reminder.clientName),
      outstandingCount: reminder.labels.length,
      brokerName,
      portalUrl,
    });
  }

  await db.insert(reminderLog).values({
    clientId: reminder.clientId,
    dealId: reminder.dealId,
    channel,
    destination,
    subject: subject ?? null,
    body,
    requestIds: reminder.requestIds,
    succeeded: ok,
    error: error ?? null,
  });

  await db
    .update(documentRequests)
    .set({
      reminderCount: sql`${documentRequests.reminderCount} + 1`,
      lastReminderAt: new Date(),
    })
    .where(inArray(documentRequests.id, reminder.requestIds));

  return { clientId: reminder.clientId, channel, ok, error };
}

/** One pass. Returns what it did, for the worker to log. */
export async function runReminderPass(
  db: Db,
  brokerName: string,
  now = new Date(),
): Promise<ReminderOutcome[]> {
  const due = await findDueReminders(db, now);
  const outcomes: ReminderOutcome[] = [];

  for (const reminder of due) {
    try {
      outcomes.push(await sendReminder(db, reminder, brokerName));
    } catch (error) {
      outcomes.push({
        clientId: reminder.clientId,
        channel: 'none',
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return outcomes;
}

/**
 * Give a checklist item a due date.
 *
 * Default of seven business-ish days: long enough that a client with a job can
 * find a document, short enough that the file keeps moving.
 */
export function defaultDueDate(from = new Date(), days = 7): Date {
  const due = new Date(from);
  due.setDate(due.getDate() + days);
  due.setHours(17, 0, 0, 0);
  return due;
}

/** Outstanding items with no due date — the broker cannot chase what has none. */
export async function requestsWithoutDueDate(db: Db, dealId: string) {
  return db
    .select({ id: documentRequests.id, label: documentRequests.label })
    .from(documentRequests)
    .where(
      and(
        eq(documentRequests.dealId, dealId),
        isNull(documentRequests.dueAt),
        or(
          eq(documentRequests.status, 'requested'),
          eq(documentRequests.status, 'needs_attention'),
        ),
      ),
    );
}
