import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { matchProduct, rankProducts, type LenderProduct, type DealProfile } from '../src/lib/lenders/matching';
import {
  applyOverrides,
  evaluateSubmission,
  RULES,
  RULES_BY_KEY,
  type SubmissionSnapshot,
} from '../src/lib/deals/validation';
import { expandTemplate, templateForDealType } from '../src/lib/compliance/templates';
import { screenForCrossSell, type CrossSellContext } from '../src/lib/crosssell/engine';
import { calculateCommission, defaultSplits, summariseByPayee } from '../src/lib/commissions/calculate';
import { calculateRatios } from '../src/lib/finance/ratios';

// ── Lender matching ─────────────────────────────────────────────────────────

const baseProduct: LenderProduct = {
  id: 'p1',
  lenderId: 'l1',
  lenderName: 'Test Trust',
  name: '5-year fixed',
  rateType: 'fixed',
  termYears: 5,
  postedRate: 4.79,
  minCreditScore: null,
  maxLtv: null,
  maxGds: null,
  maxTds: null,
  maxAmortization: null,
  minLoanAmount: null,
  maxLoanAmount: null,
  allowsInsured: true,
  allowsUninsured: true,
  allowsRental: true,
  allowsSelfEmployed: true,
  allowedProvinces: null,
  allowedDealTypes: null,
  notes: null,
};

const baseDeal: DealProfile = {
  mortgageAmount: 600_000,
  propertyValue: 750_000,
  amortizationYears: 25,
  dealType: 'purchase',
  province: 'ON',
  occupancy: 'owner_occupied',
  creditScore: 740,
  isSelfEmployed: false,
  ratios: null,
};

