/**
 * Brokerage-level reporting: team, commissions and lead attribution.
 *
 * Kept out of the pages so the numbers are computed in one place. Every figure
 * here is derived from the deals table rather than stored, so a corrected deal
 * corrects the report without anyone remembering to re-run anything.
 */

import { and, desc, eq, gte, isNotNull, sql } from 'drizzle-orm';

import type { Db } from '@/db';
import {
  applications,
  brokers,
  commissionSplits,
  dealCommissions,
  deals,
  referralSources,
} from '@/db/schema';
import { summariseByPayee } from '@/lib/commissions/calculate';

export interface TeamMemberRow {
  id: string;
  fullName: string;
  email: string;
  role: string;
  isActive: boolean;
  commissionSplitPercent: number;
  lastLoginAt: Date | null;
  inviteAcceptedAt: Date | null;
  activeDeals: number;
  fundedDeals: number;
  fundedVolume: number;
}

export async function listTeam(db: Db): Promise<TeamMemberRow[]> {
  // `brokers.id` is written literally, not as `${brokers.id}` — see the note in
  // `src/lib/deals/queries.ts`. Interpolated, it renders unqualified and binds
  // to the subquery's own table, and every count returns 0 without erroring.
  const rows = await db
    .select({
      id: brokers.id,
      fullName: brokers.fullName,
      email: brokers.email,
      role: brokers.role,
      isActive: brokers.isActive,
      commissionSplitPercent: brokers.commissionSplitPercent,
      lastLoginAt: brokers.lastLoginAt,
      inviteAcceptedAt: brokers.inviteAcceptedAt,
      activeDeals: sql<number>`(
        SELECT count(*)::int FROM ${deals} d
         WHERE d.assigned_to = brokers.id AND d.status = 'active'
      )`,
      fundedDeals: sql<number>`(
        SELECT count(*)::int FROM ${deals} d
         WHERE d.assigned_to = brokers.id AND d.status = 'funded'
      )`,
      fundedVolume: sql<string>`(
        SELECT COALESCE(sum(d.mortgage_amount), 0)::text FROM ${deals} d
         WHERE d.assigned_to = brokers.id AND d.status = 'funded'
      )`,
    })
    .from(brokers)
    .orderBy(brokers.fullName);

  return rows.map((row) => ({
    ...row,
    commissionSplitPercent: Number(row.commissionSplitPercent),
    fundedVolume: Number(row.fundedVolume),
  }));
}

/** Commission roll-up by payee, across every funded deal. */
export async function commissionSummary(db: Db) {
  const rows = await db
    .select({
      brokerId: commissionSplits.brokerId,
      payeeName: commissionSplits.payeeName,
      amount: commissionSplits.amount,
      status: dealCommissions.status,
      fundedAmount: dealCommissions.fundedAmount,
    })
    .from(commissionSplits)
    .innerJoin(dealCommissions, eq(dealCommissions.id, commissionSplits.commissionId));

  return summariseByPayee(
    rows.map((row) => ({
      brokerId: row.brokerId,
      payeeName: row.payeeName,
      amount: Number(row.amount),
      status: row.status,
      fundedAmount: Number(row.fundedAmount),
    })),
  );
}

export interface AttributionRow {
  source: string;
  code: string | null;
  label: string | null;
  leads: number;
  funded: number;
  volume: number;
  conversionPercent: number;
}

/**
 * Where the business came from.
 *
 * Grouped by referral code where there is one and by lead source otherwise, so
 * a realtor's link and the generic website form are both visible. Conversion is
 * funded over leads — the number that decides whether a referral relationship
 * is worth maintaining.
 */
export async function attributionReport(db: Db, sinceDays = 365): Promise<AttributionRow[]> {
  const since = new Date();
  since.setDate(since.getDate() - sinceDays);

  const rows = await db
    .select({
      code: deals.referralCode,
      source: deals.leadSource,
      status: deals.status,
      mortgageAmount: deals.mortgageAmount,
    })
    .from(deals)
    .where(gte(deals.createdAt, since));

  const known = await db
    .select({ code: referralSources.code, label: referralSources.label })
    .from(referralSources);

  const labels = new Map(known.map((row) => [row.code, row.label]));
  const buckets = new Map<string, AttributionRow>();

  for (const row of rows) {
    // A referral code is more specific than a lead source, so it wins the
    // grouping — otherwise every realtor collapses into "intake_form".
    const key = row.code ?? row.source ?? 'direct';

    const bucket = buckets.get(key) ?? {
      source: row.code ? 'referral' : (row.source ?? 'direct'),
      code: row.code,
      label: row.code ? (labels.get(row.code) ?? null) : null,
      leads: 0,
      funded: 0,
      volume: 0,
      conversionPercent: 0,
    };

    bucket.leads += 1;
    if (row.status === 'funded') {
      bucket.funded += 1;
      bucket.volume += Number(row.mortgageAmount ?? 0);
    }

    buckets.set(key, bucket);
  }

  return [...buckets.values()]
    .map((bucket) => ({
      ...bucket,
      conversionPercent:
        bucket.leads > 0 ? Math.round((bucket.funded / bucket.leads) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.leads - a.leads);
}

/** Intake tier and language mix, for judging whether the form is working. */
export async function intakeBreakdown(db: Db) {
  const rows = await db
    .select({
      tier: applications.tier,
      locale: applications.locale,
      count: sql<number>`count(*)::int`,
    })
    .from(applications)
    .groupBy(applications.tier, applications.locale);

  return rows;
}

/** Maturities in the next year — the renewal pipeline. */
export async function maturityPipeline(db: Db) {
  return db
    .select({
      id: deals.id,
      reference: deals.reference,
      maturityDate: deals.maturityDate,
      existingLender: deals.existingLender,
      existingBalance: deals.existingBalance,
    })
    .from(deals)
    .where(and(isNotNull(deals.maturityDate), eq(deals.status, 'funded')))
    .orderBy(deals.maturityDate)
    .limit(25);
}

/** Recent funded deals without a commission recorded — money not yet claimed. */
export async function fundedWithoutCommission(db: Db) {
  return db
    .select({
      id: deals.id,
      reference: deals.reference,
      mortgageAmount: deals.mortgageAmount,
      fundedAt: deals.fundedAt,
    })
    .from(deals)
    .where(
      and(
        eq(deals.status, 'funded'),
        sql`NOT EXISTS (SELECT 1 FROM ${dealCommissions} c WHERE c.deal_id = deals.id)`,
      ),
    )
    .orderBy(desc(deals.fundedAt));
}
