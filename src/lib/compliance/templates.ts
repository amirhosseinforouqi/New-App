/**
 * Compliance checklists.
 *
 * The default template is FINTRAC-shaped because that is the obligation a
 * Canadian mortgage brokerage actually carries: verify identity, keep the
 * record, screen for politically exposed persons, and be able to produce it
 * all on request. Brokerages layer their own items on top, which is why
 * templates are rows in a table rather than a constant — this is only the
 * starting point a new brokerage gets.
 *
 * ⚠️ These items reflect the obligations as commonly implemented, and they are
 * a checklist, not legal advice. A compliance officer should review the
 * template before a brokerage relies on it, and FINTRAC guidance changes.
 *
 * Two things this deliberately does NOT do:
 *
 *   It does not screen against a sanctions or PEP list. That requires a
 *   screening provider; there is a field to record the result and who ran it,
 *   because a checkbox claiming a screening happened when none did is worse
 *   than no checkbox.
 *
 *   It does not decide whether a file is compliant. It records what was done.
 */

export interface ComplianceItemTemplate {
  label: string;
  description: string;
  /** Cannot be ticked without a document attached. */
  requiresDocument: boolean;
  /** Recorded once per borrower rather than once per deal. */
  perBorrower?: boolean;
}

/** FINTRAC methods for verifying an individual's identity. */
export const IDENTITY_METHODS = [
  {
    value: 'government_id',
    label: 'Government-issued photo ID',
    detail:
      'Original, valid and unexpired, examined in person or by an approved remote process. Record the type, number, jurisdiction and expiry.',
  },
  {
    value: 'credit_file',
    label: 'Credit file method',
    detail:
      'A Canadian credit file at least three years old, matched on name, address and date of birth at the time of verification.',
  },
  {
    value: 'dual_process',
    label: 'Dual process method',
    detail:
      'Two reliable, independent sources — for example name and address from one, and name and date of birth from another.',
  },
  {
    value: 'agent_mandate',
    label: 'Agent or mandatary',
    detail: 'Verified by an agent under a written agreement.',
  },
] as const;

export const DEFAULT_COMPLIANCE_TEMPLATE: ComplianceItemTemplate[] = [
  {
    label: 'Verify borrower identity (FINTRAC)',
    description:
      'Record the method used, and for photo ID the document type, number, issuing jurisdiction and expiry. Keep the record for five years.',
    requiresDocument: true,
    perBorrower: true,
  },
  {
    label: 'Screen for politically exposed persons',
    description:
      'Determine whether the borrower is a PEP, a head of an international organisation, or a close associate or family member of one. A match requires senior management approval and enhanced measures.',
    requiresDocument: false,
    perBorrower: true,
  },
  {
    label: 'Confirm source of down payment',
    description:
      'A 90-day history for the funds. Large or unusual deposits need a written explanation on file.',
    requiresDocument: true,
  },
  {
    label: 'Signed credit-pull consent',
    description: 'Written consent from every borrower before any bureau is pulled.',
    requiresDocument: false,
    perBorrower: true,
  },
  {
    label: 'Privacy notice acknowledged',
    description: 'The borrower has been told what is collected, why, and who it is shared with.',
    requiresDocument: false,
    perBorrower: true,
  },
  {
    label: 'Assess third-party involvement',
    description:
      'Determine whether anyone other than the borrower is instructing or benefiting from the transaction, and record the finding either way.',
    requiresDocument: false,
  },
  {
    label: 'Suspicious transaction review',
    description:
      'Consider whether anything about the file requires a report. Record the conclusion — including that there was nothing to report.',
    requiresDocument: false,
  },
  {
    label: 'Mortgage Protection Plan offered',
    description:
      'Creditor life and disability insurance offered and the borrower’s decision recorded, accepted or declined.',
    requiresDocument: false,
  },
  {
    label: 'Disclosure of broker compensation',
    description:
      'Where the brokerage is paid by the lender, disclose it in the form the province requires.',
    requiresDocument: false,
  },
];

/** Purchases carry a couple of items a refinance does not. */
export const PURCHASE_ADDENDUM: ComplianceItemTemplate[] = [
  {
    label: 'Agreement of Purchase and Sale on file',
    description: 'Fully executed, including every schedule, amendment and waiver.',
    requiresDocument: true,
  },
  {
    label: 'Confirm deposit paid',
    description: 'Evidence the deposit named in the agreement has actually been paid.',
    requiresDocument: true,
  },
];

export const REFINANCE_ADDENDUM: ComplianceItemTemplate[] = [
  {
    label: 'Existing mortgage statement obtained',
    description: 'Current balance, rate, maturity date and any prepayment penalty.',
    requiresDocument: true,
  },
  {
    label: 'Payout penalty explained to borrower',
    description:
      'Where breaking early carries a penalty, confirm the borrower has been shown the number.',
    requiresDocument: false,
  },
];

/** The full item list for a deal type. */
export function templateForDealType(dealType: string): ComplianceItemTemplate[] {
  const base = [...DEFAULT_COMPLIANCE_TEMPLATE];

  if (dealType === 'purchase' || dealType === 'preapproval') return [...base, ...PURCHASE_ADDENDUM];
  if (['refinance', 'renewal', 'heloc'].includes(dealType)) return [...base, ...REFINANCE_ADDENDUM];

  return base;
}

/**
 * Expand a template into the rows a specific deal needs.
 *
 * Per-borrower items become one row each, labelled with the borrower's name,
 * because "verify borrower identity" ticked once on a two-borrower file is
 * precisely the record-keeping failure the obligation exists to prevent.
 */
export function expandTemplate(
  dealType: string,
  borrowers: Array<{ clientId: string; fullName: string }>,
): Array<{ label: string; description: string; requiresDocument: boolean; sortOrder: number }> {
  const items = templateForDealType(dealType);
  const rows: Array<{
    label: string;
    description: string;
    requiresDocument: boolean;
    sortOrder: number;
  }> = [];

  let order = 0;

  for (const item of items) {
    if (item.perBorrower && borrowers.length > 0) {
      for (const borrower of borrowers) {
        rows.push({
          label: `${item.label} — ${borrower.fullName}`,
          description: item.description,
          requiresDocument: item.requiresDocument,
          sortOrder: order++,
        });
      }
    } else {
      rows.push({
        label: item.label,
        description: item.description,
        requiresDocument: item.requiresDocument,
        sortOrder: order++,
      });
    }
  }

  return rows;
}
