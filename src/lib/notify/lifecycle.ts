/**
 * Renewal and refinance mining.
 *
 * The single highest-value thing a brokerage's own database can do: a client
 * whose mortgage matures in four months is worth more than a cold lead, and
 * they are already in `deals.maturity_date` from the intake form.
 *
 * The rules that keep this from becoming spam:
 *
 *   One touch per campaign per deal, enforced by a unique constraint on
 *   `lifecycle_touches` rather than by remembering in code. A borrower emailed
 *   twice about the same renewal unsubscribes.
 *
 *   A deal already active in the pipeline is skipped. Nothing is more
 *   embarrassing than an automated "have you thought about renewing?" to
 *   someone mid-way through renewing with you.
 *
 *   Windows are wide and few: six months out, then ninety days, then the month
 *   after maturity for anyone who let it lapse.
 */

import { and, eq, gte, inArray, lte, sql } from 'drizzle-orm';

import type { Db } from '@/db';
import { clients, dealBorrowers, deals, lifecycleTouches } from '@/db/schema';
import { sendEmail } from '@/lib/mail/smtp';
import { renewalOutreachEmail } from '@/lib/mail/templates';

export type Campaign = 'renewal_180' | 'renewal_90' | 'renewal_lapsed';

interface Window {
  campaign: Campaign;
  minDays: number;
  maxDays: number;
}

/**
 * Non-overlapping so a deal cannot qualify for two at once. The lapsed window
 * stops at −45 days: past that, an untouched renewal is a phone call, not
 * another email.
 */
const WINDOWS: Window[] = [
  { campaign: 'renewal_180', minDays: 150, maxDays: 195 },
  { campaign: 'renewal_90', minDays: 75, maxDays: 105 },
  { campaign: 'renewal_lapsed', minDays: -45, maxDays: -1 },
];

export interface RenewalCandidate {
  dealId: string;
  clientId: string;
  fullName: string;
  email: string;
  reference: string;
  maturityDate: string;
  daysAway: number;
  campaign: Campaign;
}

const isoDate = (date: Date) => date.toISOString().slice(0, 10);

export async function findRenewalCandidates(
  db: Db,
  now = new Date(),
): Promise<RenewalCandidate[]> {
  const candidates: RenewalCandidate[] = [];

  for (const window of WINDOWS) {
    const from = new Date(now);
    from.setDate(from.getDate() + window.minDays);
    const to = new Date(now);
    to.setDate(to.getDate() + window.maxDays);

    const rows = await db
      .select({
        dealId: deals.id,
        clientId: deals.clientId,
        reference: deals.reference,
        maturityDate: deals.maturityDate,
        fullName: clients.fullName,
        email: clients.email,
        status: clients.status,
      })
      .from(deals)
      .innerJoin(clients, eq(clients.id, deals.clientId))
      .where(
        and(
          sql`${deals.maturityDate} IS NOT NULL`,
          gte(deals.maturityDate, isoDate(from)),
          lte(deals.maturityDate, isoDate(to)),
          // Funded or archived only: a deal still working through the pipeline
          // is being handled by a human right now.
          inArray(deals.status, ['funded', 'archived']),
          inArray(clients.status, ['invited', 'active']),
          // The unique constraint would catch this too; filtering here avoids
          // sending the email and then failing to record it.
          sql`NOT EXISTS (
            SELECT 1 FROM ${lifecycleTouches} t
             WHERE t.deal_id = deals.id AND t.campaign = ${window.campaign}
          )`,
        ),
      );

    for (const row of rows) {
      if (!row.maturityDate) continue;

      const daysAway = Math.round(
        (new Date(row.maturityDate).getTime() - now.getTime()) / 86_400_000,
      );

      candidates.push({
        dealId: row.dealId,
        clientId: row.clientId,
        fullName: row.fullName,
        email: row.email,
        reference: row.reference,
        maturityDate: row.maturityDate,
        daysAway,
        campaign: window.campaign,
      });
    }
  }

  return candidates;
}

export interface TouchOutcome {
  dealId: string;
  campaign: Campaign;
  ok: boolean;
  error?: string;
}

export async function sendRenewalOutreach(
  db: Db,
  candidate: RenewalCandidate,
  brokerName: string,
): Promise<TouchOutcome> {
  const readable = new Date(candidate.maturityDate).toLocaleDateString('en-CA', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const result = await sendEmail(
    candidate.email,
    renewalOutreachEmail({
      fullName: candidate.fullName,
      maturityDate: readable,
      daysAway: candidate.daysAway,
      brokerName,
    }),
  );

  // Recorded whether or not it sent. A bouncing address must not be retried on
  // every pass, and the failure is visible for the broker to act on.
  await db
    .insert(lifecycleTouches)
    .values({
      clientId: candidate.clientId,
      dealId: candidate.dealId,
      campaign: candidate.campaign,
      channel: 'email',
      succeeded: result.ok,
      detail: result.ok ? null : (result.error ?? 'send failed'),
    })
    .onConflictDoNothing();

  return { dealId: candidate.dealId, campaign: candidate.campaign, ok: result.ok, error: result.error };
}

export async function runLifecyclePass(
  db: Db,
  brokerName: string,
  now = new Date(),
): Promise<TouchOutcome[]> {
  const candidates = await findRenewalCandidates(db, now);
  const outcomes: TouchOutcome[] = [];

  for (const candidate of candidates) {
    try {
      outcomes.push(await sendRenewalOutreach(db, candidate, brokerName));
    } catch (error) {
      outcomes.push({
        dealId: candidate.dealId,
        campaign: candidate.campaign,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return outcomes;
}

/** Maturities coming up, for the broker's own dashboard. */
export async function upcomingMaturities(db: Db, withinDays = 365) {
  const to = new Date();
  to.setDate(to.getDate() + withinDays);

  return db
    .select({
      dealId: deals.id,
      reference: deals.reference,
      maturityDate: deals.maturityDate,
      existingLender: deals.existingLender,
      existingBalance: deals.existingBalance,
      clientId: deals.clientId,
      fullName: clients.fullName,
      email: clients.email,
    })
    .from(deals)
    .innerJoin(clients, eq(clients.id, deals.clientId))
    .where(
      and(
        sql`${deals.maturityDate} IS NOT NULL`,
        lte(deals.maturityDate, isoDate(to)),
        inArray(clients.status, ['invited', 'active']),
      ),
    )
    .orderBy(deals.maturityDate);
}

/** Everyone on a deal, for outreach that should reach co-borrowers too. */
export async function borrowersOnDeal(db: Db, dealId: string) {
  return db
    .select({ clientId: clients.id, fullName: clients.fullName, email: clients.email })
    .from(dealBorrowers)
    .innerJoin(clients, eq(clients.id, dealBorrowers.clientId))
    .where(eq(dealBorrowers.dealId, dealId));
}
