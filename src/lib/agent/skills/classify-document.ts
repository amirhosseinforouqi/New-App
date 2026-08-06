/**
 * Skill: classify an uploaded document.
 *
 * Fires on `document.uploaded`. Reads the actual file from Drive and asks
 * Claude what it is, then writes the answer back onto the document row and,
 * when confident, marks the matching checklist item satisfied.
 *
 * Deliberately does NOT approve documents. Classification says "this is a
 * 2024 Notice of Assessment"; only the broker says "this is acceptable". That
 * boundary is what keeps the four-state document model meaningful.
 */

import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { documentRequests, documents } from '@/db/schema';
import { downloadFile } from '@/lib/drive/service';
import { structuredCall } from '../anthropic';
import type { Skill } from '../types';

const inputSchema = z.object({
  clientId: z.string().uuid(),
  documentId: z.string().uuid(),
  driveFileId: z.string(),
  fileName: z.string(),
  mimeType: z.string(),
  /** Outstanding checklist items, so the model can match the upload to one. */
  openRequests: z.array(z.object({ id: z.string().uuid(), label: z.string() })).default([]),
});

const outputSchema = z.object({
  documentType: z.string(),
  category: z.enum([
    'identity',
    'income',
    'employment',
    'assets',
    'property',
    'liabilities',
    'other',
  ]),
  confidence: z.enum(['high', 'medium', 'low']),
  taxYear: z.string().nullable(),
  subjectName: z.string().nullable(),
  matchedRequestId: z.string().nullable(),
  legibilityIssue: z.string().nullable(),
  summary: z.string(),
});

type Input = z.infer<typeof inputSchema>;
type Output = z.infer<typeof outputSchema>;

const jsonSchema = {
  type: 'object',
  properties: {
    documentType: {
      type: 'string',
      description: 'Specific Canadian document name, e.g. "T4 Statement of Remuneration Paid".',
    },
    category: {
      type: 'string',
      enum: ['identity', 'income', 'employment', 'assets', 'property', 'liabilities', 'other'],
    },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
    taxYear: {
      type: ['string', 'null'],
      description: 'Tax or statement year if the document has one, else null.',
    },
    subjectName: {
      type: ['string', 'null'],
      description: 'Person or company the document is about, else null.',
    },
    matchedRequestId: {
      type: ['string', 'null'],
      description: 'Id of the outstanding checklist item this satisfies, else null.',
    },
    legibilityIssue: {
      type: ['string', 'null'],
      description:
        'Describe any problem that would make a broker reject this — cropped page, unreadable scan, missing pages, expired ID. Null if none.',
    },
    summary: { type: 'string', description: 'One sentence for the broker.' },
  },
  required: [
    'documentType',
    'category',
    'confidence',
    'taxYear',
    'subjectName',
    'matchedRequestId',
    'legibilityIssue',
    'summary',
  ],
  additionalProperties: false,
} as const;

const SYSTEM = `You classify documents uploaded to a Canadian mortgage brokerage's client portal.

Identify precisely what the document is. Canadian document types you will encounter include:
T4, T4A, T1 General, Notice of Assessment (NOA), T2 Corporate return, pay stubs, letters of employment,
bank and investment statements, mortgage statements, property tax bills, MLS listings, Agreements of
Purchase and Sale, Articles of Incorporation, driver's licences and other government ID, credit bureau
reports (Equifax/TransUnion), CCB and ODSP benefit statements.

Rules:
- Be specific. "Tax document" is not an answer; "2023 Notice of Assessment" is.
- Set confidence to "low" rather than guessing when the document is ambiguous or partly illegible.
- Report anything in legibilityIssue that would make a broker send it back: cut-off edges, a photo too
  blurry to read figures, only one page of a multi-page statement, an expired ID, a screenshot of a
  banking app rather than a statement.
- Only set matchedRequestId when you are confident the upload genuinely satisfies that checklist item.
  A wrong match is worse than no match, because it hides an outstanding requirement.
- You are describing the document, not judging whether the application should be approved.`;

/** Claude accepts PDFs as document blocks and common raster formats as images. */
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

async function streamToBase64(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('base64');
}

export const classifyDocumentSkill: Skill<Input, Output> = {
  key: 'document.classify',
  title: 'Classify uploaded document',
  description:
    'Identifies what an uploaded file is, flags legibility problems, and matches it to an outstanding checklist item.',
  triggers: ['document.uploaded'],
  inputSchema,
  outputSchema,

  async run(input, context) {
    const isPdf = input.mimeType === 'application/pdf';
    const isImage = IMAGE_TYPES.has(input.mimeType);

    if (!isPdf && !isImage) {
      // Office documents and archives would need conversion first. Rather than
      // silently returning a bad guess, say so — the broker sees "unclassified"
      // and reviews it by hand.
      throw new Error(
        `Cannot classify ${input.mimeType}. Only PDF and image uploads are read directly; ` +
          'convert other formats to PDF before classification.',
      );
    }

    const stream = await downloadFile(input.driveFileId);
    const base64 = await streamToBase64(stream);

    const requestList =
      input.openRequests.length > 0
        ? input.openRequests.map((r) => `- ${r.id}: ${r.label}`).join('\n')
        : '(none outstanding)';

    const result = await structuredCall<Output>({
      system: SYSTEM,
      schema: jsonSchema as unknown as Record<string, unknown>,
      model: context.model,
      effort: context.effort,
      maxTokens: 8000,
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
          text: `Uploaded filename: ${input.fileName}\n\nOutstanding checklist items:\n${requestList}\n\nClassify this document.`,
        },
      ],
    });

    return outputSchema.parse(result.data);
  },

  async apply(output, context, input) {
    await context.db
      .update(documents)
      .set({
        classifiedAs: output.documentType,
        classificationMeta: output,
        // A legibility problem moves the document straight into the broker's
        // "needs attention" pile instead of sitting in review looking fine.
        status: output.legibilityIssue ? 'needs_attention' : 'in_review',
        reviewNote: output.legibilityIssue,
        updatedAt: new Date(),
      })
      .where(eq(documents.id, input.documentId));

    // Only a high-confidence, problem-free match flips a checklist item.
    // Medium and low leave the item outstanding so the broker still sees it.
    if (output.matchedRequestId && output.confidence === 'high' && !output.legibilityIssue) {
      await context.db
        .update(documentRequests)
        .set({ status: 'in_review', updatedAt: new Date() })
        .where(eq(documentRequests.id, output.matchedRequestId));

      await context.db
        .update(documents)
        .set({ requestId: output.matchedRequestId })
        .where(eq(documents.id, input.documentId));
    }

    context.log('Classification stored', {
      documentType: output.documentType,
      confidence: output.confidence,
      flagged: output.legibilityIssue !== null,
    });
  },
};
