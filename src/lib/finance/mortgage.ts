/**
 * Canadian mortgage mathematics.
 *
 * The detail that matters most here, and that generic mortgage code almost
 * always gets wrong: **Canadian mortgages compound semi-annually, not
 * monthly.** This is not a convention, it is section 6 of the federal Interest
 * Act. Using the American monthly-compounding formula overstates the payment
 * by a small but very visible amount, and a broker quoting a payment that does
 * not match the lender's commitment letter loses the client's trust instantly.
 *
 * Every figure produced here is an ESTIMATE for advisory conversation. Lender
 * commitment letters are authoritative. Nothing in this module should be
 * presented to a borrower as a guaranteed number.
 */

export type PaymentFrequency =
  | 'monthly'
  | 'semi_monthly'
  | 'biweekly'
  | 'accelerated_biweekly'
  | 'weekly'
  | 'accelerated_weekly';

/** Payments per year for each frequency. */
export const PAYMENTS_PER_YEAR: Record<PaymentFrequency, number> = {
  monthly: 12,
  semi_monthly: 24,
  biweekly: 26,
  accelerated_biweekly: 26,
  weekly: 52,
  accelerated_weekly: 52,
};

/**
 * Convert a nominal annual rate, compounded semi-annually, into the effective
 * periodic rate for a given payment frequency.
 *
 *   effective annual = (1 + annual/2)^2 - 1
 *   periodic         = (1 + effective annual)^(1/periods) - 1
 */
export function periodicRate(annualRatePercent: number, paymentsPerYear: number): number {
  if (annualRatePercent <= 0) return 0;
  const semiAnnual = annualRatePercent / 100 / 2;
  const effectiveAnnual = (1 + semiAnnual) ** 2 - 1;
  return (1 + effectiveAnnual) ** (1 / paymentsPerYear) - 1;
}

export interface PaymentInput {
  principal: number;
  annualRatePercent: number;
  amortizationYears: number;
  frequency?: PaymentFrequency;
}

export interface PaymentResult {
  payment: number;
  paymentsPerYear: number;
  /** Normalised to a month, so GDS/TDS can use it directly. */
  monthlyEquivalent: number;
  totalPaid: number;
  totalInterest: number;
  numberOfPayments: number;
}

/**
 * Level payment for a fully-amortising mortgage.
 *
 * Accelerated frequencies are the monthly payment halved (biweekly) or
 * quartered (weekly) — which is why they pay the mortgage off faster: 26
 * half-payments is 13 monthly payments a year, not 12.
 */
export function calculatePayment(input: PaymentInput): PaymentResult {
  const frequency = input.frequency ?? 'monthly';
  const paymentsPerYear = PAYMENTS_PER_YEAR[frequency];
  const isAccelerated = frequency.startsWith('accelerated');

  if (input.principal <= 0 || input.amortizationYears <= 0) {
    return {
      payment: 0,
      paymentsPerYear,
      monthlyEquivalent: 0,
      totalPaid: 0,
      totalInterest: 0,
      numberOfPayments: 0,
    };
  }

  let payment: number;
  let numberOfPayments: number;

  if (isAccelerated) {
    const monthly = calculatePayment({ ...input, frequency: 'monthly' }).payment;
    payment = frequency === 'accelerated_biweekly' ? monthly / 2 : monthly / 4;
    // An accelerated schedule retires the balance early, so the payment count
    // is derived rather than assumed — see amortizationSchedule below.
    numberOfPayments = payoffPeriods(input.principal, payment, periodicRate(input.annualRatePercent, paymentsPerYear));
  } else {
    const rate = periodicRate(input.annualRatePercent, paymentsPerYear);
    numberOfPayments = Math.round(input.amortizationYears * paymentsPerYear);

    payment =
      rate === 0
        ? input.principal / numberOfPayments
        : (input.principal * rate) / (1 - (1 + rate) ** -numberOfPayments);
  }

  const totalPaid = payment * numberOfPayments;

  return {
    payment: round2(payment),
    paymentsPerYear,
    monthlyEquivalent: round2((payment * paymentsPerYear) / 12),
    totalPaid: round2(totalPaid),
    totalInterest: round2(totalPaid - input.principal),
    numberOfPayments,
  };
}

/** How many periods a fixed payment takes to clear a balance. */
function payoffPeriods(principal: number, payment: number, rate: number): number {
  if (rate === 0) return Math.ceil(principal / payment);
  // A payment that does not cover the interest never amortises.
  if (payment <= principal * rate) return Number.POSITIVE_INFINITY;
  return Math.ceil(-Math.log(1 - (principal * rate) / payment) / Math.log(1 + rate));
}

