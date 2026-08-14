/**
 * Bank, CRA and bureau verification — the seam, not a pretend integration.
 *
 * Three of the four things below can genuinely be automated, and none of them
 * can be automated by this codebase alone:
 *
 *   Bank aggregation (Flinks, Plaid, MX) needs a signed vendor agreement, a
 *   production API key and, for most providers, a security review. It is the
 *   single most useful integration a mortgage portal can have and it cannot be
 *   conjured from an npm install.
 *
 *   CRA income data reaches a broker as a document the borrower downloads from
 *   My Account, or through a vendor with a CRA relationship. There is no public
 *   CRA API a brokerage can call.
 *
 *   A credit bureau pull needs a subscriber agreement with Equifax or
 *   TransUnion, and pulling one without the borrower's written consent is
 *   illegal regardless of what the software allows.
 *
 * So what is built is the record: what was asked for, when, whether it came
 * back, and by which route. Every kind carries the manual path a brokerage
 * actually uses today, and `provider: 'manual'` is a first-class value rather
 * than a placeholder — because manual is how this genuinely works right now,
 * and labelling it as such beats a greyed-out "Connect" button that implies a
 * capability nobody has bought.
 *
 * When a vendor agreement exists, `provider` becomes that vendor's name and
 * `externalRef` its request id. Nothing else in the schema changes.
 */

export type ConnectionStatus = 'requested' | 'received' | 'declined' | 'unavailable';

export interface ConnectionKind {
  key: string;
  label: string;
  /** What it establishes about the file. */
  purpose: string;
  /** How a brokerage gets this today, without a vendor. */
  manualRoute: string;
  /** What buying an integration would replace. Null where none exists to buy. */
  vendorRoute: string | null;
  /** Blocks the automated route until a human clears it. */
  requiresConsent: boolean;
}

export const CONNECTION_KINDS: ConnectionKind[] = [
  {
    key: 'bank_statements',
    label: 'Bank statements',
    purpose:
      'A 90-day history of the down payment, and the deposit pattern that supports stated income.',
    manualRoute:
      'The borrower uploads PDF statements to their portal. The statement audit in the agent panel reads them and flags large or unusual deposits.',
    vendorRoute:
      'Flinks, Plaid or MX can pull these directly with the borrower’s credentials, which removes both the upload step and the doctored-PDF problem. Needs a signed agreement and a production key.',
    requiresConsent: true,
  },
  {
    key: 'income_verification',
    label: 'Employment and income',
    purpose: 'Confirms the income the file qualifies on.',
    manualRoute:
      'Letter of employment plus two recent pay stubs, uploaded by the borrower. For self-employed files, two years of T1 Generals and Notices of Assessment.',
    vendorRoute:
      'Payroll-linked verification exists in Canada but coverage is thin outside large employers; most files still come back to documents.',
    requiresConsent: false,
  },
  {
    key: 'cra_assessment',
    label: 'CRA Notice of Assessment',
    purpose:
      'The number a lender trusts for self-employed and commission income, and proof there are no arrears.',
    manualRoute:
      'The borrower signs in to CRA My Account and downloads the PDF, then uploads it. Requesting it from the CRA by mail takes weeks — always ask for the download.',
    vendorRoute: null,
    requiresConsent: false,
  },
  {
    key: 'credit_bureau',
    label: 'Credit bureau',
    purpose: 'The score and trade lines every lender prices against.',
    manualRoute:
      'Pulled through your existing brokerage bureau access and the score entered on the file.',
    vendorRoute:
      'A direct Equifax or TransUnion subscriber agreement would let this be pulled from the deal page. It is a commercial relationship with its own compliance obligations.',
    requiresConsent: true,
  },
];

export const CONNECTION_KINDS_BY_KEY = new Map(
  CONNECTION_KINDS.map((kind) => [kind.key, kind]),
);

export interface ConnectionRecord {
  id: string;
  clientId: string;
  kind: string;
  provider: string;
  status: string;
  detail: string | null;
  requestedAt: Date;
  completedAt: Date | null;
}

export interface ConnectionSummary {
  kind: ConnectionKind;
  /** Per borrower, most recent first. */
  byClient: Map<string, ConnectionRecord[]>;
  /** Borrower ids with nothing received for this kind. */
  outstandingFor: string[];
}

/**
 * Group records for display, and work out who is still outstanding.
 *
 * "Outstanding" means no `received` record, so a borrower with a request that
 * was declined still counts as outstanding — a decline is information, not
 * completion.
 */
export function summariseConnections(
  records: ConnectionRecord[],
  borrowerIds: string[],
): ConnectionSummary[] {
  return CONNECTION_KINDS.map((kind) => {
    const forKind = records.filter((record) => record.kind === kind.key);
    const byClient = new Map<string, ConnectionRecord[]>();

    for (const clientId of borrowerIds) {
      const mine = forKind
        .filter((record) => record.clientId === clientId)
        .sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime());
      byClient.set(clientId, mine);
    }

    const outstandingFor = borrowerIds.filter(
      (clientId) => !(byClient.get(clientId) ?? []).some((record) => record.status === 'received'),
    );

    return { kind, byClient, outstandingFor };
  });
}

/**
 * Whether a consent-gated kind may be requested for a borrower.
 *
 * The credit bureau and bank aggregation both act on the borrower's own
 * accounts, so a request that has not been consented to is not a request — it
 * is the thing the consent exists to prevent.
 */
export function canRequest(
  kind: ConnectionKind,
  consentSigned: boolean,
): { allowed: boolean; reason: string | null } {
  if (kind.requiresConsent && !consentSigned) {
    return {
      allowed: false,
      reason: 'The borrower has not signed the consent covering this yet.',
    };
  }

  return { allowed: true, reason: null };
}
