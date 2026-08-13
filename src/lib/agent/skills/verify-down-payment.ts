/**
 * Skill: audit a bank statement for down-payment source.
 *
 * Lenders require a 90-day history for down-payment funds, and what they are
 * actually looking for is money that appeared from nowhere. A large deposit
 * with no explanation is the single most common reason a file stalls a week
 * before closing.
 *
 * This reads a statement and lists the deposits a lender would question, with
 * the reason. It is triggered manually rather than on upload, because it is a
 * deliberate act on a specific statement, not something to run over every file
 * a client sends.
 *
 * Two boundaries that matter:
 *
 *   It does NOT decide whether funds are acceptable. It surfaces what needs an
 *   explanation, and `is_verified` on the resulting row stays false until a
 *   human sets it. An AI-verified source of funds is not a thing a brokerage
 *   can stand behind at an audit.
 *
 *   It flags rather than accuses. "This deposit needs a written explanation" is
 *   useful; "this looks like undisclosed borrowing" is a judgement the software
 *   has no business making about a person's finances.
 */

import { z } from 'zod';

import { downPaymentSources } from '@/db/schema';
import { downloadFile } from '@/lib/drive/service';
import { structuredCall } from '../anthropic';
import type { Skill } from '../types';

const inputSchema = z.object({
  clientId: z.string().uuid(),
  dealId: z.string().uuid(),
  documentId: z.string().uuid(),
  driveFileId: z.string(),
  fileName: z.string(),
  mimeType: z.string(),
  /** So the model can say whether the statement actually covers it. */
  downPaymentRequired: z.number().nullable().default(null),
});

const depositSchema = z.object({
  date: z.string().nullable(),
  amount: z.number(),
  description: z.string(),
  needsExplanation: z.boolean(),
  reason: z.string().nullable(),
});

const outputSchema = z.object({
  institution: z.string().nullable(),
  accountHolder: z.string().nullable(),
  statementPeriod: z.string().nullable(),
  daysCovered: z.number().nullable(),
  coversNinetyDays: z.boolean(),
  openingBalance: z.number().nullable(),
  closingBalance: z.number().nullable(),
  largeDeposits: z.array(depositSchema),
  sufficientForDownPayment: z.boolean().nullable(),
  concerns: z.array(z.string()),
  summary: z.string(),
});

type Input = z.infer<typeof inputSchema>;
type Output = z.infer<typeof outputSchema>;

const jsonSchema = {
  type: 'object',
  properties: {
    institution: { type: ['string', 'null'], description: 'Bank or credit union name.' },
    accountHolder: { type: ['string', 'null'], description: 'Name on the account.' },
    statementPeriod: { type: ['string', 'null'], description: 'e.g. "1 Jan – 31 Mar 2026".' },
    daysCovered: { type: ['number', 'null'], description: 'Days between first and last transaction.' },
    coversNinetyDays: { type: 'boolean' },
    openingBalance: { type: ['number', 'null'] },
    closingBalance: { type: ['number', 'null'] },
    largeDeposits: {
      type: 'array',
      description:
        'Every deposit a lender would ask about. Regular payroll is not one of these; a round-number transfer, a cash deposit, or anything materially larger than the usual pattern is.',
      items: {
        type: 'object',
        properties: {
          date: { type: ['string', 'null'] },
          amount: { type: 'number' },
          description: { type: 'string', description: 'As printed on the statement.' },
          needsExplanation: { type: 'boolean' },
          reason: {
            type: ['string', 'null'],
            description:
              'Why a lender would ask, phrased neutrally — what is missing, not what it might be.',
          },
        },
        required: ['date', 'amount', 'description', 'needsExplanation', 'reason'],
        additionalProperties: false,
      },
    },
    sufficientForDownPayment: {
      type: ['boolean', 'null'],
      description: 'Whether the closing balance covers the required down payment. Null if unknown.',
    },
    concerns: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Problems with the STATEMENT itself: missing pages, no account holder name, a screenshot rather than a statement, period too short.',
    },
    summary: { type: 'string', description: 'Two sentences for the broker.' },
  },
  required: [
    'institution',
    'accountHolder',
    'statementPeriod',
    'daysCovered',
    'coversNinetyDays',
    'openingBalance',
    'closingBalance',
    'largeDeposits',
    'sufficientForDownPayment',
    'concerns',
    'summary',
  ],
  additionalProperties: false,
} as const;

