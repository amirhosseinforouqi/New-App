/**
 * Matching a deal against lender products.
 *
 * A word about what this is and is not. Lender Spotlight and its equivalents
 * sell access to a maintained database of several thousand Canadian lender
 * policies; that is a paid data subscription and a commercial relationship,
 * not something that can be conjured. What lives here is the ENGINE: the rules
 * that decide whether a given file fits a given product, the comparison, and
 * the ranking.
 *
 * The brokerage maintains its own product table (`lender_products`), which is
 * genuinely useful on its own — most brokers work with a few dozen products
 * they know well. If a licensed feed is bought later it imports into the same
 * table and nothing here changes.
 *
 * The important design decision: a product that does not fit is not hidden. It
 * is returned with the specific reasons it failed. "No products match" is
 * useless to a broker; "three lenders would take this if the amortization came
 * down to 25 years" is the actual job.
 */

import { calculatePayment, qualifyingRate, type PaymentFrequency } from '@/lib/finance/mortgage';
import { calculateRatios, type RatioResult } from '@/lib/finance/ratios';

export interface LenderProduct {
  id: string;
  lenderId: string;
  lenderName: string;
  name: string;
  rateType: string;
  termYears: number;
  postedRate: number;
  minCreditScore: number | null;
  maxLtv: number | null;
  maxGds: number | null;
  maxTds: number | null;
  maxAmortization: number | null;
  minLoanAmount: number | null;
  maxLoanAmount: number | null;
  allowsInsured: boolean;
  allowsUninsured: boolean;
  allowsRental: boolean;
  allowsSelfEmployed: boolean;
  allowedProvinces: string[] | null;
  allowedDealTypes: string[] | null;
  notes: string | null;
}

export interface DealProfile {
  mortgageAmount: number;
  propertyValue: number;
  amortizationYears: number;
  paymentFrequency?: PaymentFrequency;
  dealType: string;
  province: string | null;
  occupancy: string | null;
  creditScore: number | null;
  isSelfEmployed: boolean;
  ratios: RatioResult | null;
}

export interface MatchFailure {
  rule: string;
  detail: string;
  /** True when the broker could plausibly change this. */
  actionable: boolean;
}

export interface ProductMatch {
  product: LenderProduct;
  fits: boolean;
  failures: MatchFailure[];
  monthlyPayment: number;
  totalInterestOverTerm: number;
  balanceAtEndOfTerm: number;
  ltv: number;
}

const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * Evaluate one product against one file.
 *
 * Every rule is skipped when the product leaves it null — a null is "no
 * constraint", not "zero". Getting that backwards would exclude every borrower
 * from any product whose minimum credit score was simply never filled in.
 */
export function matchProduct(product: LenderProduct, deal: DealProfile): ProductMatch {
  const failures: MatchFailure[] = [];

  const ltv = deal.propertyValue > 0 ? (deal.mortgageAmount / deal.propertyValue) * 100 : 0;
  const insured = ltv > 80;

  if (product.maxLtv != null && ltv > product.maxLtv) {
    failures.push({
      rule: 'ltv',
      detail: `LTV is ${round2(ltv)}%, over this lender's ${product.maxLtv}% ceiling. A larger down payment would fix it.`,
      actionable: true,
    });
  }

  if (insured && !product.allowsInsured) {
    failures.push({
      rule: 'insured',
      detail: 'This lender does not take insured (high-ratio) files.',
      actionable: false,
    });
  }

  if (!insured && !product.allowsUninsured) {
    failures.push({
      rule: 'uninsured',
      detail: 'This lender only takes insured files.',
      actionable: false,
    });
  }

  if (product.minCreditScore != null) {
    if (deal.creditScore == null) {
      failures.push({
        rule: 'credit_unknown',
        detail: `Needs a credit score of ${product.minCreditScore}+, and none is recorded on this file yet.`,
        actionable: true,
      });
    } else if (deal.creditScore < product.minCreditScore) {
      failures.push({
        rule: 'credit',
        detail: `Credit score ${deal.creditScore} is below this lender's ${product.minCreditScore} minimum.`,
        actionable: false,
      });
    }
  }

  if (product.maxAmortization != null && deal.amortizationYears > product.maxAmortization) {
    failures.push({
      rule: 'amortization',
      detail: `Amortization of ${deal.amortizationYears} years exceeds this lender's ${product.maxAmortization}. Shortening it would fix this, at a higher payment.`,
      actionable: true,
    });
  }

  if (product.minLoanAmount != null && deal.mortgageAmount < product.minLoanAmount) {
    failures.push({
      rule: 'min_amount',
      detail: `Below this lender's $${product.minLoanAmount.toLocaleString('en-CA')} minimum.`,
      actionable: false,
    });
  }

  if (product.maxLoanAmount != null && deal.mortgageAmount > product.maxLoanAmount) {
    failures.push({
      rule: 'max_amount',
      detail: `Above this lender's $${product.maxLoanAmount.toLocaleString('en-CA')} maximum.`,
      actionable: false,
    });
  }

  if (deal.ratios) {
    if (product.maxGds != null && deal.ratios.gds > product.maxGds) {
      failures.push({
        rule: 'gds',
        detail: `GDS of ${deal.ratios.gds}% is over this lender's ${product.maxGds}% limit.`,
        actionable: true,
      });
    }
    if (product.maxTds != null && deal.ratios.tds > product.maxTds) {
      failures.push({
        rule: 'tds',
        detail: `TDS of ${deal.ratios.tds}% is over this lender's ${product.maxTds}% limit. Paying out a debt on closing may bring it inside.`,
        actionable: true,
      });
    }
  }

  if (deal.occupancy === 'rental' && !product.allowsRental) {
    failures.push({
      rule: 'rental',
      detail: 'This lender does not take rental or investment properties.',
      actionable: false,
    });
  }

  if (deal.isSelfEmployed && !product.allowsSelfEmployed) {
    failures.push({
      rule: 'self_employed',
      detail: 'This lender does not take self-employed income.',
      actionable: false,
    });
  }

  if (
    product.allowedProvinces &&
    product.allowedProvinces.length > 0 &&
    deal.province &&
    !product.allowedProvinces.includes(deal.province)
  ) {
    failures.push({
      rule: 'province',
      detail: `This lender does not lend in ${deal.province}.`,
      actionable: false,
    });
  }

  if (
    product.allowedDealTypes &&
    product.allowedDealTypes.length > 0 &&
    !product.allowedDealTypes.includes(deal.dealType)
  ) {
    failures.push({
      rule: 'deal_type',
      detail: `This lender does not do ${deal.dealType.replace(/_/g, ' ')} deals.`,
      actionable: false,
    });
  }

  const payment = calculatePayment({
    principal: deal.mortgageAmount,
    annualRatePercent: product.postedRate,
    amortizationYears: deal.amortizationYears,
    frequency: deal.paymentFrequency ?? 'monthly',
  });

  const term = termCost(deal.mortgageAmount, product.postedRate, deal.amortizationYears, product.termYears);

  return {
    product,
    fits: failures.length === 0,
    failures,
    monthlyPayment: round2(payment.monthlyEquivalent),
    totalInterestOverTerm: term.interest,
    balanceAtEndOfTerm: term.balance,
    ltv: round2(ltv),
  };
}

