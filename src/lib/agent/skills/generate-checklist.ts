/**
 * Skill: generate the document checklist for a new client.
 *
 * Fires automatically on `client.created`. This is the skill that answers
 * "when a new client profile is created, the agent should begin a checklist
 * based on application type".
 *
 * The model is given the Canadian mortgage context explicitly — a generic
 * prompt produces US paperwork (W-2s, 1040s) which is worse than useless to a
 * Canadian broker.
 */

import { z } from 'zod';

import { documentRequests } from '@/db/schema';
import { structuredCall } from '../anthropic';
import type { Skill } from '../types';

const inputSchema = z.object({
  clientId: z.string().uuid(),
  fullName: z.string(),
  applicationType: z.string(),
  notes: z.string().optional(),
});

const outputSchema = z.object({
  items: z.array(
    z.object({
      label: z.string(),
      description: z.string(),
      category: z.enum([
        'identity',
        'income',
        'employment',
        'assets',
        'property',
        'liabilities',
        'other',
      ]),
      required: z.boolean(),
    }),
  ),
  rationale: z.string(),
});

type Input = z.infer<typeof inputSchema>;
type Output = z.infer<typeof outputSchema>;

/**
 * JSON Schema for the API. Structured outputs require `additionalProperties:
 * false` and an explicit `required` list on every object — omitting either is
 * the most common cause of a 400 here.
 */
const jsonSchema = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string', description: 'Short name shown to the client.' },
          description: {
            type: 'string',
            description: 'One sentence telling the client exactly what to upload.',
          },
          category: {
            type: 'string',
            enum: [
              'identity',
              'income',
              'employment',
              'assets',
              'property',
              'liabilities',
              'other',
            ],
          },
          required: { type: 'boolean' },
        },
        required: ['label', 'description', 'category', 'required'],
        additionalProperties: false,
      },
    },
    rationale: {
      type: 'string',
      description: 'Brief note for the broker on why this list, not shown to the client.',
    },
  },
  required: ['items', 'rationale'],
  additionalProperties: false,
} as const;

const SYSTEM = `You are a mortgage processing assistant working for a licensed Canadian mortgage brokerage.

Your task is to produce the initial document checklist for a new client file, based on their application type.

Context that matters:
- This is CANADA. Use Canadian documents: T4, T1 General, Notice of Assessment (NOA), T2 for corporations, CRA statements, provincial property tax bills, MLS listings, Agreement of Purchase and Sale (APS), Articles of Incorporation. Never ask for W-2s, 1040s, or other US forms.
- Ask for what is actually needed for the stated application type. A refinance does not need an Agreement of Purchase and Sale; a purchase does. A self-employed applicant needs two years of T1s and NOAs plus business documents; a salaried applicant needs a letter of employment and recent pay stubs.
- Write each description as an instruction the client can act on without phoning anyone: say how many months, which years, and whether all pages are needed.
- Keep the list to what is genuinely required at the outset. Conditions discovered later are added as the file progresses. A 25-item wall on day one is how clients stall.

Mark an item required:false only when it is genuinely conditional (for example, a separation agreement that applies only to some clients).`;

export const generateChecklistSkill: Skill<Input, Output> = {
  key: 'checklist.generate',
  title: 'Generate document checklist',
  description:
    'Builds the initial required-document list for a new client, tailored to their application type.',
  triggers: ['client.created'],
  inputSchema,
  outputSchema,

  async run(input, context) {
    context.log('Generating checklist', {
      applicationType: input.applicationType,
      clientId: input.clientId,
    });

    const result = await structuredCall<Output>({
      system: SYSTEM,
      schema: jsonSchema as unknown as Record<string, unknown>,
      model: context.model,
      effort: context.effort,
      content: [
        {
          type: 'text',
          text: [
            `Application type: ${input.applicationType}`,
            input.notes ? `Broker notes: ${input.notes}` : null,
            '',
            'Produce the initial document checklist for this file.',
          ]
            .filter(Boolean)
            .join('\n'),
        },
      ],
    });

    // Validate against the zod schema too. Structured outputs guarantee the
    // shape the API was given, but the skill's own contract is the zod type
    // and drift between the two is a real bug class.
    return outputSchema.parse(result.data);
  },

  async apply(output, context) {
    if (!context.clientId) return;

    await context.db.insert(documentRequests).values(
      output.items.map((item, index) => ({
        clientId: context.clientId!,
        label: item.label,
        description: item.description,
        category: item.category,
        isRequired: item.required,
        createdBy: 'agent' as const,
        sortOrder: index,
      })),
    );

    context.log('Checklist written', { itemCount: output.items.length });
  },
};
