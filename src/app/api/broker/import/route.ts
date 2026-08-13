/**
 * Importing a CSV of existing deals.
 *
 * Two phases, deliberately. `preview` parses and reports without writing
 * anything; `commit` writes. Importing 800 files from another system is not
 * something anyone should do blind, and an import that half-succeeds is far
 * worse to unpick than one that was inspected first.
 *
 * Commit reuses `createClientProfile`, so an imported client gets the same
 * Drive folder and the same generated checklist as one who applied — but with
 * `sendCredentials: false`, because emailing 800 people a password at 2am
 * because someone ran a migration is a catastrophe, not a feature. The broker
 * reissues credentials per client when they are ready.
 */

import { NextResponse } from 'next/server';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { asBroker, asSystem } from '@/db';
import { borrowerIncomes, brokers, dealBorrowers, deals } from '@/db/schema';
import { recordAudit } from '@/lib/audit';
import { getCurrentUser } from '@/lib/auth/session';
import { parseImport, type ImportRow } from '@/lib/intake/import';
import { createClientProfile } from '@/lib/onboarding';

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_ROWS = 2_000;

const bodySchema = z.object({
  csv: z.string().max(MAX_BYTES),
  commit: z.boolean().default(false),
});

async function requireOwner() {
  const user = await getCurrentUser();
  if (!user || user.kind !== 'broker') return null;

  const [row] = await asSystem(async (db) =>
    db.select({ role: brokers.role }).from(brokers).where(eq(brokers.id, user.id)).limit(1),
  );

  return row?.role === 'owner' ? user : null;
}

export async function POST(request: Request) {
  const user = await requireOwner();
  if (!user) {
    return NextResponse.json(
      { error: 'Only the brokerage owner can import deals.' },
      { status: 403 },
    );
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: 'Could not read that file.' }, { status: 400 });
  }

  const result = parseImport(parsed.data.csv);

  if (result.rows.length > MAX_ROWS) {
    return NextResponse.json(
      { error: `That file has ${result.rows.length} rows. Split it into batches of ${MAX_ROWS}.` },
      { status: 400 },
    );
  }

  if (!parsed.data.commit) {
    return NextResponse.json({
      preview: true,
      willImport: result.rows.length,
      errors: result.errors,
      unmappedColumns: result.unmappedColumns,
      sample: result.rows.slice(0, 5),
    });
  }

  if (result.rows.length === 0) {
    return NextResponse.json({ error: 'Nothing to import — fix the errors first.' }, { status: 400 });
  }

  const imported: string[] = [];
  const failed: Array<{ email: string; error: string }> = [];

  for (const row of result.rows) {
    try {
      await importOne(row, user.id);
      imported.push(row.email);
    } catch (error) {
      failed.push({
        email: row.email,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  await asBroker(user.id, async (db) => {
    await recordAudit(db, {
      actorType: 'broker',
      actorId: user.id,
      action: 'deals.imported',
      metadata: { imported: imported.length, failed: failed.length },
    });
  });

  return NextResponse.json({
    preview: false,
    imported: imported.length,
    failed,
    skipped: result.errors.length,
  });
}

async function importOne(row: ImportRow, brokerId: string): Promise<void> {
  const profile = await createClientProfile(
    {
      email: row.email,
      fullName: row.fullName,
      applicationType: row.dealType ?? 'purchase',
      phone: row.phone,
      notes: row.notes ?? undefined,
      brokerId,
      source: 'broker',
      // No credentials email. See the module comment — a migration must not
      // mail hundreds of people a password unannounced.
      sendCredentials: false,
    },
    '',
  );

  await asBroker(brokerId, async (db) => {
    const [deal] = await db
      .insert(deals)
      .values({
        clientId: profile.clientId,
        reference: sql`next_deal_reference()`,
        dealType: row.dealType ?? 'purchase',
        stageKey: row.stage ?? 'inquiry',
        status: row.stage === 'funded' ? 'funded' : 'active',
        assignedTo: brokerId,
        propertyAddress: row.propertyAddress,
        propertyCity: row.propertyCity,
        propertyProvince: row.propertyProvince,
        purchasePrice: row.purchasePrice != null ? String(row.purchasePrice) : null,
        propertyValue: row.propertyValue != null ? String(row.propertyValue) : null,
        downPayment: row.downPayment != null ? String(row.downPayment) : null,
        mortgageAmount: row.mortgageAmount != null ? String(row.mortgageAmount) : null,
        interestRate: row.interestRate != null ? String(row.interestRate) : null,
        amortizationYears: row.amortizationYears ?? null,
        maturityDate: row.maturityDate,
        existingLender: row.existingLender,
        existingBalance: row.existingBalance != null ? String(row.existingBalance) : null,
        leadSource: 'import',
        notes: row.notes,
      })
      .returning({ id: deals.id });

    if (!deal) throw new Error('Deal insert returned no row.');

    await db
      .insert(dealBorrowers)
      .values({ dealId: deal.id, clientId: profile.clientId, role: 'primary' })
      .onConflictDoNothing();

    if (row.annualIncome != null && row.annualIncome > 0) {
      await db.insert(borrowerIncomes).values({
        dealId: deal.id,
        clientId: profile.clientId,
        employmentType: row.employmentType ?? 'salaried',
        annualIncome: String(row.annualIncome),
      });
    }
  });
}
