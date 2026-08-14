/**
 * Building a lender submission package.
 *
 * ⚠️ This is an EXPORT, not a direct submission. A two-way bridge into a
 * lender's underwriting system needs an integration agreement with that lender;
 * there is no public API to write against. What this produces is the package —
 * borrower, income, liabilities, property, ratios, compliance and document
 * inventory — as JSON the broker downloads and uploads to the lender's portal,
 * or as a printable summary they attach to an email.
 *
 * `lender_submissions.method` records which it was, so the day an API
 * relationship exists, `method: 'api'` slots in beside the exports already on
 * file and the history stays continuous.
 *
 * Submission is REFUSED while blocking validation issues remain. That is the
 * point of the readiness gate: a file sent without FINTRAC identity
 * verification or a signed credit consent is a compliance problem the moment it
 * leaves the building.
 */

import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { asBroker } from '@/db';
import { deals, lenderProducts, lenderSubmissions, lenders } from '@/db/schema';
import { recordAudit } from '@/lib/audit';
import { getCurrentUser } from '@/lib/auth/session';
import { emitEvent } from '@/lib/api/webhooks';
import { dealRatios, getDealDetail, num } from '@/lib/deals/queries';
import { loadWorkspace } from '@/lib/deals/workspace';

const bodySchema = z.object({
  lenderId: z.string().uuid().nullable().optional(),
  productId: z.string().uuid().nullable().optional(),
  method: z.enum(['export', 'email']).default('export'),
  /** Send anyway despite warnings. Blocking issues are never overridable. */
  acknowledgeWarnings: z.boolean().default(false),
});

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user || user.kind !== 'broker') {
    return NextResponse.json({ error: 'Not authorised.' }, { status: 403 });
  }

  const { id: dealId } = await context.params;
  const parsed = bodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Invalid request.' }, { status: 400 });
  }

  const body = parsed.data;

  const outcome = await asBroker(user.id, async (db) => {
    const detail = await getDealDetail(db, dealId);
    if (!detail) return { ok: false as const, status: 404, error: 'Deal not found.' };

    const workspace = await loadWorkspace(db, detail);

    if (!workspace.readiness.ready) {
      return {
        ok: false as const,
        status: 400,
        error:
          'This file is not ready to submit. Clear the blocking issues first — a file sent ' +
          'without them is a compliance problem the moment it leaves the building.',
        blocking: workspace.readiness.blocking.map((issue) => issue.message),
      };
    }

    if (workspace.readiness.warnings.length > 0 && !body.acknowledgeWarnings) {
      return {
        ok: false as const,
        status: 409,
        error: 'There are warnings on this file. Confirm you want to send it anyway.',
        warnings: workspace.readiness.warnings.map((issue) => issue.message),
      };
    }

    const { deal, borrowers, incomes, liabilities } = detail;
    const { ratios } = dealRatios(detail);

    let lenderName: string | null = null;
    let productName: string | null = null;

    if (body.lenderId) {
      const [row] = await db
        .select({ name: lenders.name })
        .from(lenders)
        .where(eq(lenders.id, body.lenderId))
        .limit(1);
      lenderName = row?.name ?? null;
    }

    if (body.productId) {
      const [row] = await db
        .select({ name: lenderProducts.name, rate: lenderProducts.postedRate })
        .from(lenderProducts)
        .where(eq(lenderProducts.id, body.productId))
        .limit(1);
      productName = row ? `${row.name} @ ${row.rate}%` : null;
    }

    // The package. Flat and explicit — this gets pasted into a lender's portal
    // by a human, so it is ordered the way those forms ask for it.
    const payload = {
      reference: deal.reference,
      submittedAt: new Date().toISOString(),
      submittedBy: user.fullName,
      lender: lenderName,
      product: productName,

      application: {
        type: deal.dealType,
        purchasePrice: num(deal.purchasePrice),
        propertyValue: num(deal.propertyValue),
        downPayment: num(deal.downPayment),
        mortgageAmount: num(deal.mortgageAmount),
        rate: num(deal.interestRate),
        amortizationYears: deal.amortizationYears,
        paymentFrequency: deal.paymentFrequency,
      },

      property: {
        address: deal.propertyAddress,
        city: deal.propertyCity,
        province: deal.propertyProvince,
        postalCode: deal.propertyPostalCode,
        type: deal.propertyType,
        occupancy: deal.occupancy,
        annualPropertyTax: num(deal.annualPropertyTax),
        monthlyHeat: num(deal.monthlyHeat),
        monthlyCondoFees: num(deal.monthlyCondoFees),
      },

      existingMortgage:
        deal.dealType === 'purchase'
          ? null
          : {
              lender: deal.existingLender,
              balance: num(deal.existingBalance),
              maturityDate: deal.maturityDate,
            },

      borrowers: borrowers.map((borrower) => ({
        name: borrower.fullName,
        email: borrower.email,
        role: borrower.role,
        identityVerified: workspace.identityByClient.get(borrower.clientId) ?? false,
        consentSigned: workspace.consentByClient.get(borrower.clientId) ?? false,
        income: incomes
          .filter((income) => income.clientId === borrower.clientId)
          .map((income) => ({
            employmentType: income.employmentType,
            employer: income.employerName,
            yearsAtJob: num(income.yearsAtJob),
            annual: Number(income.annualIncome),
            priorYear: num(income.priorYearIncome),
          })),
      })),

      liabilities: liabilities.map((item) => ({
        type: item.liabilityType,
        description: item.description,
        balance: Number(item.balance),
        monthlyPayment: Number(item.monthlyPayment),
        payoutOnClosing: item.payoutOnClosing,
        includedInTds: item.includeInTds,
        source: item.source,
      })),

      ratios: ratios
        ? {
            qualifyingRate: ratios.qualifyingRatePercent,
            gds: ratios.gds,
            tds: ratios.tds,
            ltv: ratios.ltv,
            grossMonthlyIncome: ratios.grossMonthlyIncome,
          }
        : null,

      downPayment: {
        sources: workspace.downPayment.map((source) => ({
          type: source.sourceType,
          institution: source.institution,
          amount: Number(source.amount),
          verified: source.isVerified,
          flagged: source.flagged,
          flagReason: source.flagReason,
        })),
      },

      documents: workspace.dealDocuments.map((document) => document.fileName),

      compliance: workspace.compliance.map((item) => ({
        item: item.label,
        complete: item.status === 'complete',
      })),

      warningsAcknowledged: workspace.readiness.warnings.map((issue) => issue.message),
    };

    const [submission] = await db
      .insert(lenderSubmissions)
      .values({
        dealId,
        lenderId: body.lenderId ?? null,
        productId: body.productId ?? null,
        method: body.method,
        status: 'submitted',
        payload,
        submittedBy: user.id,
      })
      .returning({ id: lenderSubmissions.id });

    // Advance to Under Review only from the two stages where it makes sense.
    // Forcing it from anywhere would let a Funded deal jump backwards.
    if (['inquiry', 'documents_received'].includes(deal.stageKey)) {
      await db
        .update(deals)
        .set({ stageKey: 'under_review', updatedAt: new Date() })
        .where(eq(deals.id, dealId));
    }

    await recordAudit(db, {
      actorType: 'broker',
      actorId: user.id,
      action: 'deal.submission_exported',
      targetType: 'deal',
      targetId: dealId,
      clientId: deal.clientId,
      metadata: { lender: lenderName, method: body.method, submissionId: submission?.id },
    });

    await emitEvent(db, 'deal.stage_changed', {
      reference: deal.reference,
      stage: 'under_review',
      lender: lenderName,
    });

    return { ok: true as const, payload, submissionId: submission?.id };
  });

  if (!outcome.ok) {
    return NextResponse.json(
      { error: outcome.error, blocking: outcome.blocking, warnings: outcome.warnings },
      { status: outcome.status },
    );
  }

  return NextResponse.json(outcome);
}