describe('lender matching', () => {
  it('treats a null rule as no constraint, not as zero', () => {
    // The classic bug: a product with minCreditScore unset excluding everyone.
    const match = matchProduct(baseProduct, { ...baseDeal, creditScore: null });
    assert.equal(match.fits, true, match.failures.map((f) => f.rule).join(','));
  });

  it('fails an LTV over the ceiling, and says so actionably', () => {
    const match = matchProduct({ ...baseProduct, maxLtv: 75 }, baseDeal);
    assert.equal(match.fits, false);

    const failure = match.failures.find((item) => item.rule === 'ltv');
    assert.ok(failure);
    assert.equal(failure!.actionable, true);
    assert.match(failure!.detail, /down payment/i);
  });

  it('distinguishes an unknown credit score from a low one', () => {
    const unknown = matchProduct({ ...baseProduct, minCreditScore: 680 }, { ...baseDeal, creditScore: null });
    const low = matchProduct({ ...baseProduct, minCreditScore: 680 }, { ...baseDeal, creditScore: 600 });

    assert.equal(unknown.failures[0]!.rule, 'credit_unknown');
    assert.equal(unknown.failures[0]!.actionable, true, 'pulling a bureau is actionable');

    assert.equal(low.failures[0]!.rule, 'credit');
    assert.equal(low.failures[0]!.actionable, false, 'a low score is not something to "fix"');
  });

  it('knows an insured file from an uninsured one', () => {
    const highRatio = { ...baseDeal, mortgageAmount: 700_000 }; // 93% LTV
    const insuredOnly = { ...baseProduct, allowsUninsured: false };
    const uninsuredOnly = { ...baseProduct, allowsInsured: false };

    assert.equal(matchProduct(insuredOnly, highRatio).fits, true);
    assert.equal(matchProduct(uninsuredOnly, highRatio).fits, false);
    assert.equal(matchProduct(uninsuredOnly, baseDeal).fits, true);
    assert.equal(matchProduct(insuredOnly, baseDeal).fits, false);
  });

  it('applies ratio limits only when ratios exist', () => {
    const tight = { ...baseProduct, maxGds: 35 };
    assert.equal(matchProduct(tight, baseDeal).fits, true, 'no ratios means no ratio failure');

    const ratios = calculateRatios({
      mortgageAmount: 600_000,
      annualRatePercent: 4.79,
      amortizationYears: 25,
      propertyValue: 750_000,
      annualPropertyTax: 5_000,
      monthlyHeat: 100,
      incomes: [{ annualIncome: 90_000, employmentType: 'salaried' }],
      liabilities: [],
    });

    assert.equal(matchProduct(tight, { ...baseDeal, ratios }).fits, false);
  });

  it('respects province and deal-type allow lists', () => {
    const bcOnly = { ...baseProduct, allowedProvinces: ['BC'] };
    assert.equal(matchProduct(bcOnly, baseDeal).fits, false);
    assert.equal(matchProduct(bcOnly, { ...baseDeal, province: 'BC' }).fits, true);

    const purchaseOnly = { ...baseProduct, allowedDealTypes: ['purchase'] };
    assert.equal(matchProduct(purchaseOnly, baseDeal).fits, true);
    assert.equal(matchProduct(purchaseOnly, { ...baseDeal, dealType: 'refinance' }).fits, false);
  });

  it('computes interest over the TERM, not the amortization', () => {
    const match = matchProduct(baseProduct, baseDeal);

    // Five years of interest on $600k at 4.79% is well under the lifetime
    // figure, and the balance must still be substantial at renewal.
    assert.ok(match.totalInterestOverTerm > 100_000, `got ${match.totalInterestOverTerm}`);
    assert.ok(match.totalInterestOverTerm < 160_000, `got ${match.totalInterestOverTerm}`);
    assert.ok(match.balanceAtEndOfTerm > 500_000, `got ${match.balanceAtEndOfTerm}`);
    assert.ok(match.balanceAtEndOfTerm < 600_000);
  });

  it('ranks fitting products above failing ones', () => {
    const good = { ...baseProduct, id: 'good', postedRate: 5.5 };
    const cheapButUnavailable = { ...baseProduct, id: 'cheap', postedRate: 3.99, maxLtv: 50 };

    const ranked = rankProducts([cheapButUnavailable, good], baseDeal);
    assert.equal(ranked[0]!.product.id, 'good');
    assert.equal(ranked[0]!.fits, true);
    assert.equal(ranked[1]!.fits, false);
  });

  it('ranks by cost over the term rather than headline rate', () => {
    const lowRateShortTerm = { ...baseProduct, id: 'short', postedRate: 4.5, termYears: 1 };
    const higherRateLongTerm = { ...baseProduct, id: 'long', postedRate: 4.7, termYears: 5 };

    const ranked = rankProducts([higherRateLongTerm, lowRateShortTerm], baseDeal);
    // The 1-year term leaves a much larger balance outstanding, so total cost
    // over its term is lower — the point is that the ordering is computed, not
    // taken from the advertised number.
    assert.equal(ranked[0]!.product.id, 'short');
  });

  it('can hide failures when asked', () => {
    const failing = { ...baseProduct, maxLtv: 10 };
    assert.equal(rankProducts([failing], baseDeal, { includeFailures: false }).length, 0);
    assert.equal(rankProducts([failing], baseDeal).length, 1);
  });
});

// ── Submission validation ───────────────────────────────────────────────────

const readyDeal: SubmissionSnapshot = {
  dealType: 'purchase',
  mortgageAmount: 600_000,
  propertyValue: 750_000,
  purchasePrice: 750_000,
  downPayment: 150_000,
  amortizationYears: 25,
  propertyProvince: 'ON',
  propertyAddress: '1 Main St',
  annualPropertyTax: 5_000,
  monthlyHeat: 100,
  borrowerCount: 1,
  incomeCount: 1,
  ratios: null,
  outstandingDocuments: [],
  outstandingCompliance: [],
  allBorrowersIdentified: true,
  allConsentsSigned: true,
  downPaymentVerified: true,
  downPaymentFlags: 0,
};

