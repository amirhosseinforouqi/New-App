/**
 * Compliance actions on a deal: ticking items, recording FINTRAC identity
 * verification, logging down-payment sources, and copying the deal.
 *
 * Grouped because they are all "the broker did something to this file's
 * compliance record", and all of them write an audit row. Splitting them into
 * four routes would duplicate the lookup and the authorisation four times.
 *
 * An item that requires a document cannot be ticked without one attached. That
 * rule lives here rather than in the UI: a checklist you can tick without the
 * evidence is a checklist that proves nothing at an audit.
 */

import { NextResponse } from 'next/server';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { asBroker } from '@/db';
import {
  dealBorrowers,
  dealComplianceItems,
  deals,
  documents,
  downPaymentSources,
  identityVerifications,
} from '@/db/schema';
import { recordAudit } from '@/lib/audit';
import { getCurrentUser } from '@/lib/auth/session';
import { IDENTITY_METHODS } from '@/lib/compliance/templates';

const methodValues = IDENTITY_METHODS.map((method) => method.value) as [string, ...string[]];

const bodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('set_item'),
    itemId: z.string().uuid(),
    complete: z.boolean(),
    note: z.string().trim().max(1000).optional(),
    documentId: z.string().uuid().nullable().optional(),
  }),
  z.object({
    action: z.literal('verify_identity'),
    clientId: z.string().uuid(),
    method: z.enum(methodValues),
    documentType: z.string().trim().max(80).optional(),
    documentNumber: z.string().trim().max(80).optional(),
    issuingJurisdiction: z.string().trim().max(80).optional(),
    documentExpiry: z.string().trim().max(10).optional(),
    pepScreened: z.boolean().default(false),
    pepResult: z.string().trim().max(200).optional(),
    notes: z.string().trim().max(1000).optional(),
  }),
  z.object({
    action: z.literal('add_down_payment'),
    clientId: z.string().uuid().nullable().optional(),
    sourceType: z.string().trim().max(40),
    institution: z.string().trim().max(120).optional(),
    amount: z.number().nonnegative(),
    isVerified: z.boolean().default(false),
    flagged: z.boolean().default(false),
    flagReason: z.string().trim().max(500).optional(),
    notes: z.string().trim().max(1000).optional(),
  }),
  z.object({ action: z.literal('copy_deal') }),
]);

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user || user.kind !== 'broker') {
    return NextResponse.json({ error: 'Not authorised.' }, { status: 403 });
  }

  const { id: dealId } = await context.params;
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid request.' },
      { status: 400 },
    );
  }

  const body = parsed.data;

  const outcome = await asBroker(user.id, async (db) => {
    const [deal] = await db.select().from(deals).where(eq(deals.id, dealId)).limit(1);
    if (!deal) return { ok: false as const, status: 404, error: 'Deal not found.' };

    switch (body.action) {
      case 'set_item': {
        const [item] = await db
          .select()
          .from(dealComplianceItems)
          .where(
            and(eq(dealComplianceItems.id, body.itemId), eq(dealComplianceItems.dealId, dealId)),
          )
          .limit(1);

        if (!item) return { ok: false as const, status: 404, error: 'Checklist item not found.' };

        if (body.complete && item.requiresDocument) {
          const documentId = body.documentId ?? item.documentId;
          if (!documentId) {
            return {
              ok: false as const,
              status: 400,
              error:
                'This item needs a document attached before it can be marked complete. ' +
                'A ticked box with no evidence behind it proves nothing at an audit.',
            };
          }

          const [attached] = await db
            .select({ id: documents.id })
            .from(documents)
            .where(and(eq(documents.id, documentId), eq(documents.dealId, dealId)))
            .limit(1);

          if (!attached) {
            return {
              ok: false as const,
              status: 400,
              error: 'That document is not on this deal.',
            };
          }
        }

        await db
          .update(dealComplianceItems)
          .set({
            status: body.complete ? 'complete' : 'pending',
            note: body.note ?? item.note,
            documentId: body.documentId ?? item.documentId,
            completedBy: body.complete ? user.id : null,
            completedAt: body.complete ? new Date() : null,
          })
          .where(eq(dealComplianceItems.id, body.itemId));

        await recordAudit(db, {
          actorType: 'broker',
          actorId: user.id,
          action: 'compliance.updated',
          targetType: 'compliance_item',
          targetId: body.itemId,
          clientId: deal.clientId,
          metadata: { label: item.label, complete: body.complete },
        });

        return { ok: true as const };
      }

      case 'verify_identity': {
        const [borrower] = await db
          .select({ clientId: dealBorrowers.clientId })
          .from(dealBorrowers)
          .where(
            and(eq(dealBorrowers.dealId, dealId), eq(dealBorrowers.clientId, body.clientId)),
          )
          .limit(1);

        if (!borrower) {
          return { ok: false as const, status: 400, error: 'That person is not on this deal.' };
        }

        await db.insert(identityVerifications).values({
          clientId: body.clientId,
          dealId,
          method: body.method,
          documentType: body.documentType ?? null,
          documentNumber: body.documentNumber ?? null,
          issuingJurisdiction: body.issuingJurisdiction ?? null,
          documentExpiry: body.documentExpiry || null,
          verifiedBy: user.id,
          pepScreened: body.pepScreened,
          pepResult: body.pepResult ?? null,
          pepScreenedAt: body.pepScreened ? new Date() : null,
          notes: body.notes ?? null,
        });

        await recordAudit(db, {
          actorType: 'broker',
          actorId: user.id,
          action: 'identity.verified',
          targetType: 'client',
          targetId: body.clientId,
          clientId: body.clientId,
          metadata: { method: body.method, dealId, pepScreened: body.pepScreened },
        });

        return { ok: true as const };
      }

      case 'add_down_payment': {
        await db.insert(downPaymentSources).values({
          dealId,
          clientId: body.clientId ?? deal.clientId,
          sourceType: body.sourceType,
          institution: body.institution ?? null,
          amount: String(body.amount),
          isVerified: body.isVerified,
          flagged: body.flagged,
          flagReason: body.flagReason ?? null,
          source: 'broker',
          notes: body.notes ?? null,
        });

        await recordAudit(db, {
          actorType: 'broker',
          actorId: user.id,
          action: 'compliance.updated',
          targetType: 'deal',
          targetId: dealId,
          clientId: deal.clientId,
          metadata: { downPaymentSource: body.sourceType, amount: body.amount },
        });

        return { ok: true as const };
      }

      case 'copy_deal': {
        // Repeat business: same borrowers, same property facts, fresh pipeline.
        // Deliberately does NOT copy documents, compliance, messages or stage
        // history — a new application needs its own evidence, and carrying an
        // old FINTRAC verification onto a new file would defeat the point of
        // recording it.
        const [copy] = await db
          .insert(deals)
          .values({
            clientId: deal.clientId,
            reference: sql`next_deal_reference()`,
            dealType: deal.dealType,
            stageKey: 'inquiry',
            assignedTo: deal.assignedTo,
            propertyAddress: deal.propertyAddress,
            propertyCity: deal.propertyCity,
            propertyProvince: deal.propertyProvince,
            propertyPostalCode: deal.propertyPostalCode,
            propertyType: deal.propertyType,
            occupancy: deal.occupancy,
            purchasePrice: deal.purchasePrice,
            propertyValue: deal.propertyValue,
            downPayment: deal.downPayment,
            mortgageAmount: deal.mortgageAmount,
            amortizationYears: deal.amortizationYears,
            paymentFrequency: deal.paymentFrequency,
            annualPropertyTax: deal.annualPropertyTax,
            monthlyHeat: deal.monthlyHeat,
            monthlyCondoFees: deal.monthlyCondoFees,
            leadSource: 'copied',
            notes: deal.notes,
          })
          .returning({ id: deals.id, reference: deals.reference });

        if (!copy) return { ok: false as const, status: 500, error: 'Could not copy the deal.' };

        const borrowers = await db
          .select({ clientId: dealBorrowers.clientId, role: dealBorrowers.role })
          .from(dealBorrowers)
          .where(eq(dealBorrowers.dealId, dealId));

        for (const borrower of borrowers) {
          await db.insert(dealBorrowers).values({
            dealId: copy.id,
            clientId: borrower.clientId,
            role: borrower.role,
            acceptedAt: new Date(),
          });
        }

        await recordAudit(db, {
          actorType: 'broker',
          actorId: user.id,
          action: 'deal.copied',
          targetType: 'deal',
          targetId: copy.id,
          clientId: deal.clientId,
          metadata: { from: deal.reference, to: copy.reference },
        });

        return { ok: true as const, dealId: copy.id, reference: copy.reference };
      }
    }
  });

  if (!outcome.ok) {
    return NextResponse.json({ error: outcome.error }, { status: outcome.status });
  }

  return NextResponse.json(outcome);
}