const SYSTEM = `You audit bank statements for a Canadian mortgage brokerage, checking the source of down-payment funds.

Lenders require a 90-day history and want every unusual deposit explained. Your job is to list what they will ask about.

What counts as needing an explanation:
- A deposit materially larger than the account's normal pattern.
- Round-number transfers (5,000.00 / 20,000.00) with no payroll-like description.
- Cash deposits of any size.
- Transfers from an account or person not otherwise on the file.
- A balance that jumps shortly before the statement ends.

What does NOT:
- Regular payroll at a consistent interval and similar amount.
- Government benefits (CCB, GST/HST credit, OAS, CPP).
- Internal transfers between the holder's own visible accounts, where the statement shows both sides.

Rules:
- Phrase every reason as what is MISSING, not what you suspect. "No source shown for this transfer" is right. "Possibly an undisclosed loan" is not — you are reading a page, not investigating a person.
- Report problems with the statement itself in "concerns": missing pages, no name, a banking-app screenshot instead of a statement, a period shorter than 90 days.
- If figures are illegible, say so in concerns rather than guessing. A wrong number here sends a broker to a client with a question that makes no sense.
- You are NOT deciding whether the funds are acceptable. A human does that.`;

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

async function streamToBase64(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('base64');
}

export const verifyDownPaymentSkill: Skill<Input, Output> = {
  key: 'downpayment.verify',
  title: 'Audit a bank statement for down-payment source',
  description:
    'Reads a bank statement and lists the deposits a lender will require an explanation for, plus problems with the statement itself.',
  // Manual: this is a deliberate act on a specific statement, not something to
  // run over every upload.
  triggers: [],
  inputSchema,
  outputSchema,

  async run(input, context) {
    const isPdf = input.mimeType === 'application/pdf';
    const isImage = IMAGE_TYPES.has(input.mimeType);

    if (!isPdf && !isImage) {
      throw new Error(
        `Cannot read ${input.mimeType}. Upload the statement as a PDF or a photo.`,
      );
    }

    const stream = await downloadFile(input.driveFileId);
    const base64 = await streamToBase64(stream);

    const target =
      input.downPaymentRequired != null
        ? `The down payment required on this file is $${input.downPaymentRequired.toLocaleString('en-CA')}.`
        : 'The required down payment is not recorded on this file.';

    const result = await structuredCall<Output>({
      system: SYSTEM,
      schema: jsonSchema as unknown as Record<string, unknown>,
      model: context.model,
      effort: context.effort,
      maxTokens: 12_000,
      content: [
        isPdf
          ? {
              type: 'document',
              source: { type: 'base64', media_type: 'application/pdf', data: base64 },
            }
          : {
              type: 'image',
              source: {
                type: 'base64',
                media_type: input.mimeType as 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp',
                data: base64,
              },
            },
        {
          type: 'text',
          text: `Filename: ${input.fileName}\n\n${target}\n\nAudit this statement for down-payment source of funds.`,
        },
      ],
    });

    return outputSchema.parse(result.data);
  },

  async apply(output, context, input) {
    // One row per deposit needing explanation, plus a summary row for the
    // account itself. `isVerified` is false on all of them — a human decides.
    await context.db.insert(downPaymentSources).values({
      dealId: input.dealId,
      clientId: input.clientId,
      documentId: input.documentId,
      sourceType: 'savings',
      institution: output.institution,
      amount: String(output.closingBalance ?? 0),
      isVerified: false,
      flagged: !output.coversNinetyDays || output.concerns.length > 0,
      flagReason: !output.coversNinetyDays
        ? `Statement covers ${output.daysCovered ?? 'an unknown number of'} days, not the 90 a lender requires.`
        : (output.concerns[0] ?? null),
      source: 'agent',
      notes: output.summary,
    });

    for (const deposit of output.largeDeposits.filter((item) => item.needsExplanation)) {
      await context.db.insert(downPaymentSources).values({
        dealId: input.dealId,
        clientId: input.clientId,
        documentId: input.documentId,
        sourceType: 'unexplained_deposit',
        institution: output.institution,
        amount: String(deposit.amount),
        asOfDate: deposit.date && /^\d{4}-\d{2}-\d{2}$/.test(deposit.date) ? deposit.date : null,
        isVerified: false,
        flagged: true,
        flagReason: deposit.reason,
        source: 'agent',
        notes: deposit.description,
      });
    }
  },
};
