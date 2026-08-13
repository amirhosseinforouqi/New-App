/**
 * Public API — create a lead.
 *
 * The write half of the integration surface: a personal-brand website, a
 * Facebook lead form or a Zapier zap posts here and a real client profile,
 * deal and checklist come out the other side — exactly as if the person had
 * filled in `/apply` themselves.
 *
 * It reuses `submitIntake` rather than reimplementing creation. That is the
 * point: one code path means a lead from Zapier gets the same Drive folder,
 * the same generated checklist and the same credentials email as every other
 * lead, and there is no second implementation to drift.
 */

import { NextResponse } from 'next/server';
import { z } from 'zod';

import { asSystem } from '@/db';
import { authenticateApiKey, hasScope } from '@/lib/api/keys';
import { emitEvent } from '@/lib/api/webhooks';
import { validateSubmission } from '@/lib/intake/mapping';
import { submitIntake } from '@/lib/intake/submit';

const bodySchema = z.object({
  full_name: z.string().trim().min(1).max(200),
  email: z.string().email(),
  phone: z.string().trim().max(40).optional(),
  deal_type: z
    .enum(['purchase', 'refinance', 'renewal', 'heloc', 'preapproval'])
    .default('purchase'),
  timeline: z
    .enum(['asap', '1_3_months', '3_6_months', '6_plus', 'just_looking'])
    .default('just_looking'),
  purchase_price: z.number().nonnegative().optional(),
  down_payment: z.number().nonnegative().optional(),
  property_value: z.number().nonnegative().optional(),
  existing_balance: z.number().nonnegative().optional(),
  annual_income: z.number().nonnegative().optional(),
  employment_type: z.string().trim().max(40).optional(),
  province: z.string().trim().length(2).optional(),
  city: z.string().trim().max(80).optional(),
  notes: z.string().trim().max(2000).optional(),
  referral_code: z.string().trim().max(64).optional(),
  /** Where this came from, for attribution. */
  source: z.string().trim().max(64).optional(),
});

export async function POST(request: Request) {
  const caller = await asSystem(async (db) =>
    authenticateApiKey(db, request.headers.get('authorization')),
  );

  if (!caller) {
    return NextResponse.json(
      { error: 'Provide a valid API key as `Authorization: Bearer <key>`.' },
      { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } },
    );
  }

  if (!hasScope(caller, 'write')) {
    return NextResponse.json(
      { error: 'This key is read-only. Create a key with write scope to post leads.' },
      { status: 403 },
    );
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: 'Invalid lead.',
        details: parsed.error.issues.map((issue) => ({
          field: issue.path.join('.'),
          message: issue.message,
        })),
      },
      { status: 400 },
    );
  }

  const lead = parsed.data;

  // Mapped onto the same answer keys the intake form produces, so the
  // downstream mapping, agent trigger and checklist are identical.
  const answers: Record<string, string | boolean> = {
    dealType: lead.deal_type,
    timeline: lead.timeline,
    fullName: lead.full_name,
    email: lead.email,
    // Consent is asserted by the integration. The API is a trusted caller
    // holding a brokerage key; the caller is responsible for having collected
    // it, and `applications.answers` records that this arrived via the API.
    consent: true,
  };

  if (lead.phone) answers.phone = lead.phone;
  if (lead.purchase_price != null) answers.purchasePrice = String(lead.purchase_price);
  if (lead.down_payment != null) answers.downPayment = String(lead.down_payment);
  if (lead.property_value != null) answers.propertyValue = String(lead.property_value);
  if (lead.existing_balance != null) answers.existingBalance = String(lead.existing_balance);
  if (lead.annual_income != null) answers.annualIncome = String(lead.annual_income);
  if (lead.employment_type) answers.employmentType = lead.employment_type;
  if (lead.province) answers.propertyProvince = lead.province;
  if (lead.city) answers.propertyCity = lead.city;
  if (lead.notes) answers.notes = lead.notes;

  // Validated against the EZ tier — the smallest set — so a partial lead is not
  // rejected for fields an integration was never going to send.
  const missing = validateSubmission('ez', answers);
  if (missing.length > 0) {
    return NextResponse.json(
      { error: 'Lead is missing required fields.', missing },
      { status: 400 },
    );
  }

  try {
    const result = await submitIntake({
      // Stored against the LONG tier even though it was validated against EZ.
      // Pruning is tier-aware: submitting as `ez` would silently discard
      // province, city, income and employment — fields this endpoint documents
      // as accepted — because they only become visible from `short` upward.
      // Validate at the floor, persist at the ceiling.
      tier: 'long',
      locale: 'en',
      answers,
      referralCode: lead.referral_code ?? null,
      ipAddress: null,
      userAgent: `api:${lead.source ?? 'integration'}`,
      leadSource: lead.source ? `api:${lead.source}` : 'api',
    });

    await asSystem(async (db) => {
      await emitEvent(db, 'application.submitted', {
        reference: result.dealReference,
        source: lead.source ?? 'api',
        deal_type: lead.deal_type,
      });
    });

    return NextResponse.json(
      {
        object: 'lead',
        reference: result.dealReference,
        existing_client: result.existingClient,
        credentials_emailed: result.emailSent,
        warnings: result.warnings,
      },
      { status: 201 },
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[api/v1/leads] failed', { message });
    return NextResponse.json({ error: 'Could not create the lead.' }, { status: 500 });
  }
}