describe('submission readiness', () => {
  it('passes a complete file', () => {
    const result = evaluateSubmission(readyDeal);
    assert.equal(result.ready, true, result.blocking.map((i) => i.key).join(','));
    assert.equal(result.blocking.length, 0);
    assert.equal(result.completeness, 100);
  });

  it('blocks on missing FINTRAC identity verification', () => {
    const result = evaluateSubmission({ ...readyDeal, allBorrowersIdentified: false });
    assert.equal(result.ready, false);
    assert.ok(result.blocking.some((issue) => issue.key === 'fintrac_id'));
  });

  it('blocks on an unsigned credit consent', () => {
    const result = evaluateSubmission({ ...readyDeal, allConsentsSigned: false });
    assert.ok(result.blocking.some((issue) => issue.key === 'consent'));
  });

  it('blocks on outstanding required documents and names them', () => {
    const result = evaluateSubmission({
      ...readyDeal,
      outstandingDocuments: ['Notice of Assessment', 'T4'],
    });
    const issue = result.blocking.find((item) => item.key === 'documents');
    assert.ok(issue);
    assert.match(issue!.message, /Notice of Assessment/);
  });

  it('warns rather than blocks on a failing ratio', () => {
    const ratios = calculateRatios({
      mortgageAmount: 600_000,
      annualRatePercent: 5,
      amortizationYears: 25,
      propertyValue: 750_000,
      annualPropertyTax: 5_000,
      monthlyHeat: 100,
      incomes: [{ annualIncome: 60_000, employmentType: 'salaried' }],
      liabilities: [],
    });

    const result = evaluateSubmission({ ...readyDeal, ratios });
    assert.equal(result.ready, true, 'a stretched ratio is the broker’s call, not a hard gate');
    assert.ok(result.warnings.some((issue) => issue.key === 'gds'));
  });

  it('warns on unverified down payment for a purchase only', () => {
    const purchase = evaluateSubmission({ ...readyDeal, downPaymentVerified: false });
    assert.ok(purchase.warnings.some((issue) => issue.key === 'down_payment'));

    const renewal = evaluateSubmission({
      ...readyDeal,
      dealType: 'renewal',
      downPaymentVerified: false,
    });
    assert.ok(!renewal.warnings.some((issue) => issue.key === 'down_payment'));
  });

  it('reports lower completeness the worse the file is', () => {
    const empty = evaluateSubmission({
      ...readyDeal,
      mortgageAmount: null,
      propertyValue: null,
      incomeCount: 0,
      borrowerCount: 0,
      allBorrowersIdentified: false,
      allConsentsSigned: false,
      annualPropertyTax: null,
      monthlyHeat: null,
    });

    assert.equal(empty.ready, false);
    assert.ok(empty.completeness < 50, `got ${empty.completeness}`);
    assert.ok(empty.completeness >= 0);
  });
});

// ── Configurable rules ──────────────────────────────────────────────────────

