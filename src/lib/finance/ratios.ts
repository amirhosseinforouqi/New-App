/**
 * GDS, TDS and LTV — the three ratios that decide whether a file is fundable.
 *
 * These are computed from data the broker or borrower has entered, NOT from a
 * credit bureau pull. Pulling a bureau requires an Equifax or TransUnion
 * membership, which is a regulated commercial relationship. When you have one,
 * the liabilities parsed from that report can be written into
 * `borrower_liabilities` and every ratio here recalculates with no change to
 * this module — that is the seam.
 *
 * Definitions used (standard Canadian underwriting):
 *
 *   GDS = (mortgage payment + property tax + heat + 50% of condo fees)
 *         ÷ gross monthly income
 *
 *   TDS = GDS numerator + all other monthly debt obligations
 *         ÷ gross monthly income
 *
 * Both are computed at the STRESS-TEST rate, not the contract rate, because
 * that is what a lender qualifies against. Showing a borrower a passing GDS
 * calculated at their actual rate is how a file gets declined after everyone
 * has celebrated.
 */

import { calculatePayment, qualifyingRate, type PaymentFrequency } from './mortgage';

/**
 * Conventional thresholds. Individual lenders vary — many will go to 39/44,
 * some insured programs stretch further with strong credit — so these are
 * guidance for the broker's eye, never a hard gate in the software.
 */
export const GDS_LIMIT = 39;
export const TDS_LIMIT = 44;

export interface IncomeSource {
  annualIncome: number;
  /** Two-year averaging applies to variable income, not salary. */
  employmentType?: string;
  priorYearIncome?: number | null;
}

export interface Liability {
  monthlyPayment: number;
  includeInTds?: boolean;
  payoutOnClosing?: boolean;
}

export interface RatioInput {
  mortgageAmount: number;
  annualRatePercent: number;
  amortizationYears: number;
  paymentFrequency?: PaymentFrequency;

  propertyValue: number;

  annualPropertyTax?: number | null;
  monthlyHeat?: number | null;
  monthlyCondoFees?: number | null;

  incomes: IncomeSource[];
  liabilities: Liability[];

  /** Rental income counted toward qualifying, already net of any offset. */
  monthlyRentalIncome?: number | null;

  /** Set false to compute at the contract rate (for "what you'll actually pay"). */
  useStressTest?: boolean;
}

export interface RatioResult {
  grossMonthlyIncome: number;
  qualifyingRatePercent: number;
  monthlyMortgagePayment: number;
  monthlyPropertyTax: number;
  monthlyHeat: number;
  /** Half of condo fees, per standard underwriting treatment. */
  condoFeesCounted: number;
  housingCosts: number;
  otherDebtPayments: number;
  gds: number;
  tds: number;
  ltv: number;
  gdsPasses: boolean;
  tdsPasses: boolean;
  /** Highest mortgage that keeps both ratios inside the limits. */
  maxMortgageByRatios: number;
  warnings: string[];
}

/**
 * Two-year averaging for variable income.
 *
 * Salaried and hourly income is taken at face value. Self-employed, commission
 * and bonus income is averaged across two years and — importantly — a decline
 * year is NOT averaged upward: lenders use the lower of the average and the
 * most recent year, because a falling trend is the risk they are pricing.
 */
export function qualifyingIncome(source: IncomeSource): number {
  const variable = ['self_employed', 'commission', 'bonus', 'seasonal'];
  const current = source.annualIncome || 0;

  if (!variable.includes(source.employmentType ?? '')) return current;
  if (source.priorYearIncome == null || source.priorYearIncome <= 0) return current;

  const average = (current + source.priorYearIncome) / 2;
  return Math.min(average, current);
}

