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
 *
 * ── On configurability ──────────────────────────────────────────────────────
 *
 * Brokerages differ on where the bar sits, so severity and on/off are
 * adjustable per rule and stored in `validation_rules`.
 *
 * Two rules are LOCKED and cannot be softened or disabled: FINTRAC identity
 * verification and the borrower's signed consent to pull credit. Those are
 * obligations under the PCMLTFA and privacy law respectively — not house
 * style. A settings screen that let someone switch them off would be a
 * compliance-evasion feature with a nice UI, so `applyOverrides` ignores any
 * override against them and the API refuses to store one. Nothing here is
 * legal advice; it is a refusal to build the off switch.
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

/** What a brokerage may change about a rule. */
export interface RuleOverride {
  severity?: Severity;
  enabled?: boolean;
}

export interface RuleDefinition {
  key: string;
  /** Short name for the settings screen. */
  label: string;
  defaultSeverity: Severity;
  /** A legal obligation. Severity and on/off are not the brokerage's to set. */
  locked?: boolean;
  /** Why it is locked, shown in place of the controls. */
  lockedReason?: string;
  check: (deal: SubmissionSnapshot) => ValidationIssue | null;
}


/**
 * Every rule, in the order they are shown.
 *
 * `defaultSeverity` is the out-of-the-box setting; a brokerage may move an
 * unlocked rule either way or switch it off entirely.
 */
export const RULES: RuleDefinition[] = [
  {
    key: 'mortgage_amount',
    label: 'Mortgage amount present',
    defaultSeverity: 'blocking',
    check: (deal) =>
      deal.mortgageAmount && deal.mortgageAmount > 0
        ? null
        : {
            key: 'mortgage_amount',
            severity: 'blocking',
            message: 'No mortgage amount on the file.',
            field: 'mortgageAmount',
          },
  },

  {
    key: 'property_value',
    label: 'Property value present',
    defaultSeverity: 'blocking',
    check: (deal) =>
      deal.propertyValue && deal.propertyValue > 0
        ? null
        : {
            key: 'property_value',
            severity: 'blocking',
            message: 'No property value. Every lender prices against it.',
            field: 'propertyValue',
          },
  },

  {
    key: 'income',
    label: 'Income recorded',
    defaultSeverity: 'blocking',
    check: (deal) =>
      deal.incomeCount > 0
        ? null
        : {
            key: 'income',
            severity: 'blocking',
            message: 'No income recorded, so the file cannot be assessed.',
            field: 'income',
          },
  },

  {
    key: 'borrowers',
    label: 'At least one borrower',
    defaultSeverity: 'blocking',
    check: (deal) =>
      deal.borrowerCount > 0
        ? null
        : { key: 'borrowers', severity: 'blocking', message: 'No borrower on the deal.' },
  },

  {
    key: 'fintrac_id',
    label: 'FINTRAC identity verification',
    defaultSeverity: 'blocking',
    locked: true,
    lockedReason:
      'Verifying and recording borrower identity is an obligation under the PCMLTFA, not a ' +
      'brokerage preference. It cannot be downgraded or switched off here.',
    check: (deal) =>
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
  },

  {
    key: 'consent',
    label: 'Signed credit-pull consent',
    defaultSeverity: 'blocking',
    locked: true,
    lockedReason:
      'Pulling a credit bureau without the borrower’s written consent is not something this ' +
      'software will help arrange. Locked on.',
    check: (deal) =>
      deal.allConsentsSigned
        ? null
        : {
            key: 'consent',
            severity: 'blocking',
            message: 'Not every borrower has signed the credit-pull consent.',
            field: 'consents',
          },
  },

  {
    key: 'documents',
    label: 'Required documents received',
    defaultSeverity: 'blocking',
    check: (deal) =>
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
  },

  {
    key: 'compliance',
    label: 'Compliance checklist complete',
    defaultSeverity: 'blocking',
    check: (deal) =>
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
  },

  {
    key: 'gds',
    label: 'GDS within the conventional limit',
    defaultSeverity: 'warning',
    check: (deal) =>
      deal.ratios == null || deal.ratios.gdsPasses
        ? null
        : {
            key: 'gds',
            severity: 'warning',
            message: `GDS is ${deal.ratios.gds}%, over the conventional 39% limit. Some lenders will still look at it.`,
          },
  },

  {
    key: 'tds',
    label: 'TDS within the conventional limit',
    defaultSeverity: 'warning',
    check: (deal) =>
      deal.ratios == null || deal.ratios.tdsPasses
        ? null
        : {
            key: 'tds',
            severity: 'warning',
            message: `TDS is ${deal.ratios.tds}%, over the conventional 44% limit.`,
          },
  },

  {
    key: 'property_tax',
    label: 'Property tax recorded',
    defaultSeverity: 'warning',
    check: (deal) =>
      deal.annualPropertyTax
        ? null
        : {
            key: 'property_tax',
            severity: 'warning',
            message: 'No property tax recorded, so GDS is understated.',
            field: 'annualPropertyTax',
          },
  },

  {
    key: 'heat',
    label: 'Heating cost recorded',
    defaultSeverity: 'warning',
    check: (deal) =>
      deal.monthlyHeat
        ? null
        : {
            key: 'heat',
            severity: 'warning',
            message: 'No heating cost recorded, so GDS is understated.',
            field: 'monthlyHeat',
          },
  },

  {
    key: 'address',
    label: 'Property address on purchases',
    defaultSeverity: 'warning',
    check: (deal) =>
      deal.dealType !== 'purchase' || deal.propertyAddress
        ? null
        : {
            key: 'address',
            severity: 'warning',
            message: 'No property address. Most lenders need one before a firm approval.',
            field: 'propertyAddress',
          },
  },

  {
    key: 'down_payment',
    label: 'Down payment source verified',
    defaultSeverity: 'warning',
    check: (deal) =>
      deal.downPaymentVerified || deal.dealType !== 'purchase'
        ? null
        : {
            key: 'down_payment',
            severity: 'warning',
            message:
              'Down payment source is not verified. Lenders require a 90-day history of the funds.',
            field: 'downPayment',
          },
  },

  {
    key: 'down_payment_flags',
    label: 'No deposits awaiting explanation',
    defaultSeverity: 'warning',
    check: (deal) =>
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
  },
];

