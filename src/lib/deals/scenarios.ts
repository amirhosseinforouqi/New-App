/**
 * Saved product comparisons.
 *
 * A scenario is what the broker actually showed the borrower on a given day:
 * two or three products side by side with the payment, the interest over the
 * term and the balance they renew at.
 *
 * The reason this stores a snapshot rather than a list of product ids is that
 * rates move weekly. A scenario that re-derived its numbers from the current
 * product table would silently rewrite history — the borrower would open the
 * comparison they were emailed on Tuesday and find different figures, and
 * nobody could say what they had actually been quoted. So the numbers are
 * frozen at capture, and `driftFromCurrent` reports where the live table has
 * since moved rather than papering over it.
 *
 * Pure module: no database import, so the arithmetic is testable on its own.
 */

import type { ProductMatch } from '@/lib/lenders/matching';

export interface ScenarioOption {
  productId: string;
  lenderName: string;
  productName: string;
  rateType: string;
  termYears: number;
  postedRate: number;
  monthlyPayment: number;
  totalInterestOverTerm: number;
  balanceAtEndOfTerm: number;
  ltv: number;
  fits: boolean;
}

export interface ScenarioSnapshot {
  capturedAt: string;
  mortgageAmount: number;
  propertyValue: number;
  amortizationYears: number;
  options: ScenarioOption[];
}

export interface SavedScenario {
  id: string;
  name: string;
  createdAt: Date;
  snapshot: ScenarioSnapshot;
}

const round2 = (value: number) => Math.round(value * 100) / 100;

/** Freeze the selected matches into a snapshot. */
export function buildSnapshot(
  matches: ProductMatch[],
  productIds: string[],
  deal: { mortgageAmount: number; propertyValue: number; amortizationYears: number },
  capturedAt = new Date(),
): ScenarioSnapshot {
  // Ordered by the caller's selection, not by rank: the broker chose which to
  // put first and the comparison should keep that order.
  const options = productIds.flatMap((id) => {
    const match = matches.find((candidate) => candidate.product.id === id);
    if (!match) return [];

    return [
      {
        productId: match.product.id,
        lenderName: match.product.lenderName,
        productName: match.product.name,
        rateType: match.product.rateType,
        termYears: match.product.termYears,
        postedRate: match.product.postedRate,
        monthlyPayment: match.monthlyPayment,
        totalInterestOverTerm: match.totalInterestOverTerm,
        balanceAtEndOfTerm: match.balanceAtEndOfTerm,
        ltv: match.ltv,
        fits: match.fits,
      } satisfies ScenarioOption,
    ];
  });

  return {
    capturedAt: capturedAt.toISOString(),
    mortgageAmount: deal.mortgageAmount,
    propertyValue: deal.propertyValue,
    amortizationYears: deal.amortizationYears,
    options,
  };
}

export interface RateDrift {
  productId: string;
  lenderName: string;
  productName: string;
  quotedRate: number;
  currentRate: number | null;
  /** Positive when the product got more expensive since capture. */
  changePercent: number | null;
  /** The product is gone from the table, or retired. */
  unavailable: boolean;
}

/**
 * Where the live product table has moved since this scenario was captured.
 *
 * Returns an entry only for products that actually changed or disappeared, so
 * an empty array means "still accurate" and the UI can say so plainly.
 */
export function driftFromCurrent(
  snapshot: ScenarioSnapshot,
  current: Array<{ id: string; postedRate: number; isActive: boolean }>,
): RateDrift[] {
  const byId = new Map(current.map((product) => [product.id, product]));
  const drift: RateDrift[] = [];

  for (const option of snapshot.options) {
    const live = byId.get(option.productId);

    if (!live || !live.isActive) {
      drift.push({
        productId: option.productId,
        lenderName: option.lenderName,
        productName: option.productName,
        quotedRate: option.postedRate,
        currentRate: live?.postedRate ?? null,
        changePercent: null,
        unavailable: true,
      });
      continue;
    }

    if (Math.abs(live.postedRate - option.postedRate) > 0.0001) {
      drift.push({
        productId: option.productId,
        lenderName: option.lenderName,
        productName: option.productName,
        quotedRate: option.postedRate,
        currentRate: live.postedRate,
        changePercent: round2(live.postedRate - option.postedRate),
        unavailable: false,
      });
    }
  }

  return drift;
}

export interface ScenarioComparison {
  cheapestOverTerm: string | null;
  lowestPayment: string | null;
  /** What the cheapest saves against the most expensive, over the term. */
  spreadOverTerm: number;
  /**
   * The compared products do not all run for the same number of years, so the
   * cost figures cover different periods and cannot be ranked against each
   * other. `cheapestOverTerm` and `spreadOverTerm` are withheld when this is
   * true.
   */
  termsDiffer: boolean;
  /** The distinct term lengths present, ascending, for the explanation. */
  termYears: number[];
}

/**
 * The headline answers a borrower asks for — where they can honestly be given.
 *
 * "Cheapest" is cost over the term (interest paid plus the balance left to
 * renew) rather than the headline rate, for the same reason the matcher ranks
 * that way: a lower rate can leave a larger balance and cost more.
 *
 * That ranking is only valid between products that run for the SAME number of
 * years. A two-year term accrues two years of interest and a three-year term
 * three, so comparing the totals hands the win to the shorter term every time
 * — which is backwards, and a borrower shown "cheapest" on that basis has been
 * misled. Saying which is cheaper across different terms requires assuming a
 * renewal rate two years out, and nobody knows that number.
 *
 * So when the terms differ, no cheapest is declared. The table still shows
 * every figure; what is withheld is the claim that they are comparable.
 *
 * Lowest payment is reported regardless, and separately, because it is a real
 * per-month figure whatever the term — and because it is frequently a different
 * product, which a borrower choosing on cash flow deserves to be told.
 */
export function compareOptions(options: ScenarioOption[]): ScenarioComparison {
  if (options.length === 0) {
    return {
      cheapestOverTerm: null,
      lowestPayment: null,
      spreadOverTerm: 0,
      termsDiffer: false,
      termYears: [],
    };
  }

  const termYears = [...new Set(options.map((option) => option.termYears))].sort((a, b) => a - b);
  const termsDiffer = termYears.length > 1;

  const cost = (option: ScenarioOption) =>
    option.totalInterestOverTerm + option.balanceAtEndOfTerm;

  let cheapest = options[0]!;
  let dearest = options[0]!;
  let lowestPayment = options[0]!;

  for (const option of options) {
    if (cost(option) < cost(cheapest)) cheapest = option;
    if (cost(option) > cost(dearest)) dearest = option;
    if (option.monthlyPayment < lowestPayment.monthlyPayment) lowestPayment = option;
  }

  return {
    cheapestOverTerm: termsDiffer ? null : cheapest.productId,
    lowestPayment: lowestPayment.productId,
    spreadOverTerm: termsDiffer ? 0 : round2(cost(dearest) - cost(cheapest)),
    termsDiffer,
    termYears,
  };
}
