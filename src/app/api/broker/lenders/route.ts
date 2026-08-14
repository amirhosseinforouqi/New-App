/**
 * Maintaining the brokerage's lender and product table.
 *
 * This is the data the matching engine runs on. Every field except the rate is
 * a QUALIFICATION RULE, and each is optional — a blank means "no constraint",
 * not zero. That distinction is load-bearing: a minimum credit score left blank
 * must not exclude every borrower, and the form says so beside the field rather
 * than leaving someone to discover it when their whole pipeline stops matching.
 */

import { NextResponse } from 'next/server';
import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { asBroker, asSystem } from '@/db';
import { brokers, lenderProducts, lenders } from '@/db/schema';
import { recordAudit } from '@/lib/audit';
import { getCurrentUser } from '@/lib/auth/session';

/** Empty string means "no constraint" and must become null, never 0. */
const optionalNumber = z
  .union([z.number(), z.string(), z.null()])
  .optional()
  .transform((value) => {
    if (value === null || value === undefined || value === '') return null;
    const parsed = typeof value === 'number' ? value : Number(String(value).replace(/[^0-9.]/g, ''));
    return Number.isFinite(parsed) ? parsed : null;
  });

const bodySchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('create_lender'),
    name: z.string().trim().min(1).max(120),
    lenderType: z.enum(['a_lender', 'b_lender', 'monoline', 'credit_union', 'private']),
    submissionEmail: z.string().email().optional().or(z.literal('')),
  }),
  z.object({
    action: z.literal('create_product'),
    lenderId: z.string().uuid(),
    name: z.string().trim().min(1).max(120),
    rateType: z.enum(['fixed', 'variable']),
    termYears: z.number().min(0.5).max(10),
    postedRate: z.number().min(0).max(25),
    minCreditScore: optionalNumber,
    maxLtv: optionalNumber,
    maxGds: optionalNumber,
    maxTds: optionalNumber,
    maxAmortization: optionalNumber,
    minLoanAmount: optionalNumber,
    maxLoanAmount: optionalNumber,
    allowsInsured: z.boolean().default(true),
    allowsUninsured: z.boolean().default(true),
    allowsRental: z.boolean().default(true),
    allowsSelfEmployed: z.boolean().default(true),
    notes: z.string().trim().max(500).optional(),
  }),
  z.object({
    action: z.literal('set_product_active'),
    productId: z.string().uuid(),
    isActive: z.boolean(),
  }),
  z.object({
    action: z.literal('update_rate'),
    productId: z.string().uuid(),
    postedRate: z.number().min(0).max(25),
  }),
]);

/**
 * Two distinct refusals, kept distinct.
 *
 * An agent needs to know the restriction is by role so they can ask an owner.
 * A borrower should not be told that a lender table exists or who administers
 * it — to them this endpoint simply is not theirs.
 */
async function requireOwner(): Promise<
  { ok: true; user: NonNullable<Awaited<ReturnType<typeof getCurrentUser>>> } | { ok: false; error: string }
> {
  const user = await getCurrentUser();
  if (!user || user.kind !== 'broker') return { ok: false, error: 'Not authorised.' };

  const [row] = await asSystem(async (db) =>
    db.select({ role: brokers.role }).from(brokers).where(eq(brokers.id, user.id)).limit(1),
  );

  // Compliance managers can see everything but do not set commercial terms.
  if (row?.role !== 'owner') {
    return { ok: false, error: 'Only the brokerage owner can change the lender table.' };
  }

  return { ok: true, user };
}

export async function POST(request: Request) {
  const auth = await requireOwner();
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: 403 });
  }

  const { user } = auth;

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid request.' },
      { status: 400 },
    );
  }

  const body = parsed.data;

  return asBroker(user.id, async (db) => {
    switch (body.action) {
      case 'create_lender': {
        const [row] = await db
          .insert(lenders)
          .values({
            name: body.name,
            lenderType: body.lenderType,
            submissionEmail: body.submissionEmail || null,
          })
          .onConflictDoNothing()
          .returning({ id: lenders.id });

        if (!row) {
          return NextResponse.json({ error: 'That lender already exists.' }, { status: 409 });
        }

        return NextResponse.json({ ok: true, id: row.id });
      }

      case 'create_product': {
        const [row] = await db
          .insert(lenderProducts)
          .values({
            lenderId: body.lenderId,
            name: body.name,
            rateType: body.rateType,
            termYears: String(body.termYears),
            postedRate: String(body.postedRate),
            minCreditScore: body.minCreditScore,
            maxLtv: body.maxLtv != null ? String(body.maxLtv) : null,
            maxGds: body.maxGds != null ? String(body.maxGds) : null,
            maxTds: body.maxTds != null ? String(body.maxTds) : null,
            maxAmortization: body.maxAmortization,
            minLoanAmount: body.minLoanAmount != null ? String(body.minLoanAmount) : null,
            maxLoanAmount: body.maxLoanAmount != null ? String(body.maxLoanAmount) : null,
            allowsInsured: body.allowsInsured,
            allowsUninsured: body.allowsUninsured,
            allowsRental: body.allowsRental,
            allowsSelfEmployed: body.allowsSelfEmployed,
            notes: body.notes ?? null,
          })
          .returning({ id: lenderProducts.id });

        await recordAudit(db, {
          actorType: 'broker',
          actorId: user.id,
          action: 'lender_product.changed',
          targetType: 'lender_product',
          targetId: row?.id ?? null,
          metadata: { created: body.name, rate: body.postedRate },
        });

        return NextResponse.json({ ok: true, id: row?.id });
      }

      case 'set_product_active': {
        await db
          .update(lenderProducts)
          .set({ isActive: body.isActive, updatedAt: new Date() })
          .where(eq(lenderProducts.id, body.productId));

        return NextResponse.json({ ok: true });
      }

      case 'update_rate': {
        // Rates move weekly, so this is the field that gets edited most. It is
        // its own action rather than a full product update so a rate change
        // cannot accidentally blank a qualification rule.
        await db
          .update(lenderProducts)
          .set({ postedRate: String(body.postedRate), updatedAt: new Date() })
          .where(eq(lenderProducts.id, body.productId));

        await recordAudit(db, {
          actorType: 'broker',
          actorId: user.id,
          action: 'lender_product.changed',
          targetType: 'lender_product',
          targetId: body.productId,
          metadata: { rate: body.postedRate },
        });

        return NextResponse.json({ ok: true });
      }
    }
  });
}
