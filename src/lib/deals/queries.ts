/**
 * Reading deals.
 *
 * Kept out of the page components because the same shapes are needed by the
 * board, the deal page and (shortly) the lender-submission summary, and because
 * assembling a deal is a genuinely multi-table job: borrowers, incomes,
 * liabilities and document counts all live elsewhere.
 *
 * Every function here takes a `db` that is already actor-scoped. None of them
 * open their own transaction, so RLS applies exactly as the caller established
 * it — a broker's `asBroker` sees everything, a borrower's `asClient` sees only
 * the deals they are a borrower on.
 */

import { and, desc, eq, inArray, sql } from 'drizzle-orm';

import type { Db } from '@/db';
import {
  borrowerIncomes,
  borrowerLiabilities,
  clients,
  dealBorrowers,
  deals,
  documentRequests,
  documents,
  messages,
} from '@/db/schema';
import { STRESS_TEST_FLOOR } from '@/lib/finance/mortgage';
import { calculateRatios, type RatioResult } from '@/lib/finance/ratios';

/** Numeric columns come back as strings; a null column is a genuinely absent figure. */
export const num = (value: string | null | undefined): number | null =>
  value === null || value === undefined ? null : Number(value);

export interface DealCard {
  id: string;
  reference: string;
  dealType: string;
  stageKey: string;
  status: string;
  assignedTo: string | null;
  lockedAt: Date | null;
  mortgageAmount: number | null;
  propertyCity: string | null;
  propertyProvince: string | null;
  maturityDate: string | null;
  leadSource: string | null;
  referralCode: string | null;
  createdAt: Date;
  updatedAt: Date;
  borrowerNames: string[];
  primaryClientId: string;
  awaitingReview: number;
  outstanding: number;
  unread: number;
}

/**
 * Every deal on the board.
 *
 * The counts are correlated subqueries rather than joins on purpose: a join
 * against three one-to-many tables multiplies rows and then needs distinct
 * counting, which is both slower and much easier to get subtly wrong.
 *
 * Note the outer table is written literally as `deals.id` and NOT as
 * `${deals.id}`. Interpolating a Drizzle column into a `sql` projection renders
 * it *unqualified* — just `"id"` — so inside a subquery it binds to the inner
 * table instead of the outer one. `d.deal_id = "id"` is then `d.deal_id = d.id`,
 * which is false for every row, and the count silently comes back 0 rather than
 * erroring. Every badge on this board read zero because of exactly that.
 * `tests/rls.test.ts` pins both forms so the difference stays visible.
 */
export async function listDealCards(db: Db, includeArchived = false): Promise<DealCard[]> {
  const rows = await db
    .select({
      id: deals.id,
      reference: deals.reference,
      dealType: deals.dealType,
      stageKey: deals.stageKey,
      status: deals.status,
      assignedTo: deals.assignedTo,
      lockedAt: deals.lockedAt,
      mortgageAmount: deals.mortgageAmount,
      propertyCity: deals.propertyCity,
      propertyProvince: deals.propertyProvince,
      maturityDate: deals.maturityDate,
      leadSource: deals.leadSource,
      referralCode: deals.referralCode,
      createdAt: deals.createdAt,
      updatedAt: deals.updatedAt,
      primaryClientId: deals.clientId,
      awaitingReview: sql<number>`(
        SELECT count(*)::int FROM ${documents} d
         WHERE d.deal_id = deals.id AND d.status = 'in_review'
      )`,
      outstanding: sql<number>`(
        SELECT count(*)::int FROM ${documentRequests} r
         WHERE r.deal_id = deals.id AND r.status IN ('requested', 'needs_attention')
      )`,
      unread: sql<number>`(
        SELECT count(*)::int FROM ${messages} m
         WHERE m.deal_id = deals.id AND m.sender_type = 'client' AND m.read_at IS NULL
      )`,
    })
    .from(deals)
    .where(includeArchived ? sql`true` : sql`${deals.status} <> 'archived'`)
    .orderBy(desc(deals.updatedAt));

  if (rows.length === 0) return [];

  // One extra round trip for all borrowers rather than N for each deal.
  const borrowerRows = await db
    .select({
      dealId: dealBorrowers.dealId,
      role: dealBorrowers.role,
      fullName: clients.fullName,
    })
    .from(dealBorrowers)
    .innerJoin(clients, eq(clients.id, dealBorrowers.clientId))
    .where(
      inArray(
        dealBorrowers.dealId,
        rows.map((row) => row.id),
      ),
    );

  const namesByDeal = new Map<string, string[]>();
  for (const row of borrowerRows) {
    const list = namesByDeal.get(row.dealId) ?? [];
    // Primary borrower first — that is the name the broker thinks of the file by.
    if (row.role === 'primary') list.unshift(row.fullName);
    else list.push(row.fullName);
    namesByDeal.set(row.dealId, list);
  }

  return rows.map((row) => ({
    ...row,
    mortgageAmount: num(row.mortgageAmount),
    borrowerNames: namesByDeal.get(row.id) ?? [],
  }));
}

