/**
 * Turning a submitted intake form into a real file.
 *
 * The answers arrive as a flat bag of strings keyed by field id. This module is
 * the only place that knows how those ids map onto columns — the renderer
 * doesn't, and the API route doesn't. Adding a question that needs to land in a
 * column means editing `mapDeal` here and nothing else.
 *
 * Two things are deliberate:
 *
 *   Raw answers are stored verbatim in `applications.answers` alongside the
 *   mapped columns. Mapping is lossy by design (we don't have a column for
 *   every question, and shouldn't), but a broker looking at a file six months
 *   later should still be able to see exactly what the borrower typed.
 *
 *   A returning client gets a NEW deal against their EXISTING profile rather
 *   than a duplicate login. One person, one identity, many applications.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';

import { asSystem } from '@/db';
import {
  agentRuns,
  applications,
  borrowerIncomes,
  borrowerLiabilities,
  brokers,
  clientStageHistory,
  dealBorrowers,
  deals,
  referralSources,
} from '@/db/schema';
import { recordAudit } from '@/lib/audit';
import { createClientProfile } from '@/lib/onboarding';
import type { Answers, Locale, Tier } from '@/lib/intake/form';
import {
  money,
  numeric,
  pruneToVisible,
  requestedMortgage,
  text,
} from '@/lib/intake/mapping';

export interface SubmitIntakeInput {
  tier: Tier;
  locale: Locale;
  answers: Answers;
  referralCode?: string | null;
  ipAddress?: string | null;
  userAgent?: string | null;
  /**
   * Where this came from. Defaults to the public form.
   *
   * The API passes its own value so a lead posted by a website or a Zap is
   * distinguishable in the pipeline from one typed into `/apply` — otherwise
   * every attribution report says `intake_form` and the integration is
   * invisible.
   */
  leadSource?: string;
}

export interface SubmitIntakeResult {
  ok: true;
  dealReference: string;
  emailSent: boolean;
  existingClient: boolean;
  coBorrowerInvited: boolean;
  warnings: string[];
}

const LIABILITY_FIELDS: Array<{ key: string; type: string; description: string }> = [
  { key: 'monthlyCarPayments', type: 'auto', description: 'Car loan or lease' },
  { key: 'monthlyCreditCardPayments', type: 'credit_card', description: 'Credit cards' },
  { key: 'monthlyLoanPayments', type: 'loan', description: 'Student or personal loans' },
  { key: 'monthlyOtherDebt', type: 'other', description: 'Other obligations' },
];