export interface AmortizationYear {
  year: number;
  principalPaid: number;
  interestPaid: number;
  endingBalance: number;
}

/**
 * Year-by-year principal and interest split.
 *
 * This is what makes "where does my money actually go" answerable — in year
 * one of a 25-year mortgage the great majority of each payment is interest,
 * which surprises most first-time buyers and is worth showing rather than
 * explaining.
 */
export function amortizationSchedule(input: PaymentInput, years?: number): AmortizationYear[] {
  const frequency = input.frequency ?? 'monthly';
  const paymentsPerYear = PAYMENTS_PER_YEAR[frequency];
  const rate = periodicRate(input.annualRatePercent, paymentsPerYear);
  const { payment } = calculatePayment(input);

  const schedule: AmortizationYear[] = [];
  let balance = input.principal;
  const maxYears = years ?? input.amortizationYears;

  for (let year = 1; year <= maxYears && balance > 0.01; year += 1) {
    let principalPaid = 0;
    let interestPaid = 0;

    for (let period = 0; period < paymentsPerYear && balance > 0.01; period += 1) {
      const interest = balance * rate;
      // The final payment is only what is left owing.
      const principal = Math.min(payment - interest, balance);
      balance -= principal;
      principalPaid += principal;
      interestPaid += interest;
    }

    schedule.push({
      year,
      principalPaid: round2(principalPaid),
      interestPaid: round2(interestPaid),
      endingBalance: round2(Math.max(balance, 0)),
    });
  }

  return schedule;
}

/**
 * CMHC-style default insurance premium.
 *
 * Required when the down payment is under 20%. Rates below are the standard
 * published tiers as of 2026 and are applied to the mortgage amount.
 *
 * ⚠️ Verify against the insurer's current schedule before quoting — these
 * change, and the app treats them as advisory estimates only.
 */
export function insurancePremiumRate(loanToValuePercent: number): number {
  if (loanToValuePercent <= 80) return 0;
  if (loanToValuePercent <= 85) return 2.8;
  if (loanToValuePercent <= 90) return 3.1;
  if (loanToValuePercent <= 95) return 4.0;
  // Above 95% LTV no insurer will write the policy — the deal does not qualify.
  return Number.NaN;
}

export interface InsuranceResult {
  required: boolean;
  /** NaN when the loan-to-value exceeds what any insurer will write. */
  premiumRate: number;
  premium: number;
  totalMortgage: number;
  qualifies: boolean;
}

export function calculateInsurance(purchasePrice: number, downPayment: number): InsuranceResult {
  const base = Math.max(purchasePrice - downPayment, 0);
  const ltv = purchasePrice > 0 ? (base / purchasePrice) * 100 : 0;
  const rate = insurancePremiumRate(ltv);

  if (Number.isNaN(rate)) {
    return { required: true, premiumRate: Number.NaN, premium: 0, totalMortgage: base, qualifies: false };
  }

  const premium = round2(base * (rate / 100));
  return {
    required: rate > 0,
    premiumRate: rate,
    premium,
    totalMortgage: round2(base + premium),
    qualifies: true,
  };
}

/**
 * Minimum down payment under Canadian rules:
 *   5% of the first $500,000, 10% of the portion between $500k and $1.5M,
 *   20% at $1.5M and above (no default insurance available).
 *
 * ⚠️ The $1.5M threshold and tier structure are policy settings that have
 * changed more than once. Confirm current rules before relying on this.
 */
export function minimumDownPayment(purchasePrice: number): number {
  if (purchasePrice <= 0) return 0;
  if (purchasePrice >= 1_500_000) return round2(purchasePrice * 0.2);
  if (purchasePrice <= 500_000) return round2(purchasePrice * 0.05);
  return round2(25_000 + (purchasePrice - 500_000) * 0.1);
}

/**
 * Stress-test qualifying rate: the greater of the contract rate plus two
 * points and the 5.25% floor. Borrowers must qualify at this rate, not the
 * rate they will actually pay.
 *
 * ⚠️ The floor is set by OSFI and has moved before. Verify before relying on it.
 */
export const STRESS_TEST_FLOOR = 5.25;

export function qualifyingRate(contractRatePercent: number): number {
  return Math.max(contractRatePercent + 2, STRESS_TEST_FLOOR);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
