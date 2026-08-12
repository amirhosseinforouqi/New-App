/**
 * Canadian land transfer tax.
 *
 * ⚠️ TAX RATES CHANGE. Every rate and rebate ceiling in this file is a
 * published statutory figure as of 2026, gathered in one table so it can be
 * reviewed in one place. Verify against the province's current schedule before
 * a client relies on a number. The UI labels these as estimates.
 *
 * Coverage is deliberate rather than exhaustive: Ontario (plus Toronto's
 * municipal tax) and British Columbia are implemented because between them they
 * cover most of the transaction volume a Canadian brokerage sees, and both have
 * genuinely complicated bracket structures worth getting right. Provinces
 * without an implementation return `supported: false` rather than a wrong
 * number — silently returning 0 for Alberta, where there is no LTT but there
 * ARE registration fees, would be its own kind of misleading.
 */

export type Province =
  | 'AB' | 'BC' | 'MB' | 'NB' | 'NL' | 'NS' | 'NT' | 'NU' | 'ON' | 'PE' | 'QC' | 'SK' | 'YT';

export interface Bracket {
  /** Upper bound of this bracket. Infinity for the top one. */
  upTo: number;
  rate: number;
}

/** Ontario provincial LTT, one/two-family residential. */
const ONTARIO_BRACKETS: Bracket[] = [
  { upTo: 55_000, rate: 0.005 },
  { upTo: 250_000, rate: 0.01 },
  { upTo: 400_000, rate: 0.015 },
  { upTo: 2_000_000, rate: 0.02 },
  { upTo: Number.POSITIVE_INFINITY, rate: 0.025 },
];

/** Toronto municipal LTT — charged in addition to the provincial tax. */
const TORONTO_BRACKETS: Bracket[] = [
  { upTo: 55_000, rate: 0.005 },
  { upTo: 250_000, rate: 0.01 },
  { upTo: 400_000, rate: 0.015 },
  { upTo: 2_000_000, rate: 0.02 },
  { upTo: 3_000_000, rate: 0.025 },
  { upTo: 4_000_000, rate: 0.035 },
  { upTo: 5_000_000, rate: 0.045 },
  { upTo: 10_000_000, rate: 0.055 },
  { upTo: 20_000_000, rate: 0.065 },
  { upTo: Number.POSITIVE_INFINITY, rate: 0.075 },
];

/** British Columbia Property Transfer Tax, residential. */
const BC_BRACKETS: Bracket[] = [
  { upTo: 200_000, rate: 0.01 },
  { upTo: 2_000_000, rate: 0.02 },
  { upTo: 3_000_000, rate: 0.03 },
  { upTo: Number.POSITIVE_INFINITY, rate: 0.05 },
];

const ONTARIO_FTB_MAX_REBATE = 4_000;
const TORONTO_FTB_MAX_REBATE = 4_475;
/** BC exempts first-time buyers fully below this, phasing out above it. */
const BC_FTB_FULL_EXEMPTION = 500_000;
const BC_FTB_PHASE_OUT_END = 835_000;

function applyBrackets(price: number, brackets: Bracket[]): number {
  let tax = 0;
  let previousCeiling = 0;

  for (const bracket of brackets) {
    if (price <= previousCeiling) break;
    const taxableInBracket = Math.min(price, bracket.upTo) - previousCeiling;
    tax += taxableInBracket * bracket.rate;
    previousCeiling = bracket.upTo;
  }

  return Math.round(tax * 100) / 100;
}

export interface LandTransferTaxInput {
  purchasePrice: number;
  province: Province;
  /** Toronto charges a second, municipal LTT on top of Ontario's. */
  city?: string;
  isFirstTimeBuyer?: boolean;
}

export interface LandTransferTaxResult {
  supported: boolean;
  provincialTax: number;
  municipalTax: number;
  provincialRebate: number;
  municipalRebate: number;
  totalTax: number;
  note: string;
}