/**
 * Interest paid and balance remaining at the end of the TERM, not the
 * amortization.
 *
 * This is the number that actually matters when comparing products: nobody
 * holds a 25-year amortization at one rate. A five-year term at 4.79% versus
 * one at 4.99% differs by the interest paid over those five years and the
 * balance you renew at, and comparing lifetime interest instead — as most
 * calculators do — compares a fiction.
 */
function termCost(
  principal: number,
  annualRatePercent: number,
  amortizationYears: number,
  termYears: number,
): { interest: number; balance: number } {
  if (principal <= 0) return { interest: 0, balance: 0 };

  const { payment } = calculatePayment({
    principal,
    annualRatePercent,
    amortizationYears,
    frequency: 'monthly',
  });

  // Semi-annual compounding converted to a monthly periodic rate, same as the
  // payment itself — see lib/finance/mortgage.
  const periodic =
    annualRatePercent === 0
      ? 0
      : Math.pow(Math.pow(1 + annualRatePercent / 100 / 2, 2), 1 / 12) - 1;

  let balance = principal;
  let interest = 0;

  for (let month = 0; month < Math.round(termYears * 12); month += 1) {
    const monthInterest = balance * periodic;
    interest += monthInterest;
    balance = balance + monthInterest - payment;
    if (balance <= 0) {
      balance = 0;
      break;
    }
  }

  return { interest: round2(interest), balance: round2(balance) };
}

export interface MatchOptions {
  /** Include products that do not fit, with their reasons. Default true. */
  includeFailures?: boolean;
}

/**
 * Rank products for a file.
 *
 * Fitting products first, then by cost over the term — not by headline rate.
 * A lower rate with a shorter term can easily cost more once the renewal
 * balance is accounted for, and ranking by the advertised number is how a
 * borrower ends up in the wrong product.
 */
export function rankProducts(
  products: LenderProduct[],
  deal: DealProfile,
  options: MatchOptions = {},
): ProductMatch[] {
  const matches = products.map((product) => matchProduct(product, deal));
  const includeFailures = options.includeFailures ?? true;

  const visible = includeFailures ? matches : matches.filter((match) => match.fits);

  return visible.sort((a, b) => {
    if (a.fits !== b.fits) return a.fits ? -1 : 1;
    const costA = a.totalInterestOverTerm + a.balanceAtEndOfTerm;
    const costB = b.totalInterestOverTerm + b.balanceAtEndOfTerm;
    return costA - costB;
  });
}

/** Build the profile the matcher needs from what the deal page already has. */
export function dealProfile(input: {
  mortgageAmount: number | null;
  propertyValue: number | null;
  amortizationYears: number | null;
  dealType: string;
  province: string | null;
  occupancy: string | null;
  creditScore?: number | null;
  employmentTypes: string[];
  ratios: RatioResult | null;
}): DealProfile {
  return {
    mortgageAmount: input.mortgageAmount ?? 0,
    propertyValue: input.propertyValue ?? 0,
    amortizationYears: input.amortizationYears ?? 25,
    dealType: input.dealType,
    province: input.province,
    occupancy: input.occupancy,
    creditScore: input.creditScore ?? null,
    isSelfEmployed: input.employmentTypes.some((type) =>
      ['self_employed', 'commission', 'contract'].includes(type),
    ),
    ratios: input.ratios,
  };
}

/** The stress-test rate a file must qualify at, for display alongside matches. */
export function productQualifyingRate(product: LenderProduct): number {
  return qualifyingRate(product.postedRate);
}

/** Recompute ratios at a specific product's rate, for the comparison table. */
export function ratiosAtProduct(
  product: LenderProduct,
  base: Parameters<typeof calculateRatios>[0],
): RatioResult {
  return calculateRatios({ ...base, annualRatePercent: product.postedRate });
}
