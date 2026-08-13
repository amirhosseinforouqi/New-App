/**
 * Electronic consent.
 *
 * What makes this defensible is the hash. `document_hash` is a SHA-256 of the
 * exact text the borrower was shown, stored beside their typed name, the
 * timestamp and the IP. That proves WHAT was agreed to, not merely that a
 * checkbox was ticked — and if the wording is later edited, the hash of the new
 * text no longer matches the stored one, which is exactly the property you want
 * from a record that might be produced years afterwards.
 *
 * ⚠️ This is an electronic signature, not a CERTIFIED or QUALIFIED one. There is
 * no third-party certificate authority attesting to the signer's identity. Under
 * PIPEDA and the provincial electronic commerce acts, a record of this shape —
 * intent, the exact document, and an audit trail tying them together — is the
 * normal standard for consent forms, credit-pull authorisations and privacy
 * acknowledgements, which is what a brokerage actually needs. It is NOT
 * sufficient for anything requiring a notarised or witnessed instrument.
 *
 * Versioning is deliberate. When wording changes, bump the version rather than
 * editing in place: consents already signed remain valid against the text that
 * was actually shown, and the new version applies to everyone after.
 */

import { createHash } from 'node:crypto';

export type ConsentKind = 'credit_pull' | 'privacy' | 'mpp_offer' | 'broker_compensation';

export interface ConsentDocument {
  kind: ConsentKind;
  version: string;
  title: string;
  body: string;
  /** Blocks lender submission until signed. */
  required: boolean;
}

const BROKERAGE = '{{brokerage}}';

/**
 * The consent texts.
 *
 * Written in plain language on purpose. A consent nobody can read is consent in
 * name only, and a borrower who does not understand what they authorised is a
 * complaint waiting to happen.
 */
export const CONSENT_DOCUMENTS: Record<ConsentKind, ConsentDocument> = {
  credit_pull: {
    kind: 'credit_pull',
    version: '1.0',
    required: true,
    title: 'Consent to obtain your credit report',
    body: `You are giving ${BROKERAGE} permission to obtain a credit report about you from a Canadian credit reporting agency such as Equifax or TransUnion.

What this means:

• We may request your credit report now, and again while your application is open, to place it with lenders and to keep it current.
• Your credit report shows your borrowing history, your current debts and your payment record. We use it to work out what you qualify for and to choose lenders who are likely to approve you.
• A request made by a mortgage broker is recorded on your file as an inquiry. Several mortgage inquiries in a short period are normally treated by the scoring models as a single event, so shopping for a mortgage does not penalise you the way opening several new credit cards would.
• We may share the report and your application with lenders, mortgage default insurers and, where relevant, mortgage protection insurers, for the purpose of assessing this application.
• We keep the information for as long as the law requires us to, and no longer.

You can withdraw this consent at any time by telling us in writing. Withdrawing it does not undo a report we have already obtained, and it may mean we can no longer place your application.`,
  },

  privacy: {
    kind: 'privacy',
    version: '1.0',
    required: true,
    title: 'How we handle your personal information',
    body: `${BROKERAGE} collects personal and financial information from you in order to arrange a mortgage. This describes what we do with it.

What we collect: your identity, contact details, employment and income, assets and debts, the property, and the documents you upload to support them.

Why: to assess your application, to submit it to lenders on your behalf, to meet our obligations under FINTRAC and provincial mortgage brokering rules, and to stay in touch with you about your file.

Who we share it with: lenders and mortgage default insurers considering your application; credit reporting agencies; and service providers who help us operate, under confidentiality obligations. We do not sell your information, and we do not share it for anyone else's marketing.

Where it is held: your file is stored in Canada. Documents you upload are held in the brokerage's Google Drive, which is configured to keep content in Canada.

Automated processing: we use software, including AI, to sort and read the documents you upload and to build your document checklist. It does not decide whether you are approved. Every decision on your file is made by a person.

Your rights: you can ask to see the personal information we hold about you, ask us to correct it, or ask what we have shared and with whom. Write to us and we will respond within thirty days.

Keeping it: FINTRAC requires us to keep certain records for five years after the file closes. We delete what we are not required to keep.`,
  },

  mpp_offer: {
    kind: 'mpp_offer',
    version: '1.0',
    required: false,
    title: 'Mortgage protection insurance — offer and decision',
    body: `Creditor life and disability insurance pays out against your mortgage if you die or become unable to work. It is optional. Your mortgage does not depend on taking it, and we will place your file exactly the same way either way.

We are required to offer it and to record your decision.

Things worth knowing before you decide:

• Coverage decreases as your mortgage balance falls, while the premium usually does not.
• The benefit is paid to the lender, not to your family, so it clears the mortgage rather than giving them a choice.
• Individually underwritten term life insurance is often cheaper for the same coverage and is yours to keep if you move lenders. It takes longer to arrange.
• Some policies are underwritten only when you claim, which can mean a declined claim years after the premiums started. Ask which kind you are being offered.

Whichever way you decide, we will record it and move on.`,
  },

  broker_compensation: {
    kind: 'broker_compensation',
    version: '1.0',
    required: false,
    title: 'How we are paid',
    body: `In most cases the lender pays ${BROKERAGE} a finder's fee when your mortgage funds. It is a percentage of the mortgage amount and it does not come out of your pocket or change your rate.

Where a lender does not pay a fee — which happens with some alternative and private lenders — we would charge you a fee directly. If that applies to your file, we will tell you the amount in writing before you commit to anything, and you are free to walk away.

You are entitled to ask at any point who is paying us and how much.`,
  },
};