export function calculateLandTransferTax(input: LandTransferTaxInput): LandTransferTaxResult {
  const price = Math.max(input.purchasePrice, 0);
  const isToronto = (input.city ?? '').trim().toLowerCase() === 'toronto';
  const ftb = input.isFirstTimeBuyer ?? false;

  const empty: LandTransferTaxResult = {
    supported: false,
    provincialTax: 0,
    municipalTax: 0,
    provincialRebate: 0,
    municipalRebate: 0,
    totalTax: 0,
    note: '',
  };

  switch (input.province) {
    case 'ON': {
      const provincialTax = applyBrackets(price, ONTARIO_BRACKETS);
      const municipalTax = isToronto ? applyBrackets(price, TORONTO_BRACKETS) : 0;

      const provincialRebate = ftb ? Math.min(provincialTax, ONTARIO_FTB_MAX_REBATE) : 0;
      const municipalRebate = ftb && isToronto ? Math.min(municipalTax, TORONTO_FTB_MAX_REBATE) : 0;

      return {
        supported: true,
        provincialTax,
        municipalTax,
        provincialRebate,
        municipalRebate,
        totalTax: round2(provincialTax + municipalTax - provincialRebate - municipalRebate),
        note: isToronto
          ? 'Ontario LTT plus Toronto municipal LTT. Estimate only — confirm with your lawyer.'
          : 'Ontario LTT. Estimate only — confirm with your lawyer.',
      };
    }

    case 'BC': {
      const provincialTax = applyBrackets(price, BC_BRACKETS);
      let provincialRebate = 0;

      if (ftb) {
        if (price <= BC_FTB_FULL_EXEMPTION) {
          provincialRebate = provincialTax;
        } else if (price < BC_FTB_PHASE_OUT_END) {
          // Straight-line phase-out across the band.
          const remaining = (BC_FTB_PHASE_OUT_END - price) / (BC_FTB_PHASE_OUT_END - BC_FTB_FULL_EXEMPTION);
          provincialRebate = round2(provincialTax * remaining);
        }
      }

      return {
        supported: true,
        provincialTax,
        municipalTax: 0,
        provincialRebate,
        municipalRebate: 0,
        totalTax: round2(provincialTax - provincialRebate),
        note: 'BC Property Transfer Tax. Estimate only — confirm with your lawyer.',
      };
    }

    case 'AB':
    case 'SK':
      return {
        ...empty,
        supported: true,
        note:
          'No land transfer tax in this province. Land title registration and mortgage ' +
          'registration fees still apply — ask your lawyer for the amount.',
      };

    default:
      return {
        ...empty,
        note:
          `Land transfer tax for ${input.province} is not calculated here. ` +
          'Ask your lawyer for the amount, or check the provincial schedule.',
      };
  }
}

/**
 * Rough all-in closing cost estimate.
 *
 * Legal fees and title insurance are broad averages, not quotes. The purpose is
 * to stop a first-time buyer being blindsided at closing by costs nobody
 * mentioned — precision is less important than the number not being zero.
 */
export interface ClosingCostInput extends LandTransferTaxInput {
  legalFees?: number;
  titleInsurance?: number;
  homeInspection?: number;
  appraisal?: number;
}

export function estimateClosingCosts(input: ClosingCostInput) {
  const ltt = calculateLandTransferTax(input);

  const legalFees = input.legalFees ?? 1_800;
  const titleInsurance = input.titleInsurance ?? 400;
  const homeInspection = input.homeInspection ?? 500;
  const appraisal = input.appraisal ?? 400;

  return {
    landTransferTax: ltt.totalTax,
    landTransferTaxSupported: ltt.supported,
    legalFees,
    titleInsurance,
    homeInspection,
    appraisal,
    total: round2(ltt.totalTax + legalFees + titleInsurance + homeInspection + appraisal),
    note: ltt.note,
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
