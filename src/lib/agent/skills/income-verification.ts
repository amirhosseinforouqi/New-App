/**
 * Skill: income verification flags.
 *
 * Manual-trigger only. The broker runs this once enough income documents are
 * in; it reads the classification metadata already stored on the client's
 * documents and reports inconsistencies worth a human look.
 *
 * This produces FLAGS, not decisions. It never says "approve" or "decline",
 * and it never writes to the client-visible side of the portal. A broker reads
 * the flags and decides. That constraint is in the prompt and enforced by the
 * output schema having nowhere to put a recommendation.
 */

import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import { documents } from '@/db/schema';
import { structuredCall } from '../anthropic';
import type { Skill } from '../types';

const inputSchema = z.object({
  clientId: z.string().uuid(),
  statedIncome: z.number().nullable().optional(),
  employmentType: z.string().optional(),
});

const outputSchema = z.object({
  flags: z.array(
    z.object({
      severity: z.enum(['info', 'review', 'blocker']),
      title: z.string(),
      detail: z.string(),
      documentsInvolved: z.array(z.string()),
    }),
  ),
  documentsSeen: z.number(),
  coverageGaps: z.array(z.string()),
  summary: z.string(),
});

type Input = z.infer<typeof inputSchema>;
type Output = z.infer<typeof outputSchema>;

const jsonSchema = {
  type: 'object',
  properties: {
    flags: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: {
            type: 'string',
            enum: ['info', 'review', 'blocker'],
            description:
              'info = worth noting; review = a human must reconcile this; blocker = the file cannot proceed until resolved.',
          },
          title: { type: 'string' },
          detail: { type: 'string' },
          documentsInvolved: {
            type: 'array',
            items: { type: 'string' },
            description: 'Document types this flag was derived from.',
          },
        },
        required: ['severity', 'title', 'detail', 'documentsInvolved'],
        additionalProperties: false,
      },
    },
    documentsSeen: { type: 'integer' },
    coverageGaps: {
      type: 'array',
      items: { type: 'string' },
      description: 'Income documents still missing that would change the assessment.',
    },
    summary: { type: 'string' },
  },
  required: ['flags', 'documentsSeen', 'coverageGaps', 'summary'],
  additionalProperties: false,
} as const;

const SYSTEM = `You review income documentation for a Canadian mortgage brokerage and surface issues a broker should look at.

You are given metadata about the documents on a client's file — what each one is, its year, and whose name is on it.

Raise a flag when you see:
- Income figures that do not reconcile across documents (T4 vs NOA vs pay stubs).
- A year gap in the record where continuous history is expected.
- A name mismatch between documents, or a document belonging to someone who is not the applicant.
- Employment type inconsistent with the documents supplied (salaried documents on a self-employed file, or vice versa).
- Documents that are stale for underwriting purposes — pay stubs more than about 60 days old, an NOA more than one tax year behind.
- Any signal of altered or inconsistent documentation.

Severity:
- "blocker" is for something that stops the file: a missing mandatory year, a document for the wrong person, evidence of alteration.
- "review" is for a genuine discrepancy that a human must reconcile.
- "info" is context worth noting that is not itself a problem.

Hard rules:
- You do NOT decide whether to approve, decline, or how much the client qualifies for. You surface facts and discrepancies.
- Do not invent figures. If you only have document types and no amounts, say so in coverageGaps rather than speculating.
- If the evidence is thin, an empty flags array with honest coverageGaps is the correct answer. Manufacturing findings to look thorough is a failure.`;

export const incomeVerificationSkill: Skill<Input, Output> = {
  key: 'income.verify',
  title: 'Income verification flags',
  description:
    'Reviews classified income documents on a file and flags inconsistencies, gaps and staleness for broker attention.',
  triggers: ['manual'],
  inputSchema,
  outputSchema,

  async run(input, context) {
    const rows = await context.db
      .select({
        fileName: documents.fileName,
        classifiedAs: documents.classifiedAs,
        meta: documents.classificationMeta,
        status: documents.status,
        uploadedAt: documents.createdAt,
      })
      .from(documents)
      .where(and(eq(documents.clientId, input.clientId)));

    const relevant = rows.filter((row) => row.classifiedAs !== null);

    if (relevant.length === 0) {
      // Return an honest empty result rather than calling the model with
      // nothing to look at.
      return {
        flags: [],
        documentsSeen: 0,
        coverageGaps: [
          'No classified documents on file yet. Upload income documents and let classification run first.',
        ],
        summary: 'Nothing to verify — no classified documents on this file.',
      };
    }

    const inventory = relevant
      .map((row) => {
        const meta = (row.meta ?? {}) as Record<string, unknown>;
        return [
          `- ${row.classifiedAs}`,
          meta.taxYear ? `year=${String(meta.taxYear)}` : null,
          meta.subjectName ? `subject=${String(meta.subjectName)}` : null,
          `status=${row.status}`,
          `uploaded=${row.uploadedAt.toISOString().slice(0, 10)}`,
          meta.summary ? `note="${String(meta.summary)}"` : null,
        ]
          .filter(Boolean)
          .join(' ');
      })
      .join('\n');

    const result = await structuredCall<Output>({
      system: SYSTEM,
      schema: jsonSchema as unknown as Record<string, unknown>,
      model: context.model,
      effort: context.effort,
      content: [
        {
          type: 'text',
          text: [
            `Today's date: ${new Date().toISOString().slice(0, 10)}`,
            input.employmentType ? `Stated employment type: ${input.employmentType}` : null,
            input.statedIncome != null ? `Stated annual income: $${input.statedIncome}` : null,
            '',
            'Documents on file:',
            inventory,
            '',
            'Review this income documentation and report your flags.',
          ]
            .filter(Boolean)
            .join('\n'),
        },
      ],
    });

    return outputSchema.parse(result.data);
  },

  // No apply(): flags are advisory. They are stored on the agent_runs row and
  // shown to the broker, and deliberately never mutate the client's file.
};