export interface DealDetail {
  deal: typeof deals.$inferSelect;
  borrowers: Array<{
    clientId: string;
    role: string;
    fullName: string;
    email: string;
    username: string;
    acceptedAt: Date | null;
  }>;
  incomes: Array<typeof borrowerIncomes.$inferSelect>;
  liabilities: Array<typeof borrowerLiabilities.$inferSelect>;
}

export async function getDealDetail(db: Db, dealId: string): Promise<DealDetail | null> {
  const [deal] = await db.select().from(deals).where(eq(deals.id, dealId)).limit(1);
  if (!deal) return null;

  const borrowers = await db
    .select({
      clientId: dealBorrowers.clientId,
      role: dealBorrowers.role,
      fullName: clients.fullName,
      email: clients.email,
      username: clients.username,
      acceptedAt: dealBorrowers.acceptedAt,
    })
    .from(dealBorrowers)
    .innerJoin(clients, eq(clients.id, dealBorrowers.clientId))
    .where(eq(dealBorrowers.dealId, dealId));

  const incomes = await db
    .select()
    .from(borrowerIncomes)
    .where(eq(borrowerIncomes.dealId, dealId));

  const liabilities = await db
    .select()
    .from(borrowerLiabilities)
    .where(eq(borrowerLiabilities.dealId, dealId));

  return { deal, borrowers, incomes, liabilities };
}

/**
 * Ratios for a deal, or an explanation of why they cannot be computed.
 *
 * Returning `null` with a reason beats returning zeros: a broker looking at
 * "GDS 0.0%" cannot tell whether the file is spectacular or empty.
 */
export function dealRatios(
  detail: DealDetail,
  options: { useStressTest?: boolean } = {},
): { ratios: RatioResult | null; blockedBy: string[]; rateIsAssumed: boolean } {
  const { deal, incomes, liabilities } = detail;
  const blockedBy: string[] = [];

  const mortgageAmount = num(deal.mortgageAmount);
  const propertyValue = num(deal.propertyValue) ?? num(deal.purchasePrice);

  if (mortgageAmount === null) blockedBy.push('mortgage amount');
  if (propertyValue === null) blockedBy.push('property value');
  if (incomes.length === 0) blockedBy.push('income');

  const quotedRate = num(deal.interestRate);
  const rateIsAssumed = quotedRate === null;

  if (blockedBy.length > 0) return { ratios: null, blockedBy, rateIsAssumed };

  // A file with no rate quoted yet still needs a number to qualify against.
  // The stress-test floor is the honest default, and the UI says out loud that
  // it is an assumption rather than something a lender has offered.
  const rate = quotedRate ?? STRESS_TEST_FLOOR;

  // `deal.paymentFrequency` is deliberately NOT passed through.
  //
  // Lenders qualify on the contractual monthly payment. If a borrower elects
  // accelerated bi-weekly they are volunteering to pay roughly one extra
  // month a year — that is a prepayment, not an obligation, and charging it
  // against GDS would fail files that a lender would approve. For the
  // non-accelerated frequencies the monthly equivalent is the same figure
  // anyway. The borrower's actual schedule belongs on the payment calculator,
  // not in the qualifying ratio.
  return {
    ratios: calculateRatios({
      mortgageAmount: mortgageAmount!,
      annualRatePercent: rate,
      amortizationYears: deal.amortizationYears ?? 25,
      propertyValue: propertyValue!,
      annualPropertyTax: num(deal.annualPropertyTax),
      monthlyHeat: num(deal.monthlyHeat),
      monthlyCondoFees: num(deal.monthlyCondoFees),
      incomes: incomes.map((income) => ({
        annualIncome: Number(income.annualIncome),
        employmentType: income.employmentType,
        priorYearIncome: num(income.priorYearIncome),
      })),
      liabilities: liabilities.map((item) => ({
        monthlyPayment: Number(item.monthlyPayment),
        includeInTds: item.includeInTds,
        payoutOnClosing: item.payoutOnClosing,
      })),
      useStressTest: options.useStressTest ?? true,
    }),
    blockedBy: [],
    rateIsAssumed,
  };
}

/** Deals a given client is a borrower on — the borrower's deal switcher. */
export async function listDealsForClient(db: Db, clientId: string) {
  return db
    .select({
      id: deals.id,
      reference: deals.reference,
      dealType: deals.dealType,
      stageKey: deals.stageKey,
      status: deals.status,
      propertyCity: deals.propertyCity,
      createdAt: deals.createdAt,
      role: dealBorrowers.role,
    })
    .from(dealBorrowers)
    .innerJoin(deals, eq(deals.id, dealBorrowers.dealId))
    .where(and(eq(dealBorrowers.clientId, clientId), sql`${deals.status} <> 'archived'`))
    .orderBy(desc(deals.createdAt));
}