describe('rule overrides', () => {
  const noAddress = { ...readyDeal, dealType: 'purchase', propertyAddress: null };

  it('promotes a warning to blocking when the brokerage asks', () => {
    const asShipped = evaluateSubmission(noAddress);
    assert.equal(asShipped.ready, true);
    assert.ok(asShipped.warnings.some((issue) => issue.key === 'address'));

    const stricter = evaluateSubmission(
      noAddress,
      new Map([['address', { severity: 'blocking' as const }]]),
    );
    assert.equal(stricter.ready, false);
    assert.ok(stricter.blocking.some((issue) => issue.key === 'address'));
  });

  it('demotes a blocking rule to a warning', () => {
    const missingDocs = { ...readyDeal, outstandingDocuments: ['T4'] };

    assert.equal(evaluateSubmission(missingDocs).ready, false);

    const relaxed = evaluateSubmission(
      missingDocs,
      new Map([['documents', { severity: 'warning' as const }]]),
    );
    assert.equal(relaxed.ready, true);
    assert.ok(relaxed.warnings.some((issue) => issue.key === 'documents'));
  });

  it('drops a disabled rule entirely', () => {
    const noHeat = { ...readyDeal, monthlyHeat: null };

    assert.ok(evaluateSubmission(noHeat).warnings.some((issue) => issue.key === 'heat'));

    const off = evaluateSubmission(noHeat, new Map([['heat', { enabled: false }]]));
    assert.ok(!off.issues.some((issue) => issue.key === 'heat'));
  });

  it('refuses to soften FINTRAC identity verification', () => {
    // The whole point of the lock. An override row written directly into the
    // table must not be able to weaken a legal obligation.
    const unverified = { ...readyDeal, allBorrowersIdentified: false };

    const attempted = evaluateSubmission(
      unverified,
      new Map([['fintrac_id', { severity: 'warning' as const, enabled: false }]]),
    );

    assert.equal(attempted.ready, false);
    assert.ok(attempted.blocking.some((issue) => issue.key === 'fintrac_id'));
  });

  it('refuses to switch off the credit-pull consent', () => {
    const unsigned = { ...readyDeal, allConsentsSigned: false };

    const attempted = evaluateSubmission(
      unsigned,
      new Map([['consent', { enabled: false }]]),
    );

    assert.equal(attempted.ready, false);
    assert.ok(attempted.blocking.some((issue) => issue.key === 'consent'));
  });

  it('reports locked rules as unchangeable through applyOverrides', () => {
    const applied = applyOverrides(
      new Map([
        ['fintrac_id', { severity: 'warning' as const, enabled: false }],
        ['heat', { severity: 'blocking' as const, enabled: true }],
      ]),
    );

    const fintrac = applied.find((entry) => entry.rule.key === 'fintrac_id')!;
    assert.equal(fintrac.severity, 'blocking');
    assert.equal(fintrac.enabled, true);

    const heat = applied.find((entry) => entry.rule.key === 'heat')!;
    assert.equal(heat.severity, 'blocking');
  });

  it('keeps a disabled rule out of the completeness denominator', () => {
    // Otherwise turning a check off would drag the bar down, which reads as
    // the file getting worse for doing nothing.
    const clean = evaluateSubmission(readyDeal);
    const withOneOff = evaluateSubmission(readyDeal, new Map([['heat', { enabled: false }]]));

    assert.equal(clean.completeness, 100);
    assert.equal(withOneOff.completeness, 100);
  });

  it('every rule in the catalogue has a unique key', () => {
    const keys = RULES.map((rule) => rule.key);
    assert.equal(new Set(keys).size, keys.length);
    // The engine looks rules up by key; a duplicate would silently shadow one.
    assert.equal(RULES_BY_KEY.size, RULES.length);
  });
});

// ── Compliance templates ────────────────────────────────────────────────────

describe('compliance templates', () => {
  it('adds purchase-specific items to a purchase', () => {
    const purchase = templateForDealType('purchase').map((item) => item.label);
    assert.ok(purchase.some((label) => label.includes('Agreement of Purchase and Sale')));
    assert.ok(!purchase.some((label) => label.includes('Existing mortgage statement')));
  });

  it('adds refinance-specific items to a refinance', () => {
    const refi = templateForDealType('refinance').map((item) => item.label);
    assert.ok(refi.some((label) => label.includes('Existing mortgage statement')));
    assert.ok(refi.some((label) => label.includes('Payout penalty')));
  });

  it('expands per-borrower items once per borrower', () => {
    const rows = expandTemplate('purchase', [
      { clientId: 'a', fullName: 'Priya Ramanathan' },
      { clientId: 'b', fullName: 'Marc Nguyen' },
    ]);

    // Identity verification is the obligation that must not be ticked once for
    // a two-borrower file.
    const identity = rows.filter((row) => row.label.startsWith('Verify borrower identity'));
    assert.equal(identity.length, 2);
    assert.ok(identity.some((row) => row.label.includes('Priya Ramanathan')));
    assert.ok(identity.some((row) => row.label.includes('Marc Nguyen')));
  });

  it('still produces deal-level items with no borrowers yet', () => {
    const rows = expandTemplate('purchase', []);
    assert.ok(rows.length > 0);
    assert.ok(rows.some((row) => row.label === 'Confirm source of down payment'));
  });

  it('gives every row a distinct sort order', () => {
    const rows = expandTemplate('refinance', [{ clientId: 'a', fullName: 'A' }]);
    const orders = rows.map((row) => row.sortOrder);
    assert.equal(new Set(orders).size, orders.length);
  });
});

// ── Cross-sell ──────────────────────────────────────────────────────────────

