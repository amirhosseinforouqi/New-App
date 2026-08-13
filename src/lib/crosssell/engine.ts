/**
 * Cross-sell screening.
 *
 * Screening, deliberately — not selling. Each rule that fires produces a
 * suggestion for the BROKER, with the reason it fired, and nothing is ever sent
 * to the borrower automatically.
 *
 * That is not squeamishness. Creditor insurance and credit products are
 * regulated: an automated solicitation triggered by someone's financial data,
 * with no licensed human deciding it was appropriate, is the kind of thing that
 * ends a brokerage. The broker sees "this file qualifies for X because Y" and
 * decides whether to raise it.
 *
 * Rules are ordinary functions over the deal so they are readable and testable,
 * and each states its reasoning in words the broker can repeat to the client.
 */

export interface CrossSellContext {
  dealType: string;
  mortgageAmount: number | null;
  propertyValue: number | null;
  purchasePrice: number | null;
  downPayment: number | null;
  amortizationYears: number | null;
  maturityDate: string | null;
  occupancy: string | null;
  propertyType: string | null;
  isFirstTimeBuyer: boolean;
  hasCoBorrower: boolean;
  borrowerCount: number;
  employmentTypes: string[];
  totalMonthlyDebt: number;
  highInterestDebt: number;
  ltv: number | null;
  gds: number | null;
  tds: number | null;
}

export interface CrossSellSuggestion {
  productKey: string;
  label: string;
  rationale: string;
  /** Higher first. */
  priority: number;
}

type Rule = (deal: CrossSellContext) => CrossSellSuggestion | null;

const RULES: Rule[] = [
  // ── Creditor insurance ────────────────────────────────────────────────────
  (deal) =>
    deal.mortgageAmount && deal.mortgageAmount > 0
      ? {
          productKey: 'mortgage_protection',
          label: 'Mortgage Protection Plan',
          rationale:
            deal.hasCoBorrower
              ? `Two borrowers carrying $${Math.round(deal.mortgageAmount).toLocaleString('en-CA')}. If either income stops, the other carries the whole payment — worth putting the numbers in front of them.`
              : `A single borrower carrying $${Math.round(deal.mortgageAmount).toLocaleString('en-CA')} with no second income behind it.`,
          priority: deal.hasCoBorrower ? 60 : 80,
        }
      : null,

  // ── Debt consolidation ────────────────────────────────────────────────────
  (deal) => {
    if (deal.highInterestDebt < 10_000) return null;
    if (deal.ltv != null && deal.ltv > 78) return null; // No room to consolidate into.

    return {
      productKey: 'debt_consolidation',
      label: 'Debt consolidation',
      rationale:
        `$${Math.round(deal.highInterestDebt).toLocaleString('en-CA')} of high-interest debt against ` +
        `${deal.ltv != null ? `${deal.ltv}% LTV` : 'available equity'}. Rolling it into the mortgage ` +
        'would cut the monthly obligation, though it stretches the term — show them both figures.',
      priority: 85,
    };
  },

  // ── First-time buyer programs ─────────────────────────────────────────────
  (deal) =>
    deal.isFirstTimeBuyer && deal.dealType === 'purchase'
      ? {
          productKey: 'ftb_programs',
          label: 'First-time buyer programs',
          rationale:
            'Land transfer tax rebate, the Home Buyers’ Plan and the First Home Savings Account. ' +
            'Each has its own paperwork and deadlines — easy money left behind if nobody mentions it.',
          priority: 70,
        }
      : null,

  // ── Renewal ───────────────────────────────────────────────────────────────
  (deal) => {
    if (!deal.maturityDate) return null;

    const maturity = new Date(deal.maturityDate);
    if (Number.isNaN(maturity.getTime())) return null;

    const daysAway = Math.round((maturity.getTime() - Date.now()) / 86_400_000);
    if (daysAway > 180 || daysAway < -30) return null;

    return {
      productKey: 'renewal',
      label: daysAway < 0 ? 'Overdue renewal' : 'Renewal approaching',
      rationale:
        daysAway < 0
          ? `Matured ${Math.abs(daysAway)} days ago. They may have rolled onto the lender's posted rate.`
          : `Matures in ${daysAway} days. The window to shop it without a penalty is now.`,
      priority: daysAway < 0 ? 95 : 90,
    };
  },

  // ── Rental / investment ───────────────────────────────────────────────────
  (deal) =>
    deal.occupancy === 'rental'
      ? {
          productKey: 'landlord_insurance',
          label: 'Landlord insurance referral',
          rationale:
            'A rental property needs landlord cover, not a homeowner policy. Lenders ask for proof ' +
            'before funding and a homeowner policy will be refused.',
          priority: 50,
        }
      : null,

  // ── Self-employed ─────────────────────────────────────────────────────────
  (deal) =>
    deal.employmentTypes.includes('self_employed')
      ? {
          productKey: 'self_employed_planning',
          label: 'Accountant referral',
          rationale:
            'Self-employed income is averaged over two years, so how the next return is written ' +
            'directly changes what they qualify for. Worth a conversation before year-end, not after.',
          priority: 55,
        }
      : null,

  // ── Nearly at 20% down ────────────────────────────────────────────────────
  (deal) => {
    if (deal.dealType !== 'purchase') return null;
    if (!deal.purchasePrice || !deal.downPayment) return null;

    const percent = (deal.downPayment / deal.purchasePrice) * 100;
    if (percent >= 20 || percent < 15) return null;

    const needed = deal.purchasePrice * 0.2 - deal.downPayment;

    return {
      productKey: 'reach_twenty_percent',
      label: 'Close to 20% down',
      rationale:
        `Down payment is ${percent.toFixed(1)}%. Another $${Math.round(needed).toLocaleString('en-CA')} ` +
        'clears 20% and removes the default insurance premium entirely — often the single biggest ' +
        'saving available on the file.',
      priority: 88,
    };
  },

  // ── Long amortization ─────────────────────────────────────────────────────
  (deal) =>
    deal.amortizationYears && deal.amortizationYears >= 30
      ? {
          productKey: 'amortization_review',
          label: 'Amortization review',
          rationale:
            `${deal.amortizationYears} years. Worth showing them the lifetime interest against 25 ` +
            'years so the choice is made with the number in front of them.',
          priority: 40,
        }
      : null,
];

export function screenForCrossSell(deal: CrossSellContext): CrossSellSuggestion[] {
  return RULES.map((rule) => rule(deal))
    .filter((suggestion): suggestion is CrossSellSuggestion => suggestion !== null)
    .sort((a, b) => b.priority - a.priority);
}

/** Human labels for the stored `product_key`. */
export const PRODUCT_LABELS: Record<string, string> = {
  mortgage_protection: 'Mortgage Protection Plan',
  debt_consolidation: 'Debt consolidation',
  ftb_programs: 'First-time buyer programs',
  renewal: 'Renewal',
  landlord_insurance: 'Landlord insurance',
  self_employed_planning: 'Accountant referral',
  reach_twenty_percent: 'Close to 20% down',
  amortization_review: 'Amortization review',
};