export function calculateRatios(input: RatioInput): RatioResult {
  const warnings: string[] = [];

  const annualIncome = input.incomes.reduce((sum, source) => sum + qualifyingIncome(source), 0);
  const grossMonthlyIncome = annualIncome / 12 + (input.monthlyRentalIncome ?? 0);

  const useStressTest = input.useStressTest ?? true;
  const rate = useStressTest ? qualifyingRate(input.annualRatePercent) : input.annualRatePercent;

  const { monthlyEquivalent: monthlyMortgagePayment } = calculatePayment({
    principal: input.mortgageAmount,
    annualRatePercent: rate,
    amortizationYears: input.amortizationYears,
    frequency: input.paymentFrequency ?? 'monthly',
  });

  const monthlyPropertyTax = (input.annualPropertyTax ?? 0) / 12;
  const monthlyHeat = input.monthlyHeat ?? 0;
  const condoFeesCounted = (input.monthlyCondoFees ?? 0) * 0.5;

  const housingCosts = monthlyMortgagePayment + monthlyPropertyTax + monthlyHeat + condoFeesCounted;

  const otherDebtPayments = input.liabilities
    .filter((item) => (item.includeInTds ?? true) && !item.payoutOnClosing)
    .reduce((sum, item) => sum + (item.monthlyPayment || 0), 0);

  // Guard the divide: a file with no income entered yet must not render NaN%
  // or Infinity in the broker's UI.
  const gds = grossMonthlyIncome > 0 ? (housingCosts / grossMonthlyIncome) * 100 : 0;
  const tds = grossMonthlyIncome > 0 ? ((housingCosts + otherDebtPayments) / grossMonthlyIncome) * 100 : 0;
  const ltv = input.propertyValue > 0 ? (input.mortgageAmount / input.propertyValue) * 100 : 0;

  if (grossMonthlyIncome <= 0) warnings.push('No income recorded — ratios cannot be assessed.');
  if (input.propertyValue <= 0) warnings.push('No property value recorded — LTV cannot be assessed.');
  if (!input.annualPropertyTax) warnings.push('Property tax is missing; GDS is understated.');
  if (!input.monthlyHeat) warnings.push('Heating cost is missing; GDS is understated.');
  if (ltv > 95) warnings.push('LTV above 95% — no insurer will write this.');
  else if (ltv > 80) warnings.push('LTV above 80% — default insurance is required.');

  return {
    grossMonthlyIncome: round2(grossMonthlyIncome),
    qualifyingRatePercent: round2(rate),
    monthlyMortgagePayment: round2(monthlyMortgagePayment),
    monthlyPropertyTax: round2(monthlyPropertyTax),
    monthlyHeat: round2(monthlyHeat),
    condoFeesCounted: round2(condoFeesCounted),
    housingCosts: round2(housingCosts),
    otherDebtPayments: round2(otherDebtPayments),
    gds: round1(gds),
    tds: round1(tds),
    ltv: round1(ltv),
    gdsPasses: grossMonthlyIncome > 0 && gds <= GDS_LIMIT,
    tdsPasses: grossMonthlyIncome > 0 && tds <= TDS_LIMIT,
    maxMortgageByRatios: maxMortgage(input),
    warnings,
  };
}

/**
 * Largest mortgage that keeps GDS and TDS inside their limits.
 *
 * Solved by bisection rather than algebraically: the payment formula is not
 * cleanly invertible once fixed costs and the stress-test rate are involved,
 * and 60 iterations converges to well under a dollar while staying obviously
 * correct to anyone reading it.
 */
function maxMortgage(input: RatioInput): number {
  const annualIncome = input.incomes.reduce((sum, source) => sum + qualifyingIncome(source), 0);
  const grossMonthlyIncome = annualIncome / 12 + (input.monthlyRentalIncome ?? 0);
  if (grossMonthlyIncome <= 0) return 0;

  const rate = (input.useStressTest ?? true)
    ? qualifyingRate(input.annualRatePercent)
    : input.annualRatePercent;

  const fixedHousing =
    (input.annualPropertyTax ?? 0) / 12 + (input.monthlyHeat ?? 0) + (input.monthlyCondoFees ?? 0) * 0.5;

  const otherDebt = input.liabilities
    .filter((item) => (item.includeInTds ?? true) && !item.payoutOnClosing)
    .reduce((sum, item) => sum + (item.monthlyPayment || 0), 0);

  const gdsBudget = grossMonthlyIncome * (GDS_LIMIT / 100) - fixedHousing;
  const tdsBudget = grossMonthlyIncome * (TDS_LIMIT / 100) - fixedHousing - otherDebt;
  const paymentBudget = Math.min(gdsBudget, tdsBudget);

  if (paymentBudget <= 0) return 0;

  let low = 0;
  let high = 10_000_000;

  for (let i = 0; i < 60; i += 1) {
    const mid = (low + high) / 2;
    const { monthlyEquivalent } = calculatePayment({
      principal: mid,
      annualRatePercent: rate,
      amortizationYears: input.amortizationYears,
      frequency: input.paymentFrequency ?? 'monthly',
    });

    if (monthlyEquivalent > paymentBudget) high = mid;
    else low = mid;
  }

  return Math.floor(low);
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
