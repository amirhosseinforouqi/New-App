/**
 * Assembling everything the deal page needs.
 *
 * One module so the page stays a renderer. It gathers compliance, consents,
 * identity verification, down-payment sources, outstanding documents and
 * lender products, then feeds them to the engines — which stay pure and
 * testable because they never touch a database.
 */

import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';

import type { Db } from '@/db';
import {
  borrowerIncomes,
  consents,
  crossSellOpportunities,
  dealComplianceItems,
  documentRequests,
  documents,
  downPaymentSources,
  externalConnections,
  identityVerifications,
  lenderProducts,
  lenderSubmissions,
  lenders,
  scenarios,
} from '@/db/schema';
import { expandTemplate } from '@/lib/compliance/templates';
import { screenForCrossSell, type CrossSellContext } from '@/lib/crosssell/engine';
import {
  summariseConnections,
  type ConnectionRecord,
  type ConnectionSummary,
} from '@/lib/deals/connections';
import { dealRatios, num, type DealDetail } from '@/lib/deals/queries';
import {
  compareOptions,
  driftFromCurrent,
  type RateDrift,
  type ScenarioComparison,
  type ScenarioSnapshot,
} from '@/lib/deals/scenarios';
import { loadRuleOverrides } from '@/lib/deals/rule-settings';
import { evaluateSubmission, type SubmissionReadiness } from '@/lib/deals/validation';
import { dealProfile, rankProducts, type LenderProduct, type ProductMatch } from '@/lib/lenders/matching';

export interface Workspace {
  readiness: SubmissionReadiness;
  compliance: Array<typeof dealComplianceItems.$inferSelect>;
  matches: ProductMatch[];
  crossSell: Array<{ productKey: string; label: string; rationale: string; priority: number; status: string }>;
  outstandingDocuments: string[];
  downPayment: Array<typeof downPaymentSources.$inferSelect>;
  /** Uploads on this deal, for attaching to a compliance item. */
  dealDocuments: Array<{ id: string; fileName: string }>;
  identityByClient: Map<string, boolean>;
  consentByClient: Map<string, boolean>;
  /** Lenders and products, for the submission picker. */
  lenderOptions: Array<{
    id: string;
    name: string;
    products: Array<{ id: string; name: string; rate: number }>;
  }>;
  lastSubmittedAt: Date | null;
  /** Bank / CRA / bureau verification records, per kind. */
  connections: ConnectionSummary[];
  /** Saved comparisons, with how far the live table has moved since each. */
  scenarios: Array<{
    id: string;
    name: string;
    createdAt: Date;
    snapshot: ScenarioSnapshot;
    comparison: ScenarioComparison;
    drift: RateDrift[];
  }>;
}