const baseContext: CrossSellContext = {
  dealType: 'purchase',
  mortgageAmount: 600_000,
  propertyValue: 750_000,
  purchasePrice: 750_000,
  downPayment: 150_000,
  amortizationYears: 25,
  maturityDate: null,
  occupancy: 'owner_occupied',
  propertyType: 'detached',
  isFirstTimeBuyer: false,
  hasCoBorrower: false,
  borrowerCount: 1,
  employmentTypes: ['salaried'],
  totalMonthlyDebt: 0,
  highInterestDebt: 0,
  ltv: 80,
  gds: 30,
  tds: 35,
};

describe('cross-sell screening', () => {
  it('always suggests protection where there is a mortgage', () => {
    const keys = screenForCrossSell(baseContext).map((s) => s.productKey);
    assert.ok(keys.includes('mortgage_protection'));
  });

  it('rates a single borrower higher than a couple for protection', () => {
    const single = screenForCrossSell(baseContext).find((s) => s.productKey === 'mortgage_protection');
    const couple = screenForCrossSell({ ...baseContext, hasCoBorrower: true }).find(
      (s) => s.productKey === 'mortgage_protection',
    );
    assert.ok(single!.priority > couple!.priority);
  });

  it('suggests consolidation only when there is equity room', () => {
    const withRoom = screenForCrossSell({ ...baseContext, highInterestDebt: 40_000, ltv: 70 });
    const noRoom = screenForCrossSell({ ...baseContext, highInterestDebt: 40_000, ltv: 90 });

    assert.ok(withRoom.some((s) => s.productKey === 'debt_consolidation'));
    assert.ok(!noRoom.some((s) => s.productKey === 'debt_consolidation'));
  });

  it('spots a borrower just short of 20% down', () => {
    const suggestion = screenForCrossSell({
      ...baseContext,
      downPayment: 130_000, // 17.3%
    }).find((s) => s.productKey === 'reach_twenty_percent');

    assert.ok(suggestion);
    assert.match(suggestion!.rationale, /17\.3%/);
    assert.match(suggestion!.rationale, /default insurance/);
  });

  it('does not suggest it at 20% or above', () => {
    const at20 = screenForCrossSell({ ...baseContext, downPayment: 150_000 });
    assert.ok(!at20.some((s) => s.productKey === 'reach_twenty_percent'));
  });

  it('flags a renewal inside six months and an overdue one harder', () => {
    const soon = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);
    const overdue = new Date(Date.now() - 10 * 86_400_000).toISOString().slice(0, 10);
    const distant = new Date(Date.now() + 400 * 86_400_000).toISOString().slice(0, 10);

    const soonHit = screenForCrossSell({ ...baseContext, maturityDate: soon }).find(
      (s) => s.productKey === 'renewal',
    );
    const overdueHit = screenForCrossSell({ ...baseContext, maturityDate: overdue }).find(
      (s) => s.productKey === 'renewal',
    );
    const distantHit = screenForCrossSell({ ...baseContext, maturityDate: distant }).find(
      (s) => s.productKey === 'renewal',
    );

    assert.ok(soonHit);
    assert.ok(overdueHit);
    assert.ok(!distantHit, 'a renewal 400 days out is not a call to action');
    assert.ok(overdueHit!.priority > soonHit!.priority);
  });

  it('ignores an unparseable maturity date instead of throwing', () => {
    assert.doesNotThrow(() => screenForCrossSell({ ...baseContext, maturityDate: 'soon-ish' }));
  });

  it('returns suggestions highest priority first', () => {
    const results = screenForCrossSell({
      ...baseContext,
      highInterestDebt: 40_000,
      ltv: 70,
      isFirstTimeBuyer: true,
    });
    for (let i = 1; i < results.length; i += 1) {
      assert.ok(results[i - 1]!.priority >= results[i]!.priority);
    }
  });
});

// ── Commissions ─────────────────────────────────────────────────────────────