export const RULES_BY_KEY = new Map(RULES.map((rule) => [rule.key, rule]));

/**
 * Fold the brokerage's settings over the defaults.
 *
 * A locked rule keeps its default severity and stays enabled no matter what is
 * stored against it. Storing such an override is refused at the API, so this is
 * belt and braces — but a row written directly into the table, or left behind
 * by an earlier version, must not be able to weaken a legal obligation.
 */
export function applyOverrides(
  overrides: Map<string, RuleOverride>,
): Array<{ rule: RuleDefinition; severity: Severity; enabled: boolean }> {
  return RULES.map((rule) => {
    const override = rule.locked ? undefined : overrides.get(rule.key);

    return {
      rule,
      severity: override?.severity ?? rule.defaultSeverity,
      enabled: override?.enabled ?? true,
    };
  });
}

export function evaluateSubmission(
  deal: SubmissionSnapshot,
  overrides: Map<string, RuleOverride> = new Map(),
): SubmissionReadiness {
  const active = applyOverrides(overrides).filter((entry) => entry.enabled);

  const issues = active.flatMap((entry) => {
    const issue = entry.rule.check(deal);
    if (!issue) return [];
    // The check states the default severity in its own message; the brokerage's
    // setting is what actually decides whether the file can go.
    return [{ ...issue, severity: entry.severity }];
  });

  const blocking = issues.filter((issue) => issue.severity === 'blocking');
  const warnings = issues.filter((issue) => issue.severity === 'warning');

  // Blocking issues weigh double so the bar reflects how far there is to go,
  // not merely how many boxes are unticked. Disabled rules are out of the
  // denominator too — a bar measured against checks nobody runs is noise.
  const totalWeight = active.length + blocking.length;
  const penalty = blocking.length * 2 + warnings.length;
  const completeness =
    totalWeight === 0
      ? 100
      : Math.max(0, Math.round(((totalWeight - penalty) / totalWeight) * 100));

  return {
    ready: blocking.length === 0,
    issues,
    blocking,
    warnings,
    completeness,
  };
}
