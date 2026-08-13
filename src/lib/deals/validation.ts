/**
 * Is this file fit to send to a lender?
 *
 * Rules are data, evaluated against a snapshot of the deal. Two severities:
 *
 *   blocking — the submission button is disabled. Reserved for things a lender
 *              will bounce the file for outright.
 *   warning  — shown, but the broker may proceed. Their judgement, not the
 *              software's.
 *
 * The distinction matters. Software that blocks on everything it dislikes gets
 * worked around within a week, and then the genuinely blocking checks are
 * ignored too. Only make it blocking if the file truly cannot go.
 */

import type { RatioResult } from '@/lib/finance/ratios';

export type Severity = 'blocking' | 'warning';

export interface ValidationIssue {
  key: string;
  severity: Severity;
  message: string;
  /** Where to go to fix it. */
  field?: string;
}

export interface SubmissionSnapshot {
  dealType: string;
  mortgageAmount: number | null;
  propertyValue: number | null;
  purchasePrice: number | null;
  downPayment: number | null;
  amortizationYears: number | null;
  propertyProvince: string | null;
  propertyAddress: string | null;
  annualPropertyTax: number | null;
  monthlyHeat: number | null;

  borrowerCount: number;
  incomeCount: number;
  ratios: RatioResult | null;

  /** Required checklist items still outstanding. */
  outstandingDocuments: string[];
  /** Compliance items not yet completed. */
  outstandingCompliance: string[];
  /** True once FINTRAC identity verification is recorded for every borrower. */
  allBorrowersIdentified: boolean;
  /** True once every borrower has signed the consent to pull credit. */
  allConsentsSigned: boolean;

  downPaymentVerified: boolean;
  downPaymentFlags: number;
}

export interface SubmissionReadiness {
  ready: boolean;
  issues: ValidationIssue[];
  blocking: ValidationIssue[];
  warnings: ValidationIssue[];
  /** 0–100, for a progress indicator. Blocking issues weigh double. */
  completeness: number;
}

const CHECKS: Array<(deal: SubmissionSnapshot) => ValidationIssue | null> = [
  (deal) =>
    deal.mortgageAmount && deal.mortgageAmount > 0
      ? null
      : {
          key: 'mortgage_amount',
          severity: 'blocking',
          message: 'No mortgage amount on the file.',
          field: 'mortgageAmount',
        },

  (deal) =>
    deal.propertyValue && deal.propertyValue > 0
      ? null
      : {
          key: 'property_value',
          severity: 'blocking',
          message: 'No property value. Every lender prices against it.',
          field: 'propertyValue',
        },

  (deal) =>
    deal.incomeCount > 0
      ? null
      : {
          key: 'income',
          severity: 'blocking',
          message: 'No income recorded, so the file cannot be assessed.',
          field: 'income',
        },

  (deal) =>
    deal.borrowerCount > 0
      ? null
      : { key: 'borrowers', severity: 'blocking', message: 'No borrower on the deal.' },

  (deal) =>
    deal.allBorrowersIdentified
      ? null
      : {
          key: 'fintrac_id',
          severity: 'blocking',
          message:
            'FINTRAC identity verification is not recorded for every borrower. This is a legal ' +
            'record-keeping obligation, not a preference.',
          field: 'compliance',
        },

  (deal) =>
    deal.allConsentsSigned
      ? null
      : {
          key: 'consent',
          severity: 'blocking',
          message: 'Not every borrower has signed the credit-pull consent.',
          field: 'consents',
        },

  (deal) =>
    deal.outstandingDocuments.length === 0
      ? null
      : {
          key: 'documents',
          severity: 'blocking',
          message: `${deal.outstandingDocuments.length} required document${
            deal.outstandingDocuments.length === 1 ? ' is' : 's are'
          } still outstanding: ${deal.outstandingDocuments.slice(0, 3).join(', ')}${
            deal.outstandingDocuments.length > 3 ? '…' : ''
          }`,
          field: 'documents',
        },

  (deal) =>
    deal.outstandingCompliance.length === 0
      ? null
      : {
          key: 'compliance',
          severity: 'blocking',
          message: `${deal.outstandingCompliance.length} compliance item${
            deal.outstandingCompliance.length === 1 ? '' : 's'
          } outstanding.`,
          field: 'compliance',
        },

  // ── Warnings ──────────────────────────────────────────────────────────────
  (deal) =>
    deal.ratios == null || deal.ratios.gdsPasses
      ? null
      : {
          key: 'gds',
          severity: 'warning',
          message: `GDS is ${deal.ratios.gds}%, over the conventional 39% limit. Some lenders will still look at it.`,
        },

  (deal) =>
    deal.ratios == null || deal.ratios.tdsPasses
      ? null
      : {
          key: 'tds',
          severity: 'warning',
          message: `TDS is ${deal.ratios.tds}%, over the conventional 44% limit.`,
        },

  (deal) =>
    deal.annualPropertyTax
      ? null
      : {
          key: 'property_tax',
          severity: 'warning',
          message: 'No property tax recorded, so GDS is understated.',
          field: 'annualPropertyTax',
        },

  (deal) =>
    deal.monthlyHeat
      ? null
      : {
          key: 'heat',
          severity: 'warning',
          message: 'No heating cost recorded, so GDS is understated.',
          field: 'monthlyHeat',
        },

  (deal) =>
    deal.dealType !== 'purchase' || deal.propertyAddress
      ? null
      : {
          key: 'address',
          severity: 'warning',
          message: 'No property address. Most lenders need one before a firm approval.',
          field: 'propertyAddress',
        },

  (deal) =>
    deal.downPaymentVerified || deal.dealType !== 'purchase'
      ? null
      : {
          key: 'down_payment',
          severity: 'warning',
          message:
            'Down payment source is not verified. Lenders require a 90-day history of the funds.',
          field: 'downPayment',
        },

  (deal) =>
    deal.downPaymentFlags === 0
      ? null
      : {
          key: 'down_payment_flags',
          severity: 'warning',
          message: `${deal.downPaymentFlags} deposit${
            deal.downPaymentFlags === 1 ? '' : 's'
          } flagged as needing an explanation.`,
          field: 'downPayment',
        },
];

export function evaluateSubmission(deal: SubmissionSnapshot): SubmissionReadiness {
  const issues = CHECKS.map((check) => check(deal)).filter(
    (issue): issue is ValidationIssue => issue !== null,
  );

  const blocking = issues.filter((issue) => issue.severity === 'blocking');
  const warnings = issues.filter((issue) => issue.severity === 'warning');

  // Blocking issues weigh double so the bar reflects how far there is to go,
  // not merely how many boxes are unticked.
  const totalWeight = CHECKS.length + blocking.length;
  const penalty = blocking.length * 2 + warnings.length;
  const completeness = Math.max(0, Math.round(((totalWeight - penalty) / totalWeight) * 100));

  return {
    ready: blocking.length === 0,
    issues,
    blocking,
    warnings,
    completeness,
  };
}
