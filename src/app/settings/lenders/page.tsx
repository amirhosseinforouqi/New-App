import Link from 'next/link';
import { redirect } from 'next/navigation';
import { asc, eq, sql } from 'drizzle-orm';

import { asBroker, asSystem } from '@/db';
import { brokers, lenderProducts, lenders } from '@/db/schema';
import { AppHeader } from '@/components/app-header';
import { BrokerNav } from '@/components/broker-nav';
import { getCurrentUser } from '@/lib/auth/session';
import { env } from '@/lib/env';
import { LenderPanel } from './lender-panel';

export const dynamic = 'force-dynamic';

export default async function LendersPage() {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (user.kind !== 'broker') redirect('/dashboard');

  const [role] = await asSystem(async (db) =>
    db.select({ role: brokers.role }).from(brokers).where(eq(brokers.id, user.id)).limit(1),
  );

  const data = await asBroker(user.id, async (db) => {
    const lenderRows = await db
      .select({
        id: lenders.id,
        name: lenders.name,
        lenderType: lenders.lenderType,
        productCount: sql<number>`(
          SELECT count(*)::int FROM ${lenderProducts} p WHERE p.lender_id = lenders.id
        )`,
      })
      .from(lenders)
      .where(eq(lenders.isActive, true))
      .orderBy(asc(lenders.name));

    const productRows = await db
      .select({
        id: lenderProducts.id,
        lenderId: lenderProducts.lenderId,
        lenderName: lenders.name,
        name: lenderProducts.name,
        rateType: lenderProducts.rateType,
        termYears: lenderProducts.termYears,
        postedRate: lenderProducts.postedRate,
        minCreditScore: lenderProducts.minCreditScore,
        maxLtv: lenderProducts.maxLtv,
        maxAmortization: lenderProducts.maxAmortization,
        allowsInsured: lenderProducts.allowsInsured,
        allowsUninsured: lenderProducts.allowsUninsured,
        allowsSelfEmployed: lenderProducts.allowsSelfEmployed,
        isActive: lenderProducts.isActive,
      })
      .from(lenderProducts)
      .innerJoin(lenders, eq(lenders.id, lenderProducts.lenderId))
      .orderBy(asc(lenders.name), asc(lenderProducts.name));

    return { lenderRows, productRows };
  });

  return (
    <div className="min-h-dvh">
      <AppHeader
        appName={env.appName}
        userName={user.fullName}
        subtitle="Broker workspace"
        nav={<BrokerNav />}
      />

      <main className="mx-auto max-w-4xl px-4 py-6 sm:px-6 sm:py-8">
        <Link
          href="/broker/deals"
          className="text-[13px] text-[var(--color-ink-500)] hover:text-[var(--color-ink-900)]"
        >
          ← Back
        </Link>

        <h1 className="mt-3 mb-1 text-[22px] font-semibold tracking-[-0.01em]">Lenders</h1>
        <p className="mb-6 text-sm text-[var(--color-ink-500)]">
          The products every deal is matched against, and the rules that decide whether a file
          fits.
        </p>

        {role?.role !== 'owner' ? (
          <div className="card p-5">
            <div className="alert alert-warn">
              Only the brokerage owner can change the lender table. These are commercial terms.
            </div>
          </div>
        ) : (
          <>
            <LenderPanel
              lenders={data.lenderRows}
              products={data.productRows.map((product) => ({
                ...product,
                termYears: Number(product.termYears),
                postedRate: Number(product.postedRate),
                maxLtv: product.maxLtv === null ? null : Number(product.maxLtv),
              }))}
            />

            <section className="card mt-5 p-5">
              <h2 className="text-sm font-semibold">Why this is your own table</h2>
              <p className="mt-2 text-[13px] leading-relaxed text-[var(--color-ink-500)]">
                Products like Lender Spotlight sell a maintained database of several thousand
                Canadian lender policies. That is a paid data subscription and a commercial
                relationship — it cannot be conjured, and pretending to have it would put wrong
                numbers in front of borrowers.
              </p>
              <p className="mt-2 text-[13px] leading-relaxed text-[var(--color-ink-500)]">
                What is built is the engine: the matching rules, the comparison over the term
                rather than the headline rate, and the reason every product that does not fit was
                rejected. Most brokers work from a few dozen products they know well, which is what
                this table is for. If you subscribe to a feed later, it imports into these same
                rows and nothing downstream changes.
              </p>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