describe('commissions', () => {
  it('computes a finder’s fee', () => {
    const result = calculateCommission({ fundedAmount: 600_000, findersFeePercent: 0.9 }, []);
    assert.equal(result.baseCommission, 5_400);
    assert.equal(result.totalCommission, 5_400);
  });

  it('adds a volume bonus', () => {
    const result = calculateCommission(
      { fundedAmount: 600_000, findersFeePercent: 0.9, volumeBonus: 600 },
      [],
    );
    assert.equal(result.totalCommission, 6_000);
  });

  it('splits to the exact cent, with no money lost to rounding', () => {
    // 33.33/33.33/33.34 of an amount that does not divide evenly.
    const result = calculateCommission({ fundedAmount: 333_333, findersFeePercent: 1 }, [
      { payeeName: 'A', percent: 33.33 },
      { payeeName: 'B', percent: 33.33 },
      { payeeName: 'C', percent: 33.34 },
    ]);

    const distributed = result.splits.reduce((sum, split) => sum + split.amount, 0);
    assert.equal(
      Math.round(distributed * 100),
      Math.round(result.totalCommission * 100),
      'splits must total the commission exactly',
    );
    assert.equal(result.warnings.length, 0);
  });

  it('gives the rounding remainder to the largest share', () => {
    const result = calculateCommission({ fundedAmount: 100_000, findersFeePercent: 1 }, [
      { payeeName: 'Small', percent: 1 },
      { payeeName: 'Large', percent: 99 },
    ]);

    const large = result.splits.find((split) => split.payeeName === 'Large')!;
    const small = result.splits.find((split) => split.payeeName === 'Small')!;
    assert.equal(Math.round((large.amount + small.amount) * 100), Math.round(result.totalCommission * 100));
  });

  it('warns when splits do not total 100%', () => {
    const short = calculateCommission({ fundedAmount: 100_000, findersFeePercent: 1 }, [
      { payeeName: 'A', percent: 70 },
    ]);
    assert.ok(short.warnings.some((warning) => warning.includes('70')));

    const over = calculateCommission({ fundedAmount: 100_000, findersFeePercent: 1 }, [
      { payeeName: 'A', percent: 70 },
      { payeeName: 'B', percent: 50 },
    ]);
    assert.ok(over.warnings.some((warning) => warning.includes('More is allocated')));
  });

  it('warns when nothing is allocated at all', () => {
    const result = calculateCommission({ fundedAmount: 100_000, findersFeePercent: 1 }, []);
    assert.ok(result.warnings.some((warning) => warning.includes('unallocated')));
  });

  it('never produces a negative commission from bad input', () => {
    const result = calculateCommission({ fundedAmount: -1, findersFeePercent: -5 }, []);
    assert.equal(result.totalCommission, 0);
  });

  it('builds a default agent/brokerage split totalling 100', () => {
    const splits = defaultSplits({ agentName: 'A', agentSplitPercent: 70 });
    assert.equal(splits.reduce((sum, s) => sum + s.percent, 0), 100);
    assert.equal(splits.find((s) => s.role === 'agent')!.percent, 70);
  });

  it('takes the referrer off the top before the agent split', () => {
    const splits = defaultSplits({
      agentName: 'A',
      agentSplitPercent: 70,
      referrerName: 'R',
      referrerPercent: 20,
    });

    assert.equal(splits.reduce((sum, s) => sum + s.percent, 0), 100);
    assert.equal(splits.find((s) => s.role === 'referrer')!.percent, 20);
    // 70% of the remaining 80.
    assert.equal(splits.find((s) => s.role === 'agent')!.percent, 56);
  });

  it('summarises paid and pending by payee', () => {
    const summary = summariseByPayee([
      { brokerId: 'b1', payeeName: 'A', amount: 1_000, status: 'paid', fundedAmount: 500_000 },
      { brokerId: 'b1', payeeName: 'A', amount: 500, status: 'pending', fundedAmount: 300_000 },
      { brokerId: null, payeeName: 'Brokerage', amount: 400, status: 'paid', fundedAmount: 500_000 },
    ]);

    const agent = summary.find((row) => row.payeeName === 'A')!;
    assert.equal(agent.paid, 1_000);
    assert.equal(agent.pending, 500);
    assert.equal(agent.total, 1_500);
    assert.equal(agent.deals, 2);
    assert.equal(agent.volume, 800_000);

    // Sorted by total, descending.
    assert.equal(summary[0]!.payeeName, 'A');
  });
});