export async function loadWorkspace(db: Db, detail: DealDetail): Promise<Workspace> {
  const { deal, borrowers, incomes, liabilities } = detail;
  const borrowerIds = borrowers.map((borrower) => borrower.clientId);

  // Sequential, NOT Promise.all. `withActor` hands out a single connection
  // bound to one transaction, and node-postgres cannot run concurrent queries
  // on one connection — it serialises them and emits a deprecation warning,
  // and a future version will throw. Parallelism here would need separate
  // connections, which would mean separate transactions and therefore separate
  // RLS scopes. Not worth it for seven small indexed reads.
  const queries = {
    outstanding: () =>
      db
        .select({ label: documentRequests.label })
        .from(documentRequests)
        .where(
          and(
            eq(documentRequests.dealId, deal.id),
            eq(documentRequests.isRequired, true),
            inArray(documentRequests.status, ['requested', 'needs_attention']),
          ),
        ),

    compliance: () =>
      db
        .select()
        .from(dealComplianceItems)
        .where(eq(dealComplianceItems.dealId, deal.id))
        .orderBy(asc(dealComplianceItems.sortOrder)),

    identity: () =>
      borrowerIds.length > 0
        ? db
            .select({ clientId: identityVerifications.clientId })
            .from(identityVerifications)
            .where(
              and(
                eq(identityVerifications.dealId, deal.id),
                inArray(identityVerifications.clientId, borrowerIds),
              ),
            )
        : Promise.resolve([]),

    signed: () =>
      borrowerIds.length > 0
        ? db
            .select({ clientId: consents.clientId })
            .from(consents)
            .where(
              and(
                eq(consents.dealId, deal.id),
                eq(consents.kind, 'credit_pull'),
                inArray(consents.clientId, borrowerIds),
              ),
            )
        : Promise.resolve([]),

    downPayment: () =>
      db.select().from(downPaymentSources).where(eq(downPaymentSources.dealId, deal.id)),

    crossSellRows: () =>
      db
        .select()
        .from(crossSellOpportunities)
        .where(eq(crossSellOpportunities.dealId, deal.id)),

    dealDocuments: () =>
      db
        .select({ id: documents.id, fileName: documents.fileName })
        .from(documents)
        .where(eq(documents.dealId, deal.id))
        .orderBy(desc(documents.createdAt)),

    products: () =>
      db
        .select({
          id: lenderProducts.id,
          lenderId: lenderProducts.lenderId,
          lenderName: lenders.name,
          name: lenderProducts.name,
          rateType: lenderProducts.rateType,
          termYears: lenderProducts.termYears,
          postedRate: lenderProducts.postedRate,
          minCreditScore: lenderProducts.minCreditScore,
          maxLtv: lenderProducts.maxLtv,
          maxGds: lenderProducts.maxGds,
          maxTds: lenderProducts.maxTds,
          maxAmortization: lenderProducts.maxAmortization,
          minLoanAmount: lenderProducts.minLoanAmount,
          maxLoanAmount: lenderProducts.maxLoanAmount,
          allowsInsured: lenderProducts.allowsInsured,
          allowsUninsured: lenderProducts.allowsUninsured,
          allowsRental: lenderProducts.allowsRental,
          allowsSelfEmployed: lenderProducts.allowsSelfEmployed,
          allowedProvinces: lenderProducts.allowedProvinces,
          allowedDealTypes: lenderProducts.allowedDealTypes,
          notes: lenderProducts.notes,
        })
        .from(lenderProducts)
        .innerJoin(lenders, eq(lenders.id, lenderProducts.lenderId))
        .where(and(eq(lenderProducts.isActive, true), eq(lenders.isActive, true))),
  };

  const outstanding = await queries.outstanding();
  const compliance = await queries.compliance();
  const identity = await queries.identity();
  const signed = await queries.signed();
  const downPayment = await queries.downPayment();
  const crossSellRows = await queries.crossSellRows();
  const dealDocuments = await queries.dealDocuments();
  const products = await queries.products();

  const [lastSubmission] = await db
    .select({ submittedAt: lenderSubmissions.submittedAt })
    .from(lenderSubmissions)
    .where(eq(lenderSubmissions.dealId, deal.id))
    .orderBy(desc(lenderSubmissions.submittedAt))
    .limit(1);

  const scenarioRows = await db
    .select({
      id: scenarios.id,
      name: scenarios.name,
      createdAt: scenarios.createdAt,
      snapshot: scenarios.snapshot,
    })
    .from(scenarios)
    .where(eq(scenarios.dealId, deal.id))
    .orderBy(desc(scenarios.createdAt));

  // Drift is measured against every product, active or not — a scenario built
  // on a product that has since been retired needs to say so, and filtering
  // retired ones out here would make it look merely deleted.
  const allProducts = await db
    .select({
      id: lenderProducts.id,
      postedRate: lenderProducts.postedRate,
      isActive: lenderProducts.isActive,
    })
    .from(lenderProducts);

  const currentRates = allProducts.map((product) => ({
    id: product.id,
    postedRate: Number(product.postedRate),
    isActive: product.isActive,
  }));

  const savedScenarios = scenarioRows.map((row) => {
    const snapshot = row.snapshot as ScenarioSnapshot;
    return {
      id: row.id,
      name: row.name,
      createdAt: row.createdAt,
      snapshot,
      comparison: compareOptions(snapshot.options ?? []),
      drift: driftFromCurrent(snapshot, currentRates),
    };
  });

  const lenderOptions = [...
    products
      .reduce((map, product) => {
        const entry = map.get(product.lenderId) ?? {
          id: product.lenderId,
          name: product.lenderName,
          products: [] as Array<{ id: string; name: string; rate: number }>,
        };
        entry.products.push({
          id: product.id,
          name: product.name,
          rate: Number(product.postedRate),
        });
        map.set(product.lenderId, entry);
        return map;
      }, new Map<string, { id: string; name: string; products: Array<{ id: string; name: string; rate: number }> }>())
      .values(),
  ];

  const connectionRows = await db
    .select({
      id: externalConnections.id,
      clientId: externalConnections.clientId,
      kind: externalConnections.kind,
      provider: externalConnections.provider,
      status: externalConnections.status,
      detail: externalConnections.detail,
      requestedAt: externalConnections.requestedAt,
      completedAt: externalConnections.completedAt,
    })
    .from(externalConnections)
    .where(eq(externalConnections.dealId, deal.id));

  const connections = summariseConnections(
    connectionRows satisfies ConnectionRecord[],
    borrowerIds,
  );

  const identityByClient = new Map(borrowerIds.map((id) => [id, false]));
  for (const row of identity) identityByClient.set(row.clientId, true);

  const consentByClient = new Map(borrowerIds.map((id) => [id, false]));
  for (const row of signed) consentByClient.set(row.clientId, true);

  const { ratios } = dealRatios(detail);

  const ruleOverrides = await loadRuleOverrides(db);

  const readiness = evaluateSubmission(
    {
      dealType: deal.dealType,
      mortgageAmount: num(deal.mortgageAmount),
      propertyValue: num(deal.propertyValue) ?? num(deal.purchasePrice),
      purchasePrice: num(deal.purchasePrice),
      downPayment: num(deal.downPayment),
      amortizationYears: deal.amortizationYears,
      propertyProvince: deal.propertyProvince,
      propertyAddress: deal.propertyAddress,
      annualPropertyTax: num(deal.annualPropertyTax),
      monthlyHeat: num(deal.monthlyHeat),
      borrowerCount: borrowers.length,
      incomeCount: incomes.length,
      ratios,
      outstandingDocuments: outstanding.map((row) => row.label),
      outstandingCompliance: compliance
        .filter((item) => item.status !== 'complete')
        .map((item) => item.label),
      // An empty borrower list must not read as "everyone is verified".
      allBorrowersIdentified:
        borrowerIds.length > 0 && borrowerIds.every((id) => identityByClient.get(id)),
      allConsentsSigned:
        borrowerIds.length > 0 && borrowerIds.every((id) => consentByClient.get(id)),
      downPaymentVerified:
        downPayment.length > 0 && downPayment.every((source) => source.isVerified),
      downPaymentFlags: downPayment.filter((source) => source.flagged).length,
    },
    ruleOverrides,
  );

  const propertyValue = num(deal.propertyValue) ?? num(deal.purchasePrice);
  const mortgageAmount = num(deal.mortgageAmount);

  const matches =
    products.length > 0 && mortgageAmount && propertyValue
      ? rankProducts(
          products.map((product) => ({
            ...product,
            termYears: Number(product.termYears),
            postedRate: Number(product.postedRate),
            maxLtv: num(product.maxLtv),
            maxGds: num(product.maxGds),
            maxTds: num(product.maxTds),
            minLoanAmount: num(product.minLoanAmount),
            maxLoanAmount: num(product.maxLoanAmount),
          })) satisfies LenderProduct[],
          dealProfile({
            mortgageAmount,
            propertyValue,
            amortizationYears: deal.amortizationYears,
            dealType: deal.dealType,
            province: deal.propertyProvince,
            occupancy: deal.occupancy,
            employmentTypes: incomes.map((income) => income.employmentType),
            ratios,
          }),
        )
      : [];

  // Screening is recomputed on every view rather than read from the table, so
  // it always reflects the file as it stands now. The stored rows only carry
  // the broker's decision — dismissed, raised, sold.
  const context: CrossSellContext = {
    dealType: deal.dealType,
    mortgageAmount,
    propertyValue,
    purchasePrice: num(deal.purchasePrice),
    downPayment: num(deal.downPayment),
    amortizationYears: deal.amortizationYears,
    maturityDate: deal.maturityDate,
    occupancy: deal.occupancy,
    propertyType: deal.propertyType,
    isFirstTimeBuyer: false,
    hasCoBorrower: borrowers.length > 1,
    borrowerCount: borrowers.length,
    employmentTypes: incomes.map((income) => income.employmentType),
    totalMonthlyDebt: liabilities.reduce((sum, item) => sum + Number(item.monthlyPayment), 0),
    highInterestDebt: liabilities
      .filter((item) => ['credit_card', 'loan', 'other'].includes(item.liabilityType))
      .reduce((sum, item) => sum + Number(item.balance), 0),
    ltv: ratios?.ltv ?? null,
    gds: ratios?.gds ?? null,
    tds: ratios?.tds ?? null,
  };

  const decisions = new Map(crossSellRows.map((row) => [row.productKey, row.status]));

  const crossSell = screenForCrossSell(context).map((suggestion) => ({
    ...suggestion,
    label: suggestion.label,
    status: decisions.get(suggestion.productKey) ?? 'suggested',
  }));

  return {
    readiness,
    compliance,
    matches,
    crossSell,
    outstandingDocuments: outstanding.map((row) => row.label),
    downPayment,
    dealDocuments,
    identityByClient,
    consentByClient,
    lenderOptions,
    lastSubmittedAt: lastSubmission?.submittedAt ?? null,
    connections,
    scenarios: savedScenarios,
  };
}

/** Create the compliance checklist for a deal, if it has none. */
export async function ensureComplianceChecklist(
  db: Db,
  dealId: string,
  dealType: string,
  borrowers: Array<{ clientId: string; fullName: string }>,
): Promise<number> {
  const [existing] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(dealComplianceItems)
    .where(eq(dealComplianceItems.dealId, dealId));

  if ((existing?.count ?? 0) > 0) return 0;

  const rows = expandTemplate(dealType, borrowers);
  if (rows.length === 0) return 0;

  await db.insert(dealComplianceItems).values(
    rows.map((row) => ({
      dealId,
      label: row.label,
      description: row.description,
      requiresDocument: row.requiresDocument,
      sortOrder: row.sortOrder,
    })),
  );

  return rows.length;
}

/** Employment types on a deal, for the lender matcher and cross-sell. */
export async function employmentTypes(db: Db, dealId: string): Promise<string[]> {
  const rows = await db
    .select({ employmentType: borrowerIncomes.employmentType })
    .from(borrowerIncomes)
    .where(eq(borrowerIncomes.dealId, dealId));

  return rows.map((row) => row.employmentType);
}