/** The exact text a borrower is shown, with the brokerage name substituted in. */
export function renderConsent(kind: ConsentKind, brokerageName: string): ConsentDocument {
  const template = CONSENT_DOCUMENTS[kind];

  return {
    ...template,
    body: template.body.replaceAll(BROKERAGE, brokerageName),
  };
}

/**
 * Hash the rendered document.
 *
 * The title and version are hashed with the body so that changing either
 * produces a different hash. Normalised line endings so a CRLF round trip
 * through a database or an editor cannot invalidate an otherwise identical
 * document.
 */
export function hashConsentDocument(document: {
  kind: string;
  version: string;
  title: string;
  body: string;
}): string {
  const canonical = [
    document.kind,
    document.version,
    document.title,
    document.body.replace(/\r\n/g, '\n').trim(),
  ].join('\n---\n');

  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Does a typed signature plausibly match the account holder?
 *
 * Deliberately lenient — this WARNS, it does not block. People sign as "Liz"
 * when their file says "Elizabeth", use a married name, or transliterate an
 * accented name. Refusing those would be both wrong and insulting. What it
 * catches is the genuinely suspicious case: a signature bearing no relation to
 * the name on the file, which is worth a broker's attention.
 */
export function signatureLooksLikeName(signed: string, fullName: string): boolean {
  const normalise = (value: string) =>
    value
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .replace(/[^a-z\s]/g, ' ')
      .split(/\s+/)
      .filter(Boolean);

  const signedParts = normalise(signed);
  const nameParts = normalise(fullName);

  if (signedParts.length === 0 || nameParts.length === 0) return false;

  // One shared name part, or one being a prefix of the other, is enough.
  return signedParts.some((part) =>
    nameParts.some(
      (namePart) =>
        part === namePart ||
        (part.length >= 3 && namePart.startsWith(part)) ||
        (namePart.length >= 3 && part.startsWith(namePart)),
    ),
  );
}

/** Consents that must be signed before a file can go to a lender. */
export function requiredConsentKinds(): ConsentKind[] {
  return (Object.keys(CONSENT_DOCUMENTS) as ConsentKind[]).filter(
    (kind) => CONSENT_DOCUMENTS[kind].required,
  );
}