export async function submitIntake(input: SubmitIntakeInput): Promise<SubmitIntakeResult> {
  const answers = pruneToVisible(input.tier, input.answers);
  const warnings: string[] = [];

  const dealType = text(answers, 'dealType') ?? 'purchase';
  const fullName = text(answers, 'fullName') ?? 'Client';
  const email = (text(answers, 'email') ?? '').toLowerCase();

  const brokerName = await asSystem(async (db) => {
    const [broker] = await db
      .select({ fullName: brokers.fullName })
      .from(brokers)
      .where(eq(brokers.isActive, true))
      .limit(1);
    return broker?.fullName ?? 'Your mortgage broker';
  });

  // ── The borrower's profile ────────────────────────────────────────────────
  // Idempotent: an existing client keeps their login and gets a second deal.
  const profile = await createClientProfile(
    {
      email,
      fullName,
      applicationType: dealType,
      phone: text(answers, 'phone') ?? undefined,
      notes: text(answers, 'notes') ?? undefined,
      source: 'inbound_email',
    },
    brokerName,
  );

  warnings.push(...profile.warnings.filter((w) => !w.includes('already exists')));

  // ── The deal ──────────────────────────────────────────────────────────────
  const created = await asSystem(async (db) => {
    const [deal] = await db
      .insert(deals)
      .values({
        clientId: profile.clientId,
        reference: sql`next_deal_reference()`,
        dealType,
        stageKey: 'inquiry',
        propertyAddress: text(answers, 'propertyAddress'),
        propertyCity: text(answers, 'propertyCity'),
        propertyProvince: text(answers, 'propertyProvince'),
        propertyType: text(answers, 'propertyType'),
        occupancy: text(answers, 'occupancy'),
        purchasePrice: numeric(money(answers, 'purchasePrice')),
        propertyValue: numeric(money(answers, 'propertyValue') ?? money(answers, 'purchasePrice')),
        downPayment: numeric(money(answers, 'downPayment')),
        mortgageAmount: numeric(requestedMortgage(answers)),
        annualPropertyTax: numeric(money(answers, 'annualPropertyTax')),
        monthlyCondoFees: numeric(money(answers, 'monthlyCondoFees')),
        existingBalance: numeric(money(answers, 'existingBalance')),
        existingLender: text(answers, 'existingLender'),
        maturityDate: text(answers, 'maturityDate'),
        referralCode: input.referralCode ?? null,
        leadSource: input.leadSource ?? 'intake_form',
        notes: text(answers, 'notes'),
      })
      .returning({ id: deals.id, reference: deals.reference });

    if (!deal) throw new Error('Deal insert returned no row.');

    await db.insert(dealBorrowers).values({
      dealId: deal.id,
      clientId: profile.clientId,
      role: 'primary',
      acceptedAt: new Date(),
    });

    const annualIncome = money(answers, 'annualIncome');
    if (annualIncome !== null) {
      await db.insert(borrowerIncomes).values({
        dealId: deal.id,
        clientId: profile.clientId,
        employmentType: text(answers, 'employmentType') ?? 'salaried',
        employerName: text(answers, 'employerName') ?? text(answers, 'businessName'),
        yearsAtJob: numeric(money(answers, 'yearsAtJob')),
        annualIncome: String(annualIncome),
        priorYearIncome: numeric(money(answers, 'priorYearIncome')),
        isPrimary: true,
      });
    }

    for (const liability of LIABILITY_FIELDS) {
      const monthly = money(answers, liability.key);
      if (monthly === null || monthly <= 0) continue;

      await db.insert(borrowerLiabilities).values({
        dealId: deal.id,
        clientId: profile.clientId,
        liabilityType: liability.type,
        description: liability.description,
        monthlyPayment: String(monthly),
        source: 'client',
      });
    }

    await db.insert(applications).values({
      dealId: deal.id,
      clientId: profile.clientId,
      tier: input.tier,
      locale: input.locale,
      status: 'submitted',
      answers,
      referralCode: input.referralCode ?? null,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      submittedAt: new Date(),
    });

    // `createClientProfile` seeds the opening stage-history row and queues the
    // checklist skill before this deal exists — it predates deals and knows
    // nothing about them. Adopt those rows now, or the deal's timeline starts
    // at nothing and the agent panel shows no run for a file that has one.
    await db
      .update(clientStageHistory)
      .set({ dealId: deal.id })
      .where(
        and(eq(clientStageHistory.clientId, profile.clientId), isNull(clientStageHistory.dealId)),
      );

    await db
      .update(agentRuns)
      .set({ dealId: deal.id })
      .where(and(eq(agentRuns.clientId, profile.clientId), isNull(agentRuns.dealId)));

    if (input.referralCode) {
      await db
        .update(referralSources)
        .set({ visits: sql`${referralSources.visits} + 1` })
        .where(eq(referralSources.code, input.referralCode));
    }

    await recordAudit(db, {
      actorType: 'system',
      action: 'application.submitted',
      targetType: 'deal',
      targetId: deal.id,
      clientId: profile.clientId,
      metadata: { tier: input.tier, locale: input.locale, dealType, reference: deal.reference },
    });

    return deal;
  });

  // ── The co-borrower ───────────────────────────────────────────────────────
  // Their own profile and their own login. Co-borrowers sharing one set of
  // credentials is the single most common way a portal leaks one person's
  // financial data to another.
  let coBorrowerInvited = false;
  const coBorrowerEmail = (text(answers, 'coBorrowerEmail') ?? '').toLowerCase();

  if (coBorrowerEmail && coBorrowerEmail !== email) {
    try {
      const coBorrower = await createClientProfile(
        {
          email: coBorrowerEmail,
          fullName: text(answers, 'coBorrowerName') ?? 'Co-borrower',
          applicationType: dealType,
          source: 'inbound_email',
        },
        brokerName,
      );

      await asSystem(async (db) => {
        await db
          .insert(dealBorrowers)
          .values({
            dealId: created.id,
            clientId: coBorrower.clientId,
            role: text(answers, 'coBorrowerRelationship') === 'spouse' ? 'spouse' : 'co_borrower',
          })
          .onConflictDoNothing();
      });

      coBorrowerInvited = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[intake] co-borrower invite failed', { dealId: created.id, message });
      warnings.push('We could not send an invitation to your co-borrower. Your broker will follow up.');
    }
  }

  return {
    ok: true,
    dealReference: created.reference,
    emailSent: profile.emailSent,
    existingClient: !profile.created,
    coBorrowerInvited,
    warnings,
  };
}
